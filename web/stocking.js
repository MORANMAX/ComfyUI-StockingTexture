// The node's own front end: it mounts the desktop tool's page inside the node and keeps the node and the page
// talking about the same picture.
//
// Why an iframe and not a rewrite
// -------------------------------
// The page is ~2700 lines of canvas, hit-testing, solve-status and SVG-outline code that is known to work. The
// previous attempt at this node re-implemented a slice of it and got the brush, the wand, the guides and the
// texture itself wrong; the fix is to stop re-implementing and run the real thing. An iframe gives the page its
// own document, so its global key handlers, its `document.querySelector` lookups and its i18n module cannot
// collide with ComfyUI's own — which is exactly what a hand-ported script would do.
//
// What the node adds on top of the page:
//
//   * a picture from the socket, pushed into the page as soon as the node runs;
//   * the same picture back out on a socket, taken from the page's own render;
//   * a 全屏 button, because the page is laid out for a window and the node is not;
//   * 「自动选择丝袜」, the one preprocessing button, which makes the panel call the node's own auto pass;
//   * 「原图放大」, a zoom-and-pan viewer for the *unprocessed* picture, so the region the auto pass found can be
//     judged against the artwork at 1:1 instead of through the node's thumbnail. The panel's own 细节 tab zooms
//     the *textured* result; neither of those is the other.
//   * a 成品 strip under the page, showing the finished picture the node will hand on, with the same
//     zoom-and-pan viewer and a save button. It is the node's only in-node view of that picture: ComfyUI's own
//     copy of it is declined (see hideOutputPicture), because two copies of one picture — the second one at a
//     size nobody chose — is exactly what this strip replaced;
//   * a drag grip on the panel's corner, because the node's own resize grip is under the DOM widget and cannot
//     be reached.
//
// The page is loaded from /stocking/panel/, which is served by routes.panel_file — deliberately *not* from
// WEB_DIRECTORY. ComfyUI hands every `.js` under WEB_DIRECTORY to the main page as an extension, and the page's
// own scripts loaded there kill the frontend's startup outright: no node definitions arrive and no node of any
// kind can be created.
//
// Nothing here edits a region. Every edit goes page → /stocking/api/... → Document, the same path the desktop
// tool uses, so the two cannot drift apart.

import { app } from '/scripts/app.js';

// Served from /stocking/panel/, not from /extensions/...: everything under WEB_DIRECTORY is fed to the main
// page as a ComfyUI extension, and the page's own scripts must not be (see routes.panel_file).
const PANEL = '/stocking/panel/index.html';
const NODE_TYPE = 'StockingTexture';

// The page is a window-sized layout — a side panel plus a canvas — so the node has to start wide enough for it.
// A litegraph node defaults to ~270px, which would put the tools in a column too narrow to draw in.
const DEFAULT_W = 960;
const MIN_H = 560;           // the page's own layout breaks below roughly this
const DEFAULT_H = 900;

// The grip at the panel's corner resizes the node. It may not go below these, for MIN_H's reason — the page
// still has to lay out — and because the 成品 strip below it needs a minimum of its own.
//
// MIN_NODE_H is 780 rather than 640 (2026-10-16): the panel's floor is MIN_H, and the node also carries the six
// normal widgets (~144px) and the slot row (~64px) above it, so 560 + 144 + 64 ≈ 768 is the shortest node the
// layout itself will allow. Dragging to 640 would just snap back to 768 on the next draw, so the grip agrees with
// the layout instead of fighting it.
const MIN_W = 620;
const MIN_NODE_H = 780;

// The 成品 thumbnail. The render behind it is full size either way (the renderer draws the whole picture and
// then scales), so this only decides how many bytes come over the wire.
const THUMB_W = 512;

// Long enough that a brush stroke followed by a solve does not start a render per drag, short enough that the
// strip still feels like it is following what you do.
const RESULT_DEBOUNCE = 900;

// The 预览 strip's own drag limits, and the floor the page needs above it (see MIN_H).
const STRIP_MIN = 46;                 // its bar, and nothing else: the same as 收起
const EDITOR_MIN = 220;
const STRIP_H_KEY = 'stocking_strip_h';

// 「送入下游」is off. It worked, but the way it worked was the problem: putting the picture on the socket means
// running the graph, and running the graph means sampling again — one click bought a whole extra pass, which is
// most of what 「执行」 costs. The gesture people actually wanted it for is "keep this picture", and that is what
// 「保存」 does now (a render plus a file write, no queue). Everything behind this flag stays: flip it to
// true and the button comes back with its pin, its queue call and its 状态 messages intact.
const PUSH_AVAILABLE = false;

// ---------------------------------------------------------------------------- the stylesheet
//
// web/stocking.css is NOT loaded by ComfyUI on its own. `WEB_DIRECTORY` hands the frontend every `**/*.js` under
// it (server.py's /extensions route lists exactly that) and nothing else, and the folder is served statically, so
// the file is fetchable but never linked. That is why the node's strip had no height, its two panes stacked
// instead of sitting side by side, and the resize grip — an 18px absolutely-positioned div — could not be seen or
// grabbed at all: none of it was ever styled. So link it from here, resolved against this module's own URL
// (`/extensions/<folder>/stocking.js`), which keeps working whatever the folder is called.
//
// If that link cannot be served (a proxy, a renamed folder), the fallback below still fixes the layout: the
// geometry is duplicated there on purpose, because a panel with no layout is unusable rather than merely plain.
const CSS_FALLBACK = `
.stocking-result{flex:0 0 auto;height:clamp(150px,28%,420px);display:flex;flex-direction:column;min-width:0;
  background:#1a1a1a;border-top:1px solid #3a3a3a}
.stocking-result.collapsed{height:auto}
.stocking-result.collapsed .stocking-result-body{display:none}
.stocking-result-bar{display:flex;align-items:center;gap:6px;flex:0 0 auto;padding:4px 6px;font-size:12px;
  background:#262626;border-bottom:1px solid #3a3a3a}
.stocking-result-body{flex:1 1 auto;position:relative;min-height:0;min-width:0;display:flex;flex-direction:row;
  align-items:stretch;overflow:hidden;background:#141414}
.stocking-pane{flex:1 1 0;min-width:0;min-height:0;display:flex;flex-direction:column;background:#141414}
.stocking-pane + .stocking-pane{border-left:1px solid #3a3a3a}
.stocking-pane-head{display:flex;align-items:center;gap:4px;flex:0 0 auto;padding:3px 5px;font-size:11px;
  background:#1e1e1e;border-bottom:1px solid #333}
.stocking-pane-body{flex:1 1 auto;position:relative;min-height:0;min-width:0;display:flex;align-items:center;
  justify-content:center;overflow:hidden}
.stocking-pane-img{max-width:100%;max-height:100%;object-fit:contain;display:block;cursor:zoom-in}
.stocking-pane-empty{display:flex;align-items:center;justify-content:center;padding:0 10px;color:#8a8a8a;
  font-size:12px;text-align:center}
.stocking-result[hidden],.stocking-result-body[hidden],.stocking-pane[hidden],.stocking-pane-img[hidden],
.stocking-pane-empty[hidden],.stocking-split[hidden]{display:none}
.stocking-split{flex:0 0 auto;height:6px;cursor:ns-resize;background:#262626;border-top:1px solid #3a3a3a;
  border-bottom:1px solid #2a2a2a}
.stocking-split:hover,.stocking-split.dragging{background:#3a4a5a}
.stocking-grip{position:absolute;right:0;bottom:0;width:18px;height:18px;z-index:40;cursor:nwse-resize;opacity:.75;
  background:linear-gradient(135deg,transparent 0 52%,#6a6a6a 52% 62%,transparent 62% 72%,#6a6a6a 72% 82%,transparent 82%)}
.stocking-grip:hover{opacity:1}
`;

