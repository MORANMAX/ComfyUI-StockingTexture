"""End-to-end check of the node, without a browser and without a graph.

What it proves
--------------
The whole chain the node depends on, in the order the node uses it:

    IMAGE tensor -> Document -> paint a region (as the panel would) -> strokes -> render -> IMAGE tensor

and that the result is a *textured* image rather than the input returned unchanged. That last part is the one the
previous attempt got wrong: its pipeline produced a coarse weave because it did not use the desktop tool's own
solve. Here the render is the desktop tool's own `look.Scene.render`, so if this passes the node's picture is the
desktop tool's picture.

Run with the ComfyUI env:

    G:/Comfy-Desktop/ComfyUI-Installs/ComfyUI/standalone-env/python.exe e2e_check.py <input.png>
"""
import os
import sys
import time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
# HERE = <ComfyUI>/custom_nodes/ComfyUI-StockingTexture, so the ComfyUI root (the parent of custom_nodes) is two up.
COMFY = os.path.dirname(os.path.dirname(HERE))
if COMFY not in sys.path:
    sys.path.insert(0, COMFY)

import importlib
PKG_NAME = 'custom_nodes.ComfyUI-StockingTexture'
PKG = importlib.import_module(PKG_NAME)
docstore = importlib.import_module(PKG_NAME + '.docstore')
routes = importlib.import_module(PKG_NAME + '.routes')
auto = importlib.import_module(PKG_NAME + '.auto')
look = importlib.import_module(PKG_NAME + '.upstream.look')


def load_rgb(path):
    import cv2
    bgr = cv2.imread(path, cv2.IMREAD_COLOR)
    if bgr is None:
        raise SystemExit(f'读不了 {path}')
    return np.ascontiguousarray(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB))


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else None
    if not src or not os.path.exists(src):
        raise SystemExit('用法: e2e_check.py <input.png>')

    rgb = load_rgb(src)
    print(f'输入 {rgb.shape[1]}x{rgb.shape[0]}')

    t = time.perf_counter()
    doc = routes.adopt(rgb)
    print(f'adopt: {time.perf_counter() - t:.2f}s  doc.id={doc.id}')

    # --- 1. auto pass (the 「自动选择丝袜」 button's path)
    t = time.perf_counter()
    try:
        depth = importlib.import_module(PKG_NAME + '.upstream.depth')
        sam = importlib.import_module(PKG_NAME + '.upstream.sam')
        if getattr(doc, 'disparity', None) is None:
            depth.service.disparity(doc, timeout=180)
        sam.service.wait_ready(180)
        parts, _ = auto.sam_auto(doc, getattr(doc, 'disparity', None))
    except Exception as e:
        print(f'  自动选择不可用（{type(e).__name__}: {e}）；改用手动画一个部位')
        parts = None
    print(f'auto: {time.perf_counter() - t:.2f}s  找到 {len(parts) if parts else 0} 块')

    # --- 2. region: whatever auto found, else the middle of the picture
    with doc.lock:
        if parts:
            for k, m in enumerate(parts[:2]):
                r = doc.regions[k] if k < len(doc.regions) else doc.region(doc.add_region(f'部位 {k + 1}'))
                r.mask[:] = np.asarray(m, bool)
                r.mask_v += 1
        else:
            r = doc.region(doc.add_region('测试部位'))
            h, w = rgb.shape[:2]
            rr, cc = np.ogrid[:h, :w]
            r.mask[:] = ((rr - h * 0.6) ** 2 / (h * 0.3) ** 2 + (cc - w * 0.5) ** 2 / (w * 0.18) ** 2) < 1
            r.mask_v += 1
        doc._touch()
    ids = [r.id for r in doc.regions]
    print(f'部位: {[(r.id, r.name, int(r.mask.sum())) for r in doc.regions]}')

    # --- 3. strokes: a horizontal 走向 line per region, as the 走向 tool would draw
    for rid in ids:
        r = doc.region(rid)
        ys, xs = np.nonzero(r.mask)
        if not len(ys):
            continue
        cx = float(xs.mean())
        y0, y1 = float(ys.min()), float(ys.max())
        rows = [y0 + (y1 - y0) * f for f in (0.35, 0.5, 0.65)]
        flat = np.array([[cx - 30, yy] for yy in rows] + [[cx + 30, yy] for yy in rows], np.float64).ravel()
        sid = doc.add_stroke(flat, None)
        print(f'  部位 {rid} 走向线 sid={sid}')

    ok = doc.wait_idle(120)
    print(f'求解完成: {ok}')
    for s in doc.state()['regions']:
        print(f"  {s['name']}: {s['status']} strokes={s['strokes']} {s['seconds']}s err={s['error']}")

    # --- 4. render through the node's own entry point
    t = time.perf_counter()
    out, info = docstore.render(doc, {'style': 'knit', 'density': 100.0, 'strength': 100.0})
    print(f'render: {time.perf_counter() - t:.2f}s  {out.shape}')
    print(f'  info keys: {sorted(info)}')

    # --- 5. did it actually change the picture?
    diff = np.abs(out.astype(np.int16) - rgb.astype(np.int16))
    changed = float((diff.max(axis=2) > 6).mean())
    print(f'与输入不同的像素: {changed * 100:.1f}%')
    if info.get('empty'):
        print('!! 渲染认为是空的：部位没有纹理')
        return 1
    if changed < 0.005:
        print('!! 几乎没有变化：纹理没生成')
        return 1

    dst = os.path.join(HERE, 'e2e_out.png')
    import cv2
    cv2.imwrite(dst, cv2.cvtColor(out, cv2.COLOR_RGB2BGR))
    print(f'写出 {dst}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
