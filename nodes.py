"""丝袜纹理 Stocking Texture — a native ComfyUI node that stands in for 保存图像.

Why the node is shaped this way
-------------------------------
The point of it is that it *is* the end of the chain. The sampler's IMAGE arrives on a socket, the textured
IMAGE leaves on a socket, and nothing is exported, re-opened or carried by hand in between. A version of this
that opened a second application and asked you to drag a PNG across was a tool with a node stapled to it; this
is the node.

The editing UI is the desktop tool's own page (see `web/` and `routes.py`), mounted inside the node through
`addDOMWidget`. That is not laziness: the desktop tool's page is ~2700 lines of canvas code that already
works, and the previous attempt here re-implemented a fraction of it and got the brush, the wand, the guides
and the texture itself wrong. The node supplies the two things the page cannot supply for itself — an image
from a socket, and a picture back out on a socket — and leaves the editing to the code that is known good.

    sampler ──IMAGE──► 丝袜纹理 ──IMAGE──► 保存图像 / 预览 / 下一个采样器
                          │
                          └── 节点内：原版界面，接图即自动载入，编辑结果直接就是 socket 上的那张图

Requirement 3 (replace 保存图像) needs OUTPUT_NODE: ComfyUI refuses a prompt whose last node is not an output
("prompt_no_outputs"), and a chain that ends here must run. It is also why the finished frames are written to
output/stocking/ and announced in `ui.images`, exactly as 保存图像 does.

A port of silvermoong/stocking-texture-tool (MIT).
"""
import os
import time

import numpy as np
import torch

from . import docstore, routes
from .upstream import depth, look, sam

STYLES = ['细线 knit', '针织 loops', '线圈 coil', '斜单线 lines', '加濑风 grain', '油光 oily']
STYLE_KEYS = {'细线 knit': 'knit', '针织 loops': 'loops', '线圈 coil': 'coil',
              '斜单线 lines': 'lines', '加濑风 grain': 'grain', '油光 oily': 'oily'}
# The other way round, so the report names the style the panel names it: the render speaks `oily`, the user reads
# 油光, and a report that says "样式 oily" is the one place the node would show the wrong word for it.
STYLE_LABELS = {v: k for k, v in STYLE_KEYS.items()}

# A render reads only the *fresh* solves (document.fields), so a queue that lands while a piece the user just
# drew on is still solving would hand back a picture with no texture on it — which looks exactly like the node
# having done nothing. Wait for it, but not forever: the socket is the promise, so a solve that is stuck must
# still produce a picture.
RENDER_WAIT = 60


def _to_rgb(frame):
    """A ComfyUI IMAGE frame (float 0..1, HxWx3) as uint8 RGB."""
    a = np.asarray(frame)
    if a.dtype != np.uint8:
        a = np.clip(np.round(a.astype(np.float32) * 255.0), 0, 255).astype(np.uint8)
    return np.ascontiguousarray(a[..., :3])


def _report_text(d, info):
    """One line the panel and the String socket both show.

    The order matters: "no regions" and "regions but no 走向 lines" are different problems with different fixes,
    and saying the first when it is the second sends the user to the wrong tool.
    """
    q = info.get('params', {})
    style = q.get('style', '?')
    bits = [f"样式 {STYLE_LABELS.get(style, style)}", f"密度 {q.get('density', 0):.0f}%",
            f"强度 {q.get('strength', 0):.0f}%"]
    if info.get('empty'):
        st = d.state()
        if not st['regions']:
            return '丝袜纹理：还没有部位。在节点里点「自动选择丝袜」或「点选」选一条腿。'
        missing = [r['name'] for r in st['regions'] if r['status'] in ('nostroke', 'error')]
        return ('丝袜纹理：选了 ' + '、'.join(r['name'] for r in st['regions'])
                + '，但还没有走向线，所以没有纹理。在节点界面里用「走向」工具画一道横纹。')
    if info.get('period'):
        bits.append(f"周期 {info['period']}px")
    if info.get('fade'):
        bits.append(f"减弱 {info['fade'] * 100:.0f}%")
    st = d.state()
    missing = [r['name'] for r in st['regions'] if r['status'] in ('nostroke', 'error')]
    if missing:
        bits.append('没有走向线：' + '、'.join(missing))
    if st.get('sam', {}).get('state') == 'error':
        bits.append('点选模型不可用（' + str(st['sam'].get('error'))[:40] + '）')
    return '丝袜纹理：' + ' | '.join(bits)