function loadStyles() {
  if (document.querySelector('link[data-stocking-css]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.dataset.stockingCss = '1';
  let href = '';
  try {
    href = new URL('./stocking.css', import.meta.url).href;
  } catch { /* no import.meta (bundled): the fallback covers the layout */ }
  if (!href) { useFallbackStyles('(no import.meta.url)'); return; }
  link.href = href;
  link.addEventListener('error', () => useFallbackStyles(href));
  document.head.append(link);
}

function useFallbackStyles(why) {
  console.warn(`[stocking] 样式表没加载上（${why}），改用内置布局`);
  const s = document.createElement('style');
  s.dataset.stockingCss = 'fallback';
  s.textContent = CSS_FALLBACK;
  document.head.append(s);
}

loadStyles();

// ---------------------------------------------------------------------------- one shared document
//
// There is one editable document at a time — the one on the node's socket — and one panel showing it. Two nodes
// cannot each have their own panel and share the same server-side document without fighting over it, so the
// first node that mounts a panel becomes the host and the rest say who has it. In the ordinary case there is
// exactly one of these nodes per graph, and this is invisible.

let hostWidget = null;
let hostNode = null;

// ---------------------------------------------------------------------------- the panel

function buildPanel(node) {
  const wrap = document.createElement('div');
  wrap.className = 'stocking-dom';
  wrap.style.cssText = `display:flex;flex-direction:column;width:100%;height:100%;background:#1e1e1e;
    border-radius:6px;overflow:hidden;position:relative;`;

  // ---- the strip above the page: the only chrome the node adds
  const bar = document.createElement('div');
  bar.className = 'stocking-bar';
  bar.style.cssText = `display:flex;align-items:center;gap:6px;padding:4px 6px;background:#262626;
    border-bottom:1px solid #3a3a3a;flex:0 0 auto;font-size:12px;`;

  const auto = document.createElement('button');
  auto.textContent = '自动选择丝袜';
  auto.title = '预处理：用 SAM + 深度找出丝袜区域，找完可以在下面手动增删。只选部位，不画走向线';
  auto.style.cssText = btnStyle('#2d5f8a');

  const adopt = document.createElement('button');
  adopt.textContent = '取用节点图片';
  adopt.title = '把节点最近一次收到的图片载入编辑区（工作流还没跑过时用）';
  adopt.style.cssText = btnStyle('#3a3a3a');

  const zoom = document.createElement('button');
  zoom.textContent = '原图放大';
  zoom.title = '放大看没处理过的原图：滚轮缩放，拖动平移，双击回到适应窗口，Esc 关闭';
  zoom.style.cssText = btnStyle('#3a3a3a');

  const full = document.createElement('button');
  full.textContent = '全屏';
  full.title = '把编辑界面放到整个标签页，按 Esc 或再点一次退出';
  full.style.cssText = btnStyle('#3a3a3a');

  // 「送入下游」: takes the picture in the 成品 strip and puts it on the next node. Without it the socket only
  // moved when the graph ran, and an edit made after that run left the next node holding the picture from before
  // the edit — which is what "只能转入编辑之前的图片" was. Parked for now (see PUSH_AVAILABLE): the price of
  // putting a picture on a socket is a run, and a run re-samples. Disabled rather than deleted, so the reason is
  // one flag away from being undone.
  const push = document.createElement('button');
  push.textContent = '送入下游';
  push.disabled = !PUSH_AVAILABLE;
  push.title = PUSH_AVAILABLE
    ? '把「成品」作为本节点的输出交给下一个节点：先按界面当前设置渲染并锁定这张图，再执行一次工作流，'
      + '下游的保存图像 / 预览拿到的就是这张成品。'
      + '上游有缓存时采样器不会重跑；如果采样器的种子设成「每次随机」，执行会重新采样成另一张图，'
      + '那种情况下请把种子固定住再送'
    : '暂不可用：把成品送到下游要执行一次工作流，也就等于重新采样一轮，代价太大。'
      + '要留住这张成品请用「成品」右边的「保存」，它只渲染和写盘，不进队列。'
      + '（功能本身保留着，把 stocking.js 里的 PUSH_AVAILABLE 改回 true 就恢复。）';
  push.style.cssText = btnStyle('#2d5f8a') + (PUSH_AVAILABLE ? '' : 'opacity:.4;cursor:not-allowed;');

  const status = document.createElement('span');
  status.className = 'stocking-status';
  status.style.cssText = `margin-left:auto;color:#9a9a9a;white-space:nowrap;overflow:hidden;
    text-overflow:ellipsis;max-width:60%;`;

  bar.append(auto, adopt, zoom, full, push, status);

  // ---- the page itself
  const frame = document.createElement('iframe');
  frame.className = 'stocking-frame';
  frame.src = PANEL;
  frame.setAttribute('allow', 'clipboard-write');
  frame.style.cssText = `flex:1 1 auto;width:100%;border:0;background:#1e1e1e;display:block;`;

  // ---- the finished picture, under the page (requirements 2 and 4)
  const result = buildResult();

  // ---- the handle between the page and the strip (requirement 3)
  const split = buildSplit();

  // ---- the original-picture viewer, an overlay inside the node (not a popup: ComfyUI in an app window
  // cannot be relied on for window.open, and this keeps the picture in the same box the user is looking at).
  const viewer = buildViewer('原图（未处理）');

  // ---- the finished-picture viewer, same viewer, different picture: this one magnifies what the node produced
  // rather than what it was given, and it can hand the full-size render over as a file.
  const resultViewer = buildViewer('成品（整体）', { save: true });

  wrap.append(bar, frame, split.root, result.root, viewer.root, resultViewer.root);

  return { wrap, bar, frame, auto, adopt, zoom, full, push, status, viewer, result, resultViewer, split };
}

// ---------------------------------------------------------------------------- 原图放大
//
// Requirement 4: 未处理的图片 need a magnification of their own. The panel's 细节 tab zooms the result, and the
// node's built-in preview is a thumbnail; neither shows the *input* at 1:1, which is what you want when you are
// checking whether the auto pass picked the right pixels. So: a plain img, a transform, and three gestures.

function buildViewer(label, { save = false } = {}) {
  const root = document.createElement('div');
  root.className = 'stocking-viewer';
  root.hidden = true;
  // display is driven here rather than by the `hidden` attribute alone: an inline `display` beats the UA
  // `[hidden]` rule, so a viewer styled `display:flex` would stay on screen behind `hidden = true`.
  root.style.cssText = `position:absolute;inset:0;z-index:50;background:#141414;display:none;
    flex-direction:column;overflow:hidden;`;

  const bar = document.createElement('div');
  bar.style.cssText = `display:flex;align-items:center;gap:6px;padding:4px 6px;background:#262626;
    border-bottom:1px solid #3a3a3a;flex:0 0 auto;font-size:12px;color:#cfcfcf;`;

  const title = document.createElement('span');
  title.textContent = label;
  title.style.cssText = 'color:#9a9a9a;';

  const pct = document.createElement('span');
  pct.style.cssText = 'min-width:46px;text-align:right;color:#cfcfcf;';

  const fit = document.createElement('button');
  fit.textContent = '适应窗口';
  fit.style.cssText = btnStyle('#3a3a3a');

  const one = document.createElement('button');
  one.textContent = '100%';
  one.style.cssText = btnStyle('#3a3a3a');

  const zoomOut = document.createElement('button');
  zoomOut.textContent = '−';
  zoomOut.title = '缩小';
  zoomOut.style.cssText = btnStyle('#3a3a3a') + 'width:24px;';

  const zoomIn = document.createElement('button');
  zoomIn.textContent = '+';
  zoomIn.title = '放大';
  zoomIn.style.cssText = btnStyle('#3a3a3a') + 'width:24px;';

  // Only the 成品 viewer gets this: it is the picture the user is trying to keep.
  const saveBtn = save ? document.createElement('button') : null;
  if (saveBtn) {
    saveBtn.textContent = '保存';
    saveBtn.title = '把这张原始尺寸的成品写进 ComfyUI 的 output/stocking/（不执行工作流）';
    saveBtn.style.cssText = btnStyle('#2d5f8a');
  }

  const close = document.createElement('button');
  close.textContent = '关闭';
  close.title = '关闭（Esc）';
  close.style.cssText = btnStyle('#3a3a3a') + 'margin-left:auto;';

  const hint = document.createElement('span');
  hint.textContent = '滚轮缩放 · 拖动平移 · 双击适应窗口';
  hint.style.cssText = 'color:#7a7a7a;margin-right:8px;';

  bar.append(title, zoomOut, zoomIn, pct, fit, one, hint);
  if (saveBtn) bar.append(saveBtn);
  bar.append(close);

  const stage = document.createElement('div');
  stage.style.cssText = `flex:1 1 auto;overflow:hidden;position:relative;cursor:grab;
    background:#141414;`;

  const img = document.createElement('img');
  img.draggable = false;
  img.alt = label;
  img.style.cssText = `position:absolute;left:0;top:0;transform-origin:0 0;user-select:none;
    image-rendering:auto;will-change:transform;`;

  const empty = document.createElement('div');
  empty.textContent = '还没有图片：先运行一次工作流';
  empty.style.cssText = `position:absolute;inset:0;display:none;align-items:center;justify-content:center;
    color:#8a8a8a;font-size:13px;`;

  stage.append(img, empty);
  root.append(bar, stage);

  const v = { root, bar, stage, img, empty, pct, close, fit, one, zoomIn, zoomOut, hint, title, save: saveBtn,
              scale: 1, tx: 0, ty: 0, fitScale: 1, src: null, open: false };
  wireViewer(v);
  return v;
}

function vApply(v) {
  v.img.style.transform = `translate(${v.tx}px, ${v.ty}px) scale(${v.scale})`;
  v.pct.textContent = Math.round(v.scale * 100) + '%';
}

function vFit(v) {
  if (!v.img.naturalWidth) return;
  const bw = v.stage.clientWidth, bh = v.stage.clientHeight;
  const s = Math.min(bw / v.img.naturalWidth, bh / v.img.naturalHeight);
  v.fitScale = s || 1;
  v.scale = v.fitScale;
  v.tx = (bw - v.img.naturalWidth * s) / 2;
  v.ty = (bh - v.img.naturalHeight * s) / 2;
  vApply(v);
}

function vZoomAt(v, factor, cx, cy) {
  const next = Math.min(Math.max(v.scale * factor, 0.05), 16);
  // Keep the point under the cursor fixed: the shift is the difference between the old and new offsets of that
  // point, which is what makes wheel-zoom feel anchored rather than drifting toward the corner.
  const k = next / v.scale;
  v.tx = cx - (cx - v.tx) * k;
  v.ty = cy - (cy - v.ty) * k;
  v.scale = next;
  vApply(v);
}

function wireViewer(v) {
  v.close.addEventListener('click', () => closeViewer(v));
  v.fit.addEventListener('click', () => vFit(v));
  if (v.save) v.save.addEventListener('click', () => { if (v.onSave) v.onSave(); });
  v.one.addEventListener('click', () => {
    v.scale = 1;
    v.tx = (v.stage.clientWidth - v.img.naturalWidth) / 2;
    v.ty = (v.stage.clientHeight - v.img.naturalHeight) / 2;
    vApply(v);
  });
  v.zoomIn.addEventListener('click', () => vZoomAt(v, 1.25, v.stage.clientWidth / 2, v.stage.clientHeight / 2));
  v.zoomOut.addEventListener('click', () => vZoomAt(v, 0.8, v.stage.clientWidth / 2, v.stage.clientHeight / 2));

  v.stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = v.stage.getBoundingClientRect();
    vZoomAt(v, e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });

  let drag = null;
  v.stage.addEventListener('pointerdown', (e) => {
    if (!v.img.naturalWidth) return;
    drag = { x: e.clientX, y: e.clientY, tx: v.tx, ty: v.ty, id: e.pointerId };
    v.stage.style.cursor = 'grabbing';
    try { v.stage.setPointerCapture(e.pointerId); } catch { /* not vital */ }
  });
  v.stage.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    v.tx = drag.tx + (e.clientX - drag.x);
    v.ty = drag.ty + (e.clientY - drag.y);
    vApply(v);
  });
  const endDrag = (e) => {
    if (!drag || (e && e.pointerId !== drag.id)) return;
    drag = null;
    v.stage.style.cursor = 'grab';
  };
  v.stage.addEventListener('pointerup', endDrag);
  v.stage.addEventListener('pointercancel', endDrag);
  v.stage.addEventListener('dblclick', () => vFit(v));

  v.img.addEventListener('load', () => { v.empty.style.display = 'none'; vFit(v); });
  v.img.addEventListener('error', () => showEmpty(v, '这张图读不出来'));
}

