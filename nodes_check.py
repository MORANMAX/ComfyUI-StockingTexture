"""End-to-end check of the node contract, without a browser and without a graph.

Run with the ComfyUI env:/n/n    <ComfyUI的python> nodes_check.py [<输入图>]

  1. the finished picture follows the panel's look (doc.look), not the node widgets' leftovers;
  2. 「送入下游」's pinned render is what the node hands on, once, and it is dropped when the document moves;
  3. a fresh document is still seeded from the node's widgets, so a plain graph run textures as its widgets ask.
"""
import importlib
import os
import sys

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
COMFY = os.path.dirname(os.path.dirname(HERE))
if COMFY not in sys.path:
    sys.path.insert(0, COMFY)

PKG = 'custom_nodes.ComfyUI-StockingTexture'
importlib.import_module(PKG)
nodes = importlib.import_module(PKG + '.nodes')
routes = importlib.import_module(PKG + '.routes')
docstore = importlib.import_module(PKG + '.docstore')
look = importlib.import_module(PKG + '.upstream.look')

SRC = sys.argv[1] if len(sys.argv) > 1 else os.path.join(COMFY, 'input', 'test_stock.jpg')
FAILS = []


def check(name, ok, extra=''):
    print(('  OK   ' if ok else '  失败 ') + name + (('  ' + extra) if extra else ''))
    if not ok:
        FAILS.append(name)


def out_rgb(res):
    t = res['result'][0]
    a = t.numpy() if hasattr(t, 'numpy') else np.asarray(t)
    a = a[0] if a.ndim == 4 else a
    return np.clip(np.round(a * 255), 0, 255).astype(np.uint8)


def main():
    bgr = cv2.imread(SRC, cv2.IMREAD_COLOR)
    rgb = np.ascontiguousarray(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB))
    h, w = rgb.shape[:2]
    frame = rgb.astype(np.float32) / 255.0
    node = nodes.StockingTexture()
    print(f'输入 {w}x{h}')

    # --- a run with nobody having touched the panel: the widgets seed the look
    res = node.apply(frame, '细线 knit', 100.0, 100.0, False, False, 'stocking')
    doc = routes._doc_holder.get()
    check('首次运行把 widget 设置播种成文档的 look', bool(doc.look) and doc.look['style'] == 'knit',
          str(doc.look and doc.look['style']))
    check('没有部位时成品 = 原图', res['ui']['stocking'][0]['ready'] is False)

    # --- paint a region + a 走向 line, as the panel would
    with doc.lock:
        r = doc.region(doc.add_region('probe'))
        rr, cc = np.ogrid[:h, :w]
        r.mask[:] = ((rr - h * 0.6) ** 2 / (h * 0.3) ** 2 + (cc - w * 0.5) ** 2 / (w * 0.18) ** 2) < 1
        r.mask_v += 1
        doc._touch()
    doc.add_stroke(np.array([w * 0.4, h * 0.6, w * 0.6, h * 0.6], np.float64), None)
    check('部位求解完成', doc.wait_idle(120))

    # --- the panel sets 油光/140/斜度 10/强度 60; the node widgets still say 细线/100/100
    panel = look.clean_params({'style': 'oily', 'density': 140.0, 'tilt': 10.0, 'strength': 60.0})
    doc.set_look(panel)
    res = node.apply(frame, '细线 knit', 100.0, 100.0, False, False, 'stocking')
    got = out_rgb(res)
    want_oily, _ = docstore.render(doc, None)
    want_knit, _ = docstore.render(doc, {'style': 'knit', 'density': 100.0, 'strength': 100.0})
    check('节点输出用的是面板的样式（油光），不是 widget 的细线', np.array_equal(got, want_oily))
    check('  … 并且确实不是 widget 那张', not np.array_equal(got, want_knit))
    check('report 说的是面板的样式',
          '油光' in res['result'][2] and '140%' in res['result'][2], res['result'][2][:70])

    # --- 送入下游: pin, hand over once, then invalidate
    pinned, info = routes.push_doc(doc)
    check('送入下游渲染出的就是成品', np.array_equal(pinned, want_oily))
    res = node.apply(frame, '细线 knit', 100.0, 100.0, False, False, 'stocking')
    check('下一次执行原样交出这张成品', np.array_equal(out_rgb(res), pinned))
    check('交出一次之后 pin 就没了', routes.take_pushed(doc) is None)

    # --- an edit after the pin must make the next run render fresh, not hand over the stale picture
    routes.push_doc(doc)
    doc.add_stroke(np.array([w * 0.4, h * 0.5, w * 0.6, h * 0.5], np.float64), None)
    doc.wait_idle(120)
    check('文档变了之后 pin 失效', routes.take_pushed(doc) is None)

    # --- and a document with no look at all still renders from the widgets (the 取用节点图片 path)
    fresh = docstore.store.acquire(np.ascontiguousarray(rgb[::-1].copy()))
    check('新文档没有 look', fresh.look is None)
    out, _ = docstore.render(fresh, None)
    check('没有 look 时成品 = 原图（还没画部位）', np.array_equal(out, fresh.art))

    print()
    print('全部通过' if not FAILS else '有失败：' + '、'.join(FAILS))
    return 0 if not FAILS else 1


if __name__ == '__main__':
    raise SystemExit(main())