class StockingTexture:
    """给插画里的丝袜加真实的针织纹理。接在采样器后面，替代「保存图像」。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                # The socket is why this is a node. Everything else on this node is a way to steer what it does.
                "image": ("IMAGE", {"tooltip": "接采样器 / K采样器的图像输出。图片会自动进入节点里的编辑界面"}),
            },
            "optional": {
                "样式_style": (STYLES, {"default": '细线 knit', "tooltip": "纹理的款式；可以在节点界面里随时改"}),
                "密度_density": ("FLOAT", {"default": 100.0, "min": 60.0, "max": 160.0, "step": 1.0,
                                          "tooltip": "横纹疏密。和原版一样，小图上过快会为了防摩尔纹自动减弱"}),
                "强度_strength": ("FLOAT", {"default": 100.0, "min": 0.0, "max": 200.0, "step": 1.0,
                                          "tooltip": "纹理有多明显"}),
                "自动选择_auto": ("BOOLEAN", {"default": False,
                                           "tooltip": "排队时自动用 SAM 找出丝袜并画一条走向线，直接出纹理。"
                                                      "界面里点「自动选择丝袜」只找部位、不画走向线，留给手动精修"}),
                "保存到output_save": ("BOOLEAN", {"default": True,
                                                "tooltip": "和「保存图像」一样，把成品写进 output/stocking/"}),
                "文件名前缀": ("STRING", {"default": "stocking", "multiline": False}),
            },
        }

    RETURN_TYPES = ("IMAGE", "MASK", "STRING")
    RETURN_NAMES = ("image", "mask", "report")
    FUNCTION = "apply"
    CATEGORY = "image/丝袜纹理"
    OUTPUT_NODE = True
    DESCRIPTION = ("给插画里的丝袜加真实针织纹理，接在采样器后面替代「保存图像」："
                   "采样器直接接进来，加过纹理的图直接接出去。节点内是原版编辑界面（点选/画笔/橡皮/切开、"
                   "走向线/隔开线/镜像、6 种样式、密度/斜度/强度、亮点、预设、撤销重做），"
                   "图片自动载入，编辑结果就是 socket 上输出的那张图。")

    def apply(self, image, 样式_style='细线 knit', 密度_density=100.0, 强度_strength=100.0,
              自动选择_auto=False, 保存到output_save=True, 文件名前缀='stocking'):
        arr = np.asarray(image)
        frames = [arr[i] for i in range(arr.shape[0])] if arr.ndim == 4 else [arr]

        outs, reports, masks = [], [], []
        doc = None
        for i, frame in enumerate(frames):
            rgb = _to_rgb(frame)
            # Requirement: the picture on the socket becomes the picture the panel edits, with no manual load.
            doc = routes.adopt(rgb)
            if bool(自动选择_auto):
                self._auto(doc)
            # The look belongs to the document, not to this node: the panel's 样式 / 密度 / 斜度 / 亮点 controls
            # write it there on every move, and the node's three widgets are mirrored onto the same setting (the
            # panel is the only place the other four can be reached). A document that has never been looked at —
            # a first run with nobody having touched the panel — is seeded from the widgets here, so a plain
            # graph still produces the texture its widgets ask for.
            if not doc.look:
                doc.set_look(look.clean_params({'style': STYLE_KEYS.get(样式_style, 'knit'),
                                                'density': float(密度_density),
                                                'strength': float(强度_strength)}))
            # The panel and the 成品 strip show this render too, and neither of them can show texture that the
            # solve has not produced yet. See RENDER_WAIT.
            if not doc.wait_idle(RENDER_WAIT):
                print('[stocking] 部位还在求解，先按当前结果出图', flush=True)
            # 「送入下游」 pinned a render of exactly this document; hand that over rather than drawing it again,
            # so the next node gets the bytes the user approved (see routes.push_doc).
            hit = routes.take_pushed(doc)
            if hit is not None:
                out = hit
                # `empty` is the same question docstore.render answers: no region, so the pin is the plain picture.
                info = {'params': dict(doc.look or {}), 'pushed': True,
                        'empty': not bool((doc.region_map() > 0).any())}
            else:
                out, info = docstore.render(doc, None)
            outs.append(out.astype(np.float32) / 255.0)
            reports.append(_report_text(doc, info))
            m = doc.region_map()
            masks.append((m > 0).astype(np.float32))

        # ComfyUI's IMAGE and MASK are torch tensors: every downstream node (PreviewImage, SaveImage, a second
        # sampler) calls .cpu() on them, and a bare ndarray works only while nothing follows.
        img_t = torch.from_numpy(np.stack(outs, 0) if len(outs) > 1 else outs[0][None])
        mask_t = torch.from_numpy(np.stack(masks, 0) if len(masks) > 1 else masks[0][None])
        report = '\n'.join(reports) if len(reports) > 1 else reports[0]

        images = []
        if bool(保存到output_save):
            images = self._write(outs, 文件名前缀)

        sid = doc.id if doc is not None else ''
        ui = {"text": [report], "stocking": [{"sid": sid, "ready": bool(doc and (doc.region_map() > 0).any()),
                                             "width": doc.w if doc else 0, "height": doc.h if doc else 0}]}
        if images:
            ui["images"] = images
        return {"ui": ui, "result": (img_t, mask_t, report)}

    # ------------------------------------------------------------------ auto pass

    @staticmethod
    def _auto(doc, draw_guides=True):
        """The pre-processing pass: SAM + depth decide where the stockings are.

        It runs as two steps that can be told apart, because they answer different questions:

          * regions first — "which pixels are stockings". This is the part the panel's 「自动选择丝袜」 button
            asks for, and it is deliberately all it asks for: guides are the user's layer, and an automatic pass
            that also drew them would be answering a question nobody asked.
          * guides after — one 走向 line down the middle of each region, so the region can actually produce a
            texture. A node run has nobody to draw them; a region without a guide renders as the plain picture,
            which looks like the node did nothing. Turning the 自动选择 toggle on is the user saying "just give me
            a textured picture", so in that case the guides are seeded too — and the panel's button, which calls
            regions only, still leaves them to them.

        Either way the result is ordinary regions and ordinary strokes: 点选/画笔/橡皮 and the 走向 tool fix up
        whatever the pass got wrong.
        """
        try:
            from . import auto
            if doc._disparity is None:
                try:
                    depth.service.disparity(doc, timeout=120)
                except Exception as e:
                    print(f'[stocking] 深度模型不可用（自动选择继续）：{e}', flush=True)
            sam.service.wait_ready(120)
            parts, _ = auto.sam_auto(doc, getattr(doc, 'disparity', None))
            if not parts:
                print('[stocking] 自动选择没有找到丝袜；请在节点里手动点选或涂', flush=True)
                return
            made = []
            with doc.lock:
                for k, m in enumerate(parts):
                    if k < len(doc.regions):
                        r = doc.regions[k]
                    else:
                        r = doc.region(doc.add_region(f'部位 {len(doc.regions) + 1}'))
                    r.mask[:] = np.asarray(m, bool)
                    r.mask_v += 1
                    made.append(r.id)
                doc._touch()
            if draw_guides:
                for rid in made:
                    StockingTexture._seed_stroke(doc, rid)
                # The strokes kick off the solve in a worker thread; the render that follows would otherwise
                # see regions with no texture yet and hand back the plain picture. Wait for them here, where we
                # know exactly what we just asked for, rather than hoping.
                doc.wait_idle(180)
        except Exception as e:
            print(f'[stocking] 自动选择失败：{type(e).__name__}: {e}', flush=True)

    @staticmethod
    def _seed_stroke(doc, rid):
        """One horizontal 走向 line through the middle of a region, as the 走向 tool draws by hand.

        A single course line is all the solver needs to lay the knit down across the whole region; the user can
        then drag its ends or add more in the panel. Skipped if the region already has one, so a second run of the
        same graph does not pile up lines.
        """
        # `doc.state()` and `doc.add_stroke()` take the document lock themselves, and it is a plain
        # threading.Lock, so neither may be called from inside a `with doc.lock:` block.
        st = doc.state()['regions']
        if any(x['id'] == rid and x['strokes'] > 0 for x in st):
            return
        with doc.lock:
            r = doc.region(rid)
            ys, xs = np.nonzero(r.mask)
            if len(ys) < 4:
                return
            # The widest row is the most representative horizontal cut through the region, and it avoids the
            # narrow first/last rows of a tapered leg, where a line would be shorter than the brush.
            counts = np.bincount(ys, minlength=doc.h)
            y = float(np.argmax(counts))
            row = xs[ys == int(y)]
            if row.size < 2:
                return
            x0, x1 = float(row.min()), float(row.max())
            span = x1 - x0
            x0, x1 = x0 + span * 0.15, x1 - span * 0.15
        doc.add_stroke(np.array([x0, y, x1, y], np.float64), None)

    # ------------------------------------------------------------------ output

    @staticmethod
    def _write(outs, prefix):
        """Same contract as 保存图像: write each frame into ComfyUI's output tree and describe it for ui.images.

        A disk failure is reported, not raised: the socket is the promise, and a node that refuses to return a
        picture because a write failed would be worse than one that returns it and says so.
        """
        try:
            import folder_paths
            from PIL import Image
            sub = 'stocking'
            d = os.path.join(folder_paths.get_output_directory(), sub)
            os.makedirs(d, exist_ok=True)
            stamp = time.strftime('%Y%m%d-%H%M%S')
            base = (prefix or 'stocking').strip() or 'stocking'
            base = ''.join(ch for ch in base if ch not in '\\/:*?"<>|')
            out = []
            for i, frame in enumerate(outs):
                name = f'{base}_{stamp}_{i:02d}.png'
                a = np.clip(np.round(frame * 255.0), 0, 255).astype(np.uint8)
                Image.fromarray(a).save(os.path.join(d, name))
                out.append({'filename': name, 'subfolder': sub, 'type': 'output'})
            return out
        except Exception as e:
            print(f'[stocking] 成品写盘失败：{type(e).__name__}: {e}', flush=True)
            return []

    @classmethod
    def IS_CHANGED(cls, **kw):
        # The result depends on edits made in the panel, which the graph cannot see, so it must always re-run.
        return float('nan')

    @classmethod
    def VALIDATE_INPUTS(cls, **kw):
        return True


def _resolve_sam_models():
    """Kick the model loaders off at import, so the first click does not pay for loading torch and SAM.

    The two loaders are started together on purpose now: they serialise among themselves (see
    `upstream/sam.SamService._load` and `upstream/depth.DepthService._load`, which both take the shared
    `upstream._loads.LOCK` around building their model). Loading them in parallel used to leave SAM's weights
    in half precision, and the first 点选 would die with
    "Input type (struct c10::Half) and bias type (float) should be the same" — on every run.
    """
    try:
        sam.service.start()
        depth.service.start()
    except Exception as e:
        print(f'[stocking] 模型预加载未启动：{type(e).__name__}: {e}', flush=True)


NODE_CLASS_MAPPINGS = {'StockingTexture': StockingTexture}
NODE_DISPLAY_NAME_MAPPINGS = {'StockingTexture': '丝袜纹理 Stocking Texture'}