// `url` is the picture to show: the art route for the input, the result route for the 成品. Each caller builds
// its own, with a cache-busting stamp — the browser would otherwise hand back the previous picture when a graph
// re-runs to the same document id. `pending` is what the stage says until the picture arrives, which for the
// 成品 is a render that takes a moment rather than a failure worth staring at.
function openViewer(v, url, { onSave = null, pending = '正在载入…' } = {}) {
  v.open = true;
  v.root.hidden = false;
  v.root.style.display = 'flex';
  v.onSave = onSave;
  if (!url) { v.img.removeAttribute('src'); showEmpty(v, '还没有图片：先运行一次工作流'); return; }
  showEmpty(v, pending);
  v.img.src = url;
  if (v.img.complete) vFit(v);
}

function showEmpty(v, msg) {
  v.empty.textContent = msg;
  v.empty.style.display = 'flex';
}

function closeViewer(v) {
  v.open = false;
  v.root.hidden = true;
  v.root.style.display = 'none';
}

function btnStyle(bg) {
  return `padding:3px 9px;background:${bg};color:#e8e8e8;border:1px solid #4a4a4a;border-radius:4px;
    cursor:pointer;font-size:12px;line-height:1.5;white-space:nowrap;`;
}

// ---------------------------------------------------------------------------- talking to the page

