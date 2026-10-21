"""Drive the node's HTTP endpoints for real: aiohttp router + the module's own handlers, no ComfyUI.

Run with the ComfyUI env:/n/n    <ComfyUI的python> routes_check.py [<输入图>]

Stubs `server.PromptServer.instance.routes` with a plain aiohttp RouteTableDef, calls routes.register(), then
talks to /push, /result, /export and PATCH /look over a real socket. This is what catches a handler that compiles
but answers 500 — a body that is parsed wrong, a decorator that did not register, a render on the event loop.
"""
import asyncio
import importlib
import os
import sys
import tempfile
import types

import cv2
import numpy as np
from aiohttp import web

HERE = os.path.dirname(os.path.abspath(__file__))
COMFY = os.path.dirname(os.path.dirname(HERE))
if COMFY not in sys.path:
    sys.path.insert(0, COMFY)

TABLE = web.RouteTableDef()
fake = types.ModuleType('server')
fake.PromptServer = type('PromptServer', (), {'instance': type('Inst', (), {'routes': TABLE})()})
sys.modules['server'] = fake
# A throwaway output tree, so 「保存到 output」 is checked by looking at a real file rather than by trusting the
# handler's own report — and so the node's folder does not collect test PNGs.
OUT = os.path.join(tempfile.mkdtemp(prefix='stocking-out-'), 'output')
sys.modules.setdefault('folder_paths', types.SimpleNamespace(get_output_directory=lambda: OUT))

PKG = 'custom_nodes.ComfyUI-StockingTexture'
importlib.import_module(PKG)
routes = importlib.import_module(PKG + '.routes')
look = importlib.import_module(PKG + '.upstream.look')

SRC = sys.argv[1] if len(sys.argv) > 1 else os.path.join(COMFY, 'input', 'test_stock.jpg')
FAILS = []


def check(name, ok, extra=''):
    print(('  OK   ' if ok else '  失败 ') + name + (('  ' + extra) if extra else ''))
    if not ok:
        FAILS.append(name)


async def main():
    routes.register()
    registered = sorted({f'{r.method} {r.path}' for r in TABLE})
    print('路由:', *registered, sep='\n  ')
    check('PATCH /look 已注册', any(r.startswith('PATCH') and '/look' in r for r in registered))
    check('POST /push 已注册', any(r.startswith('POST') and r.endswith('/push') for r in registered))
    check('POST /export 已注册', any(r.startswith('POST') and r.endswith('/export') for r in registered))

    bgr = cv2.imread(SRC, cv2.IMREAD_COLOR)
    rgb = np.ascontiguousarray(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB))
    doc = routes.adopt(rgb)
    d = doc.id
    h, w = rgb.shape[:2]
    with doc.lock:
        r = doc.region(doc.add_region('probe'))
        rr, cc = np.ogrid[:h, :w]
        r.mask[:] = ((rr - h * 0.6) ** 2 / (h * 0.3) ** 2 + (cc - w * 0.5) ** 2 / (w * 0.18) ** 2) < 1
        r.mask_v += 1
        doc._touch()
    doc.add_stroke(np.array([w * 0.4, h * 0.6, w * 0.6, h * 0.6], np.float64), None)
    doc.set_look(look.clean_params({'style': 'knit', 'density': 100.0, 'tilt': 32.0, 'strength': 100.0}))
    print('求解:', doc.wait_idle(120))

    app = web.Application()
    app.add_routes(TABLE)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, '127.0.0.1', 0)
    await site.start()
    port = runner.addresses[0][1]
    base = f'http://127.0.0.1:{port}'

    import aiohttp
    async with aiohttp.ClientSession() as s:
        # 1. the widgets' route: change two settings, keep the rest
        async with s.patch(f'{base}/stocking/api/doc/{d}/look',
                           json={'style': 'oily', 'density': 140, 'strength': 60, 'strength_auto': False}) as r0:
            j = await r0.json()
            check('PATCH /look 200', r0.status == 200, str(j)[:120])
            p = (j or {}).get('params') or {}
            check('样式改成了 oily', p.get('style') == 'oily')
            check('密度/强度 跟着变', p.get('density') == 140.0 and p.get('strength') == 60.0)
            check('斜度没被清成默认值以外的值', p.get('tilt') == 32.0)

        # 2. 送入下游
        async with s.post(f'{base}/stocking/api/doc/{d}/push') as r1:
            j1 = await r1.json()
            check('POST /push 200', r1.status == 200, str(j1)[:160])
            check('  … 报的是面板的样式', (j1 or {}).get('style') == 'oily')
            check('  … 尺寸是原图尺寸', (j1 or {}).get('width') == w and (j1 or {}).get('height') == h)

        # 3. the 成品 pane's route follows the document, with no parameters at all
        async with s.get(f'{base}/stocking/api/doc/{d}/result?w=256') as r2:
            body = await r2.read()
            check('GET /result 200', r2.status == 200)
            check('  … 是一张 PNG', body[:8] == b'\x89PNG\r\n\x1a\n')
            img = cv2.imdecode(np.frombuffer(body, np.uint8), cv2.IMREAD_COLOR)
            check('  … 缩略图宽 256', img is not None and img.shape[1] == 256, str(None if img is None else img.shape))

        # 4. 「保存到 output」— what the 成品 pane's button calls now. The point of checking it here is that the
        #    button must be honest: a file on disk, at the size of the picture, written without queueing the graph.
        async with s.patch(f'{base}/stocking/api/doc/{d}/look', json={'style': 'knit'}) as r3:
            j3 = await r3.json()
            check('PATCH 回 knit', r3.status == 200 and ((j3 or {}).get('params') or {}).get('style') == 'knit')

        async with s.post(f'{base}/stocking/api/doc/{d}/export',
                          json={'kind': 'png', 'name': 'probe'}) as r4:
            j4 = await r4.json()
            check('POST /export 200', r4.status == 200, str(j4)[:160])
            f = str((j4 or {}).get('file') or '')
            where = f.replace('\\', '/')
            check('  … 落在 output/stocking/', '/output/stocking/' in where, where)
            check('  … 文件真的在盘上', bool(f) and os.path.isfile(f), f)
            got = cv2.imread(f, cv2.IMREAD_COLOR) if f and os.path.isfile(f) else None
            check('  … 是原图尺寸', got is not None and got.shape[:2] == (h, w),
                  str(None if got is None else got.shape))
            check('  … 名字用了传进去的前缀', os.path.basename(f) == 'probe.png', os.path.basename(f))

    await runner.cleanup()
    print()
    print('全部通过' if not FAILS else '有失败：' + '、'.join(FAILS))
    return 0 if not FAILS else 1


if __name__ == '__main__':
    raise SystemExit(asyncio.run(main()))