function call(frame, path, opts) {
  // The page's own shim routes /api -> /stocking/api, so calls made from here use the same prefix directly.
  return fetch(`/stocking/api${path}`, opts).then(async (r) => {
    const text = await r.text();
    let j = null;
    try { j = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (!r.ok) throw new Error((j && j.detail) || `HTTP ${r.status}`);
    return j;
  });
}

// ---------------------------------------------------------------------------- mount

function mount(node, widget) {
  const p = widget.__panel = buildPanel(node);
  p.__node = node;

  p.auto.addEventListener('click', () => runAuto(node, p));
  p.adopt.addEventListener('click', () => runAdopt(p));
  p.zoom.addEventListener('click', () => toggleViewer(p));
  p.full.addEventListener('click', () => toggleFull(node, p));
  p.push.addEventListener('click', () => pushDownstream(node, p));
  wireResult(node, p);
  wireGrip(node, p);
  wireSplit(p);

  // One Esc handler for both overlays, because there is only one key and the innermost thing should win: a
  // viewer closes before full screen does, the same rule the page's own dialogs follow.
  p.__esc = (e) => {
    if (e.key !== 'Escape') return;
    if (!p.resultViewer.root.hidden) { closeViewer(p.resultViewer); e.stopPropagation(); return; }
    if (!p.viewer.root.hidden) { closeViewer(p.viewer); e.stopPropagation(); return; }
    if (p.wrap.dataset.full === '1') { exitFull(p); e.stopPropagation(); }
  };
  window.addEventListener('keydown', p.__esc, true);

  p.frame.addEventListener('load', () => {
    p.frame.contentWindow.__stockingPush = (sid, ready) => pushState(p, sid, ready);
    // A fresh page has no document of its own: ask the node to hand over the one it holds.
    runAdopt(p, { quiet: true });
  });

  // The page's shim posts one of these after every edit it makes (see panel/shim.js). The picture the strip
  // shows depends on those edits, and there is no other way for the node to hear about them.
  node.__stockingPanel = p;
  return p;
}

function pushState(p, sid, ready) {
  if (sid) p.__sid = sid;
  p.status.textContent = ready ? `已就绪 · ${sid ? sid.slice(0, 6) : ''}` : '等图片…';
  p.status.style.color = ready ? '#7fbf7f' : '#9a9a9a';
  // A run just rendered the picture this strip is for, so it is now the old one.
  if (sid) scheduleResult(p, 200);
}

// 原图放大. The document on screen is `p.__sid` — set by the node's most recent run and by 取用节点图片 — and the
// art route serves exactly that document's input, so the viewer needs no separate picture on the wire.
function toggleViewer(p) {
  const v = p.viewer;
  if (!v.root.hidden) { closeViewer(v); return; }
  openViewer(v, p.__sid ? artUrl(p.__sid) : null);
}

// `w` (0 = full size) asks the art route for a smaller copy. The pane that shows 处理前 is a few hundred px
// wide, and the artwork is several thousand: sending it whole makes the browser decode and hold a full-size
// bitmap to draw a thumbnail, in a node that is redrawn on every canvas pan. The magnifier asks for the full one.
function artUrl(sid, w = 0) {
  const q = w ? `?w=${w}&t=${Date.now()}` : `?t=${Date.now()}`;
  return `/stocking/api/doc/${encodeURIComponent(sid)}/art${q}`;
}

async function runAuto(node, p) {
  p.auto.disabled = true;
  p.status.textContent = '正在自动选择丝袜…';
  p.status.style.color = '#d0b060';
  try {
    // The auto pass lives on the node; the panel only asks for it. Doing it in the browser would mean a second
    // implementation of the same decision, which is how the wand ended up disagreeing with 自动 last time.
    const r = await call(p.frame, '/auto', { method: 'POST' });
    p.status.textContent = r && r.found ? `自动选出 ${r.found} 个部位` : '没找到丝袜：手动点选或涂一下';
    p.status.style.color = r && r.found ? '#7fbf7f' : '#d08a60';
    reloadPanel(p);
  } catch (e) {
    p.status.textContent = '自动选择失败：' + e.message;
    p.status.style.color = '#d06a6a';
  } finally {
    p.auto.disabled = false;
  }
}

async function runAdopt(p, { quiet = false } = {}) {
  try {
    const st = await call(p.frame, '/open/socket', { method: 'POST' });
    adopted(p, st);                             // the 原图放大 viewer and the 成品 strip follow this document
    if (!quiet) reloadPanel(p);
  } catch (e) {
    if (!quiet) {
      p.status.textContent = e.message;
      p.status.style.color = '#d08a60';
    }
  }
}

// A document is now the one on screen: remember it, so the two overlays and the 成品 strip point at the same
// picture the page is editing rather than at whatever they were showing before.
function adopted(p, st) {
  if (!st) return;
  if (st.id) p.__sid = st.id;
  if (st.name) p.__name = st.name;              // 保存 names the file after it
  if (st.id) scheduleResult(p, 400);
  scheduleWidgetSync(p, 700);                   // this document's look is now the node widgets' truth
}

function reloadPanel(p) {
  try { p.frame.contentWindow.location.reload(); } catch { p.frame.src = PANEL; }
}

// ---------------------------------------------------------------------------- 送入下游
//
// The IMAGE socket only carries a new picture when the graph runs, and until now the only way to get an edit to
// the next node was to press Queue and trust that the run would pick the edit up. Two things were wrong with
// that. It was invisible (nothing said the picture had been handed on, or that it had not), and the run rendered
// with the node's own widgets rather than the panel's settings, so the next node received a differently styled
// picture than the one on screen — "只能转入编辑之前的图片".
//
// This button does both halves of the promise: the server renders the picture the 成品 strip is showing and pins
// it against the document's current state (`/doc/{id}/push` → routes.push_doc), then the prompt is queued so the
// downstream nodes run and collect it. `nodes.apply` takes the pinned bytes instead of rendering again, so what
// arrives downstream is exactly what was approved on screen. Any edit after the press changes the pin's
// signature, and the next run renders fresh — the pin never outlives the state it was made from.
//
// Parked behind PUSH_AVAILABLE: the second half is a run, and a run re-samples. Kept whole on purpose — if the
// gesture is ever wanted back, the flag is the only thing to change.
async function pushDownstream(node, p) {
  if (!PUSH_AVAILABLE || p.push.disabled) return;
  const say = (text, color) => { p.status.textContent = text; p.status.style.color = color; };
  if (!p.__sid) { say('还没有图片：先运行一次工作流', '#d08a60'); return; }
  if (!outputLinked(node)) {
    say('这个节点的 image 输出没有接到下一个节点：先连一个保存图像 / 预览', '#d08a60');
    return;
  }
  p.push.disabled = true;
  say('正在渲染成品…', '#d0b060');
  try {
    const r = await call(p.frame, `/doc/${encodeURIComponent(p.__sid)}/push`, { method: 'POST' });
    scheduleResult(p, 0);                          // the strip shows the picture that was just pinned
    if (!await queuePrompt()) {
      say('成品已备好，但没能加入队列：请手动点「执行」', '#d08a60');
      return;
    }
    const bits = [r?.style, r?.density ? `${Math.round(r.density)}%` : '',
                  r?.strength ? `强度 ${Math.round(r.strength)}%` : ''].filter(Boolean);
    say(`已送入下游${bits.length ? ' · ' + bits.join(' ') : ''}`, '#7fbf7f');
    if (r?.empty) say('送入下游 · 还没有可出纹理的部位，成品就是原图', '#d08a60');
  } catch (e) {
    say('送入下游失败：' + e.message, '#d06a6a');
  } finally {
    p.push.disabled = !PUSH_AVAILABLE;
  }
}

// Is anything on the other end of the image socket? Only positive evidence of an empty socket stops the button:
// a node drawn by the Vue renderer may not carry `links` at all, and refusing to queue because a field is missing
// would be worse than queueing something with nowhere to go.
function outputLinked(node) {
  const o = node.outputs?.[0];
  if (!o) return true;
  if (Array.isArray(o.links)) return o.links.length > 0;
  if (o.links === null) return o.link != null;
  return true;
}

// Queueing, across the two frontend generations: `app.queuePrompt` is the extension-facing call and is what every
// custom node uses; if it is gone, `graphToPrompt` + `api.queuePrompt` is the same request written out.
async function queuePrompt() {
  try {
    if (typeof app.queuePrompt === 'function') {
      await app.queuePrompt(0, 1);
      return true;
    }
  } catch (e) {
    console.warn('[stocking] app.queuePrompt 调用失败，改用 api.queuePrompt', e);
  }
  try {
    if (typeof app.graphToPrompt !== 'function') return false;
    // Imported here rather than at the top: an extension whose module fails to evaluate takes the whole node
    // with it, and this fallback is only ever needed on a frontend that has already lost `app.queuePrompt`.
    const { api } = await import('/scripts/api.js');
    await api.queuePrompt(0, await app.graphToPrompt());
    return true;
  } catch (e) {
    console.warn('[stocking] 加入队列失败', e);
    return false;
  }
}

// ---------------------------------------------------------------------------- one look, two sets of controls
//
// The node carries 样式/密度/强度 widgets and the panel carries the same three sliders plus 斜度 and 亮点 — and the
// document's look is the one place they all mean something (`nodes.apply` and the 成品 render both read it). So a
// move on either surface is written into it, and the other surface follows:
//
//   * node widgets → document: a PATCH of just the keys that moved. A PUT would carry the whole set and reset the
//     斜度 / 亮点 the user set in the panel to their defaults, which they never touched.
//   * document → node widgets: `syncWidgets`, read back from the document. Without it the node's own controls
//     would keep claiming 细线 knit while the picture on screen is 油光 — and a workflow saved from that graph
//     would carry the wrong numbers.

const WIDGET_LOOK = [['样式_style', 'style'], ['密度_density', 'density'], ['强度_strength', 'strength']];

function scheduleWidgetLook(p, key, value) {
  if (!p.__sid) return;
  p.__lookPatch = p.__lookPatch || {};
  p.__lookPatch[key] = key === 'style' ? (STYLE_KEYS[String(value)] || 'knit') : Number(value);
  // Moving 强度 by hand is turning 自动 off; 自动 was picking the number, so this one is the user's.
  if (key === 'strength') p.__lookPatch.strength_auto = false;
  clearTimeout(p.__lookTimer);
  p.__lookTimer = setTimeout(() => flushWidgetLook(p), 220);
}

async function flushWidgetLook(p) {
  const patch = p.__lookPatch;
  p.__lookPatch = null;
  if (!patch || !p.__sid) return;
  try {
    await call(p.frame, `/doc/${encodeURIComponent(p.__sid)}/look`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
    });
    // The panel's sliders are showing the same three settings, so tell the page to re-read them rather than let
    // them disagree with the picture the widget just asked for.
    try { p.frame.contentWindow.postMessage({ stocking: 'look' }, '*'); } catch { /* page not loaded */ }
    scheduleResult(p, 150);
    scheduleWidgetSync(p, 600);
  } catch (e) {
    p.status.textContent = '样式没写进面板：' + e.message;
    p.status.style.color = '#d06a6a';
  }
}

let syncTimer = 0;

function scheduleWidgetSync(p, delay = 500) {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => syncWidgets(p), delay);
}

async function syncWidgets(p) {
  if (!p.__sid || !p.__node) return;
  let q = null;
  try {
    const info = await call(p.frame, `/doc/${encodeURIComponent(p.__sid)}/look`);
    q = info && info.params;
  } catch { return; }                         // the page is reloading, or the document is gone: nothing to mirror
  if (!q) return;
  p.__mirroring = true;                       // a value written here must not read as the user moving a widget
  try {
    setWidget(p.__node, '样式_style', STYLE_LABELS[q.style] || q.style);
    setWidget(p.__node, '密度_density', Math.round(q.density));
    setWidget(p.__node, '强度_strength', Math.round(q.strength));
  } finally {
    p.__mirroring = false;
  }
}

function setWidget(node, name, value) {
  const w = node.widgets?.find((x) => x.name === name);
  if (!w || value === undefined || w.value === value) return;
  w.value = value;
  app.graph?.setDirtyCanvas(true, true);
}

// ---------------------------------------------------------------------------- full screen

function toggleFull(node, p) {
  const on = p.wrap.dataset.full === '1';
  if (on) exitFull(p);
  else {
    p.wrap.dataset.full = '1';
    p.wrap.__home = p.wrap.parentElement;
    document.body.append(p.wrap);
    Object.assign(p.wrap.style, { position: 'fixed', inset: '0', zIndex: 99999, borderRadius: '0' });
    p.full.textContent = '退出全屏';
  }
  resizeFrame(p);
}

function exitFull(p) {
  if (p.wrap.dataset.full !== '1') return;
  p.wrap.dataset.full = '0';
  Object.assign(p.wrap.style, { position: 'relative', inset: 'auto', zIndex: 'auto', borderRadius: '6px' });
  if (p.wrap.__home) p.wrap.__home.append(p.wrap);
  p.full.textContent = '全屏';
  resizeFrame(p);
}

function resizeFrame(p) {
  // A node resize is the one thing that can leave the strip taller than its space (see clampStrip), and it has
  // to happen before the page is told about the new box.
  clampStrip(p);
  // The page measures the iframe's box; a size change that lands a frame late would make it lay out for the
  // old box, so nudge it once on the next tick as well.
  const fire = () => { try { p.frame.contentWindow.dispatchEvent(new Event('resize')); } catch { /* not loaded */ } };
  fire();
  requestAnimationFrame(fire);
  // The viewers' boxes changed too; their fit is computed from clientWidth, so sitting on a stale transform
  // would park the picture off-centre.
  for (const v of [p.viewer, p.resultViewer]) {
    if (v && !v.root.hidden) requestAnimationFrame(() => vFit(v));
  }
}

// ---------------------------------------------------------------------------- 预览（处理前 / 成品）
//
// Requirements 2 and 4, and the follow-up: the two "show me a picture" features are one feature, so they are one
// bar now, side by side —
//
//   处理前   what the node was given: the artwork the panel is editing, at 1:1 with the socket;
//   成品     what the node hands on: the same thing with the knit on it, from the node's own three widgets.
//
// Each pane magnifies on a click and saves on a button, which is also how you tell whether an edit did anything:
// with both in front of you, "it looks the same" stops being a guess.
//
// The 成品 is the node's picture, not the panel's opinion of it — and the node's picture is rendered from the
// *document's* look, which is exactly what the panel's sliders write and what `nodes.apply` reads. So this asks
// for the render and nothing else. It used to also send the node's 样式/密度/强度 widgets along, which quietly
// overrode the panel: changing the material in the panel moved the picture on 整体 and left the 成品 showing the
// previous style, because the strip kept asking for the widget's.
const STYLE_KEYS = { '细线 knit': 'knit', '针织 loops': 'loops', '线圈 coil': 'coil',
                     '斜单线 lines': 'lines', '加濑风 grain': 'grain', '油光 oily': 'oily' };
const STYLE_LABELS = Object.fromEntries(Object.entries(STYLE_KEYS).map(([k, v]) => [v, k]));

function resultUrl(p, { w = 0 } = {}) {
  const q = new URLSearchParams();
  if (w) q.set('w', String(w));
  q.set('t', String(Date.now()));
  return `/stocking/api/doc/${encodeURIComponent(p.__sid)}/result?${q}`;
}

// One half of the bar: a caption with its own two buttons, and the picture under it.
//
// The two panes save differently on purpose. 处理前 is a picture the node was *given* — keeping a copy of it is a
// local file for the user, so it downloads. 成品 is the picture the node *makes*, and the place for it is the
// output folder: that is where the rest of ComfyUI looks for results, and a download is not an output.
function buildPane(label, tip, { toOutput = false } = {}) {
  const root = document.createElement('section');
  root.className = 'stocking-pane';

  const head = document.createElement('div');
  head.className = 'stocking-pane-head';

  const name = document.createElement('span');
  name.className = 'stocking-pane-label';
  name.textContent = label;
  name.title = tip;

  const spacer = document.createElement('span');
  spacer.className = 'stocking-pane-spacer';

  const zoom = document.createElement('button');
  zoom.textContent = '放大';
  zoom.title = `放大看${label}：滚轮缩放，拖动平移，双击适应窗口，Esc 关闭`;

  const save = document.createElement('button');
  save.textContent = '保存';
  save.title = toOutput
    ? '把「成品」按界面当前设置写进 ComfyUI 的 output/stocking/：不执行工作流、不重新采样，同名文件会被覆盖'
    : `把${label}按原始尺寸下载到你的电脑（PNG）`;

  head.append(name, spacer, zoom, save);

  const body = document.createElement('div');
  body.className = 'stocking-pane-body';

  const img = document.createElement('img');
  img.className = 'stocking-pane-img';
  img.alt = label;
  img.draggable = false;
  img.hidden = true;
  img.title = '点一下放大';

  const empty = document.createElement('div');
  empty.className = 'stocking-pane-empty';

  body.append(img, empty);
  root.append(head, body);
  return { root, head, name, zoom, save, img, empty };
}

function buildResult() {
  const root = document.createElement('div');
  root.className = 'stocking-result';
  root.hidden = true;                       // nothing worth showing until a run or an edit produces one

  const bar = document.createElement('div');
  bar.className = 'stocking-result-bar';

  const title = document.createElement('span');
  title.className = 'stocking-result-title';
  title.textContent = '预览';
  title.title = '左边是节点收到的那张图（处理前），右边是加过纹理之后节点要交出去的成品';

  const note = document.createElement('span');
  note.className = 'stocking-result-note';

  const reload = document.createElement('button');
  reload.textContent = '刷新';
  reload.title = '按当前样式 / 密度 / 强度重新渲染一次成品';

  const fold = document.createElement('button');
  fold.className = 'stocking-result-fold';
  fold.textContent = '收起';
  fold.title = '收起预览，把地方让给编辑界面';

  bar.append(title, note, reload, fold);

  const body = document.createElement('div');
  body.className = 'stocking-result-body';
  const before = buildPane('处理前', '节点收到的那张图，还没有加纹理');
  const after = buildPane('成品', '加过纹理的那张图：点「保存」就写进 ComfyUI 的 output/stocking/',
                          { toOutput: true });
  body.append(before.root, after.root);

  root.append(bar, body);

  return { root, bar, note, reload, fold, body, before, after,
           url: null, artSid: null, busy: false, again: false, collapsed: false, shown: false, timer: 0 };
}

// Requirement 3, the other half of it. The grip resizes the whole node, which grows the page and the strip
// together and needs room on the canvas for the node to grow into. This is the handle that trades space between
// the two *inside* the node the user already has: drag it up for a longer 成品, down for a taller editing page.
// Double-click puts the strip back to its own share (the clamp in stocking.css).
function buildSplit() {
  const root = document.createElement('div');
  root.className = 'stocking-split';
  root.hidden = true;                   // nothing to divide until there is a strip to divide from
  root.title = '拖动调整编辑区（上）和预览（下）的高度；双击恢复默认';
  root.setAttribute('role', 'separator');
  root.setAttribute('aria-orientation', 'horizontal');
  return { root };
}

function savedStripHeight() {
  try {
    const v = parseInt(localStorage.getItem(STRIP_H_KEY) || '', 10);
    return Number.isFinite(v) && v >= STRIP_MIN ? v : 0;
  } catch { return 0; }                 // private mode: no memory, no problem
}

// The node's own chrome inside the panel: the bar above the page and this handle below it. Neither belongs to
// either side of the division, and both are sized by their own contents, so they are measured rather than
// assumed. The overlays (the two viewers) and the grip are absolutely positioned and out of flow, and hidden
// pieces take no room at all — neither is part of it.
function chromeHeight(p) {
  let h = 0;
  for (const el of p.wrap.children) {
    if (el === p.frame || el === p.result.root) continue;
    const cs = getComputedStyle(el);
    if (cs.position !== 'static' || cs.display === 'none') continue;
    h += el.getBoundingClientRect().height;
  }
  return h;
}

// How tall the strip may get: what is left once the page keeps EDITOR_MIN.
function stripRoom(p, box) {
  return Math.max(STRIP_MIN + 1, Math.round(box.height - chromeHeight(p) - EDITOR_MIN));
}

// A height the user dragged is in pixels, so shrinking the node afterwards could leave the strip taller than the
// space it has and squeeze the page out of the node — with the handle, the way back, pushed out of reach too.
// Callers: every node resize (resizeFrame) and the moment the strip comes back up.
function clampStrip(p) {
  const r = p.result;
  if (!r || r.root.hidden || r.collapsed || !r.root.style.height) return;
  const box = p.wrap.getBoundingClientRect();
  if (!box.height) return;
  const h = parseFloat(r.root.style.height);
  const room = stripRoom(p, box);
  if (Number.isFinite(h) && h > room) r.root.style.height = `${room}px`;
}

// The handle belongs to the strip: no strip (or a folded one) means nothing to divide.
function syncSplit(p) {
  const r = p.result;
  p.split.root.hidden = r.root.hidden || r.collapsed;
}

function wireSplit(p) {
  const el = p.split.root;
  const r = p.result;

  el.addEventListener('dblclick', () => {
    r.root.style.height = '';           // back to the stylesheet's clamp
    try { localStorage.removeItem(STRIP_H_KEY); } catch { /* private mode */ }
    resizeFrame(p);
  });

  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();                // litegraph must not also read this as a click on the node
    const box = p.wrap.getBoundingClientRect();
    const startH = r.root.getBoundingClientRect().height;
    const startY = e.clientY;
    const room = stripRoom(p, box);
    try { el.setPointerCapture(e.pointerId); } catch { /* not vital */ }
    el.classList.add('dragging');
    let frame = 0;
    const move = (ev) => {
      const h = Math.round(Math.min(Math.max(startH + (startY - ev.clientY), STRIP_MIN), room));
      r.root.style.height = `${h}px`;   // an inline height wins over the strip's own clamp
      if (frame) return;                // the page re-lays out on resize: once a frame is enough
      frame = requestAnimationFrame(() => { frame = 0; resizeFrame(p); });
    };
    const up = (ev) => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      el.classList.remove('dragging');
      try { el.releasePointerCapture(ev.pointerId); } catch { /* already released */ }
      if (frame) { cancelAnimationFrame(frame); frame = 0; }
      try { localStorage.setItem(STRIP_H_KEY, String(Math.round(r.root.getBoundingClientRect().height))); } catch { /* private mode */ }
      resizeFrame(p);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  });
}

// Requirements 2 and 3 meet here. The page is laid out for a window, so the strip must not take the page's
// room: the node grows by the strip's height the first time there is something to show, and the editor keeps
// the box it had. After that the grip is how the two trade space, and a node that already carries a strip is
// left where the user put it — its saved height is well past DEFAULT_H, which is how the two are told apart.
function growForResult(p) {
  const r = p.result;
  if (r.shown) return;
  r.shown = true;
  const node = p.__node;
  if (!node) return;
  const h = savedStripHeight();
  if (h) r.root.style.height = `${h}px`;    // the height the user dragged it to last time
  r.root.hidden = false;
  clampStrip(p);
  syncSplit(p);
  const grown = r.root.offsetHeight;
  if (grown > 0 && node.size[1] < DEFAULT_H + 100) {
    node.setSize([node.size[0], node.size[1] + grown]);
    app.graph?.setDirtyCanvas(true, true);
    resizeFrame(p);
  }
}

function wireResult(node, p) {
  const r = p.result;
  r.reload.addEventListener('click', () => refreshResult(p));
  r.fold.addEventListener('click', () => {
    r.collapsed = !r.collapsed;
    r.root.classList.toggle('collapsed', r.collapsed);
    r.fold.textContent = r.collapsed ? '展开' : '收起';
    r.fold.title = r.collapsed ? '展开预览' : '收起预览，把地方让给编辑界面';
    syncSplit(p);
    resizeFrame(p);
  });

  // 处理前. Both the button and the picture itself open the magnifier: the button is for when the pane is too
  // small to aim at, the picture is the shortcut everyone reaches for.
  r.before.zoom.addEventListener('click', () => toggleViewer(p));
  r.before.img.addEventListener('click', () => toggleViewer(p));
  r.before.save.addEventListener('click', () => savePane(p, 'input'));
  r.before.img.addEventListener('error', () => paneEmpty(r.before, '这张图读不出来'));

  r.after.zoom.addEventListener('click', () => toggleResultViewer(p));
  r.after.img.addEventListener('click', () => toggleResultViewer(p));
  r.after.save.addEventListener('click', () => savePane(p, 'result'));
  r.after.img.addEventListener('error', () => paneEmpty(r.after, '成品图读不出来：先点「刷新」'));

  // 样式 / 密度 / 强度 on the node are the same three settings as the panel's sliders, and the document's look
  // is where they live (see "one look, two sets of controls"). A move here is written into the document, so the
  // picture on screen, the 成品 strip and the socket all follow it.
  for (const [name, key] of WIDGET_LOOK) {
    const w = node.widgets?.find((x) => x.name === name);
    if (!w) continue;
    const cb = w.callback;
    w.callback = function () {
      const out = cb?.apply(this, arguments);
      if (!p.__mirroring) scheduleWidgetLook(p, key, w.value);
      scheduleResult(p);
      return out;
    };
  }
}

function paneEmpty(pane, text) {
  pane.img.hidden = true;
  pane.empty.textContent = text;
  pane.empty.hidden = false;
}

function paneShow(pane) {
  pane.img.hidden = false;
  pane.empty.hidden = true;
}

function toggleResultViewer(p) {
  const v = p.resultViewer;
  if (!v.root.hidden) { closeViewer(v); return; }
  if (!p.__sid) { openViewer(v, null); return; }
  // The full-size render, not the thumbnail: this is the viewer you zoom to 1:1 in.
  openViewer(v, resultUrl(p), { onSave: () => savePane(p, 'result'), pending: '正在渲染成品图…' });
}

// A render is not free and the picture changes on every brush stroke, so refreshes are debounced and never
// overlap: a request that arrives while one is running only sets `again`, and the running one re-arms at the end.
function scheduleResult(p, delay = RESULT_DEBOUNCE) {
  if (!p.result) return;
  clearTimeout(p.result.timer);
  p.result.timer = setTimeout(() => refreshResult(p), delay);
}

// 处理前 comes straight from the art route, which is keyed by the document and cached inside it — so it only has
// to be re-pointed when a *different* document turns up, not on every refresh. The <img> is immortal; setting
// `src` to the same URL again would just make the browser reload the same bytes. The pane asks for a thumbnail;
// 「原图放大」 and 保存 are what want the full-size one.
function loadBeforePane(p) {
  const r = p.result;
  const sid = p.__sid;
  if (!sid || r.artSid === sid) return;
  r.artSid = sid;
  r.before.img.src = artUrl(sid, THUMB_W);
  paneShow(r.before);
}

async function refreshResult(p) {
  const r = p.result;
  if (!r) return;
  if (r.busy) { r.again = true; return; }
  if (!p.__sid) {
    // No document yet: keep the note ready but do not take space from the page for a strip with nothing in it.
    r.note.textContent = '等节点收到图片';
    r.note.style.color = '#9a9a9a';
    return;
  }
  r.busy = true;
  r.again = false;
  growForResult(p);
  r.root.hidden = false;
  syncSplit(p);
  loadBeforePane(p);
  r.note.textContent = '正在渲染成品…';
  r.note.style.color = '#d0b060';
  try {
    const res = await fetch(resultUrl(p, { w: THUMB_W }));
    if (!res.ok) {
      const j = await res.json().catch(() => null);
      throw new Error((j && j.detail) || `HTTP ${res.status}`);
    }
    const empty = res.headers.get('X-Stocking-Empty') === '1';
    const blob = await res.blob();
    if (r.url) URL.revokeObjectURL(r.url);
    r.url = URL.createObjectURL(blob);
    r.after.img.src = r.url;
    paneShow(r.after);
    // An untextured picture is a legitimate state, not a failure: the node would put the same thing on the
    // socket. Say which state it is, so a pane that looks unchanged is not mistaken for a broken render.
    if (empty) { r.note.textContent = '还没有涂部位：这时的成品和原图一样'; r.note.style.color = '#d08a60'; }
    else { r.note.textContent = ''; }
    if (!p.resultViewer.root.hidden) {
      // The magnifier is showing the previous render; it gets the new one at full size.
      p.resultViewer.img.src = resultUrl(p);
    }
  } catch (e) {
    r.note.textContent = '渲染失败：' + e.message;
    r.note.style.color = '#d06a6a';
    if (r.after.img.hidden) paneEmpty(r.after, '成品渲染失败：' + e.message);
  } finally {
    r.busy = false;
    if (r.again) { r.again = false; scheduleResult(p, 150); }
  }
}

// 保存. Both panes have one, and they mean different things: 处理前 hands the picture the node was *given* over
// as a download, 成品 writes the picture the node *makes* into ComfyUI's output tree (see saveToOutput).
async function saveResult(p) {
  return savePane(p, 'result');
}

async function savePane(p, kind) {
  const r = p.result;
  if (!p.__sid) { flashResult(p, '还没有图片：先运行一次工作流', '#d08a60'); return; }
  clearTimeout(r.timer);
  if (kind !== 'input') return saveToOutput(p);
  // 处理前 is the picture the node was *given*. A copy of it is the user's own business, so it downloads.
  flashResult(p, '正在准备处理前的图…', '#d0b060');
  try {
    const res = await fetch(artUrl(p.__sid));
    if (!res.ok) {
      const j = await res.json().catch(() => null);
      throw new Error((j && j.detail) || `HTTP ${res.status}`);
    }
    const name = `${p.__name || 'stocking'}-原图.png`;
    downloadBlob(await res.blob(), name);
    flashResult(p, `已保存 ${name}`, '#7fbf7f');
  } catch (e) {
    flashResult(p, '保存失败：' + e.message, '#d06a6a');
  }
}

// 成品 → output/stocking/. This is 「导出成品图」's own route (`POST /api/doc/{id}/export`), so what lands there is
// the same file the 导出 menu writes: same name, same style resolved off `doc.look`, and the same "某某没有走向线"
// note when a part was left without one. What it does *not* do is queue anything — no run, no re-sample, which is
// the whole point of having it here instead of on the 送入下游 button.
//
// What it writes is the 成品 pane's own render: the route draws it through `docstore.render`, the call `GET
// /result` makes, so the file cannot be a different picture from the one above the button. (It used to draw its
// own, off a cached scene, and could save the untouched 处理前 — the bug this button had.)
//
// Overwriting the previous save of the same name is deliberate: one picture, one file. The node's own runs name
// their frames with a timestamp, so nothing they wrote can be clobbered by this.
async function saveToOutput(p) {
  const name = outputPrefix(p.__node, p);
  flashResult(p, '正在渲染成品并写入 output/stocking/…', '#d0b060');
  try {
    const res = await call(p.frame, `/doc/${encodeURIComponent(p.__sid)}/export`,
                           { method: 'POST',
                             headers: { 'Content-Type': 'application/json' },
                             body: JSON.stringify({ kind: 'png', name }) });
    const note = (res.notes || []).join('；');
    flashResult(p, `已保存到 ${outputRel(res.file)}${note ? `（${note}）` : ''}`, '#7fbf7f');
  } catch (e) {
    // The refusals worth rewording: both of them mean "there is no texture to save yet", which from this button is
    // just the first thing a new user hits — the 成品 is the untouched original at that point, and the fix is to
    // draw on the picture, not to try again. The server refuses rather than writing that original, so the message
    // has to explain it. Matching on the text is loose, but the fallback is its own text.
    const msg = String(e.message || '');
    const noTexture = msg.includes('能出纹理的部位') || msg.includes('成品就是原图');
    flashResult(p, noTexture ? '还没有可出纹理的部位（成品就是原图，不保存原图）：先在「引导」页画一条走向线'
                             : '保存失败：' + msg,
                noTexture ? '#d08a60' : '#d06a6a');
  }
}

// The node's 文件名前缀 widget is what its own runs name their files after, so a manual save uses it too and the
// two live side by side in the folder (`stocking.png` next to `stocking_20261021-124500_00.png`). The document's
// own name is the fallback, and `stocking` the last resort — the server sanitises whatever arrives anyway.
function outputPrefix(node, p) {
  const w = (node?.widgets || []).find((x) => typeof x?.name === 'string' && x.name.startsWith('文件名前缀'));
  return (typeof w?.value === 'string' && w.value.trim()) || p.__name || 'stocking';
}

// The server answers with an absolute path, and the node has room for one short line. Cut at `output/`, which is
// both the shortest and the only part the user can act on — that is the folder ComfyUI shows them.
function outputRel(path) {
  const s = String(path || '').replace(/\\/g, '/');
  const m = s.match(/(?:^|\/)(output\/.+)$/);
  return m ? m[1] : (s.split('/').pop() || s);
}

// The browser writes the file; the object URL is kept alive a minute because the download starts asynchronously
// and revoking it too early leaves the user with a file that is 0 bytes.
function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.style.display = 'none';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

function flashResult(p, text, color) {
  p.result.note.textContent = text;
  p.result.note.style.color = color;
}

// ---------------------------------------------------------------------------- the resize grip
//
// Requirement 3. ComfyUI draws a node's own resize grip on the canvas, and the DOM widget sits on top of it, so
// in this node it cannot be reached. This is the same gesture in a place that is reachable: drag the corner and
// the node — and with it the editing page and the 成品 strip — gets bigger or smaller.
function wireGrip(node, p) {
  const grip = document.createElement('div');
  grip.className = 'stocking-grip';
  grip.title = '拖动调整编辑区大小（和拉节点右下角一样）';
  grip.setAttribute('aria-hidden', 'true');
  p.wrap.append(grip);

  grip.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();          // litegraph must not also take this as a click on the node
    const scale = app.canvas?.ds?.scale || 1;
    const start = { x: e.clientX, y: e.clientY, w: node.size[0], h: node.size[1] };
    try { grip.setPointerCapture(e.pointerId); } catch { /* not vital */ }
    const move = (ev) => {
      const w = Math.max(MIN_W, Math.round(start.w + (ev.clientX - start.x) / scale));
      const h = Math.max(MIN_NODE_H, Math.round(start.h + (ev.clientY - start.y) / scale));
      node.setSize([w, h]);
      app.graph?.setDirtyCanvas(true, true);
      resizeFrame(p);
    };
    const up = (ev) => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      grip.removeEventListener('pointercancel', up);
      try { grip.releasePointerCapture(ev.pointerId); } catch { /* already released */ }
      resizeFrame(p);
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
    grip.addEventListener('pointercancel', up);
  });

  p.grip = grip;
  return grip;
}

// ---------------------------------------------------------------------------- ComfyUI's own copy, switched off
//
// The node's IMAGE output makes ComfyUI show that picture in the node as well: under the panel, taking room of
// its own, with an image-size caption. That is the same picture the 成品 pane above already shows — at a size
// you chose, with a magnifier and a save button on it — so it is the one thing in the node nobody needs twice,
// and it is also a full-size bitmap being decoded and painted for nothing, next to two thumbnails.
//
// It is turned off rather than deleted, because the frontend has two ways of drawing it and only one of them is
// a widget you can remove:
//
//   * `hideOutputImages` is the frontend's own per-node switch, read before it decides to draw anything. It is
//     not a trick: ComfyUI's own `Comfy.Painter` and `Comfy.ImageCropV2` nodes set exactly this flag in exactly
//     this place (their `nodeCreated` hooks do nothing else about the preview), and the Vue node mode that
//     draws today's node reads it first.
//   * the older canvas preview is a widget the frontend rebuilds from `node.imgs` on every single draw —
//     `onDrawBackground` → `unsafeUpdatePreviews` → `showCanvasImagePreview`, with no throttle — so removing
//     that widget cannot stick; the next frame puts it straight back. A node that reports no images is not
//     previewed at all, so `imgs` reads empty here instead. Nothing else needs it: the panes and the viewers
//     are fed by the routes, and the frontend's other readers of it (`getNodeImageUrl`, copying to the
//     clipspace) fall back to the node's outputs, which still carry the picture.
//
// `ui.images` is deliberately left alone. That is what puts the picture where ComfyUI lists a node's output —
// the queue and the history — and what `保存到output_save` announces the file it wrote through; only the
// in-node copy is being declined.
function hideOutputPicture(node) {
  // Both halves are belt-and-braces, so a node that refuses either one has to stay a working node: this runs
  // from onNodeCreated, and an exception here would abort the mount and leave a node with no panel at all.
  try {
    node.hideOutputImages = true;
  } catch { /* a frozen node: nothing to switch off, and nothing to break the node's creation over */ }
  try {
    Object.defineProperty(node, 'imgs', {
      configurable: true,
      get: () => undefined,
      set: () => { /* the frontend loading a preview we have declined: nothing to store it for */ },
    });
  } catch { /* same */ }
}

// ---------------------------------------------------------------------------- the extension

app.registerExtension({
  name: 'StockingTexture.Panel',

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_TYPE) return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated?.apply(this, arguments);
      const self = this;

      this.size = [Math.max(this.size[0], DEFAULT_W), Math.max(this.size[1], DEFAULT_H)];
      hideOutputPicture(this);            // before the node has been drawn once (see above)
      const holder = document.createElement('div');
      const widget = this.addDOMWidget('stocking_panel', 'panel', holder, {
        serialize: false,
        hideOnZoom: false,
        getValue: () => '',
        setValue: () => {},
      });
      const p = mount(this, widget);
      // addDOMWidget puts `holder` in the DOM itself, sometimes wrapped in a container; swap our panel in where
      // the holder sits, then repoint the widget so litegraph's own resize/teardown keeps working.
      holder.replaceWith(p.wrap);
      widget.element = p.wrap;
      // ★ 不要给这个 widget 写 computeSize（2026-10-16 修）。原来那一行是
      //
      //     widget.computeSize = (w) => [w, Math.max(MIN_H, (self.size?.[1] ?? DEFAULT_H) - 120)];
      //
      //   它把「这个 widget 需要多高」写成了「节点现在多高」的函数，而节点的排布又是把各 widget 的高度
      //   加起来算的 —— 一个正反馈。经典画布渲染器（Nodes 2.0 关闭时）在每一帧重绘里都会跑
      //   node.arrange() → _arrangeWidgets()，其结尾是：
      //
      //     !vueNodesMode && l > t && (this.setSize([this.size[0], l]), this.graph.setDirtyCanvas(false, true))
      //
      //   其中 l = 各 widget 高度之和、t = 节点高度。把上面的 computeSize 代进去，l - t ≡ 92px（常数），
      //   于是节点每帧长高 92px，而 setDirtyCanvas 又让自己下一帧继续重绘 —— 无限长高，且永远缩不回来
      //   （拉小之后下一帧又被撑回去），就是用户看到的「非常长的长条，无法回收」。
      //
      //   用 computeLayoutSize（且不给 maxHeight）才是对的：widget 拿走「剩下的空间」，节点高度就不再
      //   出现在自己的高度公式里。这正是前端给 DOM widget 的默认行为，也是 ComfyUI 自己的 WebcamCapture /
      //   视频预览 widget 的写法。MIN_H 作为地板保留（页面布局撑不到那么矮）。
      //
      //   ⚠️ 改回 computeSize 会让别人的 ComfyUI（默认关闭 Nodes 2.0）立刻重现长条；作者这台机器开着
      //   Nodes 2.0，那条 setSize 被 !vueNodesMode 挡掉了，所以本地看不出问题。验证脚本见
      //   J:\WORK\2026-10-16-13-20-27\stocking-longstrip\sim_arrange_widgets.mjs
      widget.computeLayoutSize = () => ({ minHeight: MIN_H, minWidth: 0 });

      // The node's own IMAGE preview is requirement 4's 原生成图; the panel's 引导 canvas is 点选图 and its
      // 纹理 tab (整体 + 细节) is 完成效果图. Nothing to build — just make sure the preview is on.
      const onExecuted = this.onExecuted;
      this.onExecuted = function (msg) {
        onExecuted?.apply(this, arguments);
        // Nothing to do about ComfyUI's own copy of the picture here: it was declined when the node was created
        // and the frontend never draws it (see hideOutputPicture). `ui.images` still reaches the queue.
        const card = msg?.stocking?.[0];
        if (!card) return;
        const p = self.__stockingPanel;
        if (!p) return;
        pushState(p, card.sid, card.ready);
        // A run just replaced the picture, so any viewer that is up is showing the previous one: re-point it. The
        // document is identified by its id — the old code compared `card.sid` against `viewer.src`, which is a
        // URL carrying a cache-busting stamp, so the test never matched and an open viewer went stale.
        if (card.sid) {
          if (!p.viewer.root.hidden && card.sid !== p.__viewerSid) {
            p.__viewerSid = card.sid;
            openViewer(p.viewer, artUrl(card.sid));
          }
          if (!p.resultViewer.root.hidden) refreshResult(p);
        }
        // The node just resolved (possibly a different) picture, so the panel's document is stale. Reload it the
        // way 取用节点图片 does: one round trip, and the page comes back showing the picture that just ran.
        if (card.sid && card.sid !== p.__sid) {
          p.__sid = card.sid;
          adoptInto(p);
        }
      };

      hostWidget = widget;
      hostNode = this;
      return r;
    };
  },
});

// Point the panel at the document the node holds: POST /open/socket makes the node's current document the one
// the panel edits, then the page is reloaded so it fetches that document's state.
async function adoptInto(p) {
  try {
    const st = await call(p.frame, '/open/socket', { method: 'POST' });
    adopted(p, st);
    reloadPanel(p);
  } catch { /* nothing on the node yet; the page stays on its empty state */ }
}

// A DOM widget inside a litegraph node needs its canvas redrawn when the browser window resizes, or the iframe
// keeps the old size.
window.addEventListener('resize', () => {
  if (hostWidget && hostWidget.__panel) resizeFrame(hostWidget.__panel);
});

// The page (panel/shim.js) posts one of these after every edit it makes, because that is the only way the node
// can hear about an edit at all: the edits go page → Document, past the node entirely. Only the hosting panel
// listens — there is one document, and the panel showing it is the only one whose strip means anything — and
// `e.source` is checked so that nothing else on the page can drive this.
window.addEventListener('message', (e) => {
  const p = hostWidget && hostWidget.__panel;
  if (!p || e.source !== p.frame.contentWindow) return;
  const d = e.data;
  if (!d || d.stocking !== 'changed') return;
  scheduleResult(p);
  // A panel edit may have been a 样式 / 密度 / 强度 move: the node's widgets are showing the same setting, so
  // they follow along rather than keep claiming the old one.
  scheduleWidgetSync(p);
});
