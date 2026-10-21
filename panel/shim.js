// The desktop tool's page, made to run inside a ComfyUI node.
//
// The page is the original app.js/look.js/style.css, unmodified. Three things it expects are not true here, and
// this file is the whole of the difference:
//
//   1. Paths. The page calls /api/...; the node serves the same API under /stocking/api/..., because two custom
//      nodes must not fight over /api/. Both of the page's ways of asking are covered: `fetch` (including the
//      helper the page wraps it in) and the `src` of an <img> — the latter carries the artwork, the region
//      masks and the coverage map, and is the one that is easy to miss.
//   2. A file dialog. There is none. 打开… and drag-a-file are hidden; the picture comes from the socket, and
//      取用节点图片 pulls in whatever the node last received.
//   3. EventSource. The node answers with the version counters already in the state payload, so the stream is
//      replaced by a no-op object rather than a connection that would 404 and retry forever.
//   4. Notifications. The node shows the finished picture in a 成品 strip under the page, and it can only learn
//      that an edit landed by being told. Every edit passes through the `fetch` override below, which is
//      therefore the one place that can see all of them; it posts one message per successful edit and the node
//      decides what to do with it.
//
// Nothing here changes what an edit does. It only changes where the page's requests go, and tells the node when
// one of them has gone somewhere.
(function () {
  'use strict';

  var API = '/stocking/api';

  // ---------------------------------------------------------------- 1. /api/ -> /stocking/api/
  // fetch and EventSource are the page's only two network entry points; overriding them means no edit to
  // app.js/look.js is needed, so an upstream fix can be copied over verbatim.

  function remap(url) {
    if (typeof url !== 'string') {
      if (url && typeof url.url === 'string') return remap(url.url);   // a Request object
      return url;
    }
    if (url === '/api' || url.indexOf('/api/') === 0) return API + url.slice(4);
    return url;
  }

  var nativeFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    // 4. Tell the node when the picture it should be showing has changed.
    //
    //    The node has a 成品 strip under the page, and it can only know that an edit landed by being told. Every
    //    edit goes through this function, so this is the one place that sees all of them; the node debounces the
    //    rest. Only requests that change this document count — GET is the page reading state back, and
    //    /open/... & /lang are not edits — so a strip that is never asked to re-render for nothing.
    var url = remap(input);
    var guarded = typeof url === 'string' && url.indexOf(API + '/doc/') === 0;
    if (guarded) {
      var method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      guarded = method !== 'GET' && method !== 'HEAD';
    }
    var p = nativeFetch(url, init);
    if (guarded) {
      p.then(function (r) { if (r.ok) tellNode(); }, function () { /* the page reports its own failures */ });
    }
    return p;
  };

  function tellNode() {
    try { window.parent.postMessage({ stocking: 'changed' }, '*'); } catch (e) { /* standalone (not framed) */ }
  }

  // `loadImage()` in app.js builds an <img> and assigns `img.src` — it does not go through fetch, so the
  // override above never sees it. Its three callers are exactly the three pictures the page draws: the artwork
  // itself (`/doc/{id}/art`), each region's mask, and the coverage map. Left unremapped they were asked of
  // ComfyUI's own `/api/` — which has no `/doc/...` — and every one answered 404. The page then came up looking
  // half-alive: the tool list, the region list and the zoom all correct (that state arrives over fetch), and a
  // blank canvas where the picture should be. Remapping the `src` setter fixes all three at once, and keeps
  // app.js/look.js byte-identical to upstream.
  var imgSrc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
  if (imgSrc && imgSrc.set && imgSrc.get) {
    Object.defineProperty(HTMLImageElement.prototype, 'src', {
      configurable: true,
      enumerable: imgSrc.enumerable,
      get: function () { return imgSrc.get.call(this); },
      set: function (value) { imgSrc.set.call(this, remap(value)); },
    });
  }

  // A stand-in that fires exactly the events the page relies on, and nothing else.
  //
  // This is not a stub to be sneaky about the missing stream: app.js does its *initial* document fetch from
  // `es.onopen`, so an EventSource that never opens means the page never loads a document — it sits on the empty
  // state with the node's picture one fetch away. Opening once (on the next tick, after app.js has assigned
  // `onopen`) and then going quiet gives the page its initial load and leaves the version counters in the state
  // payload to carry the rest.
  function SilentEvents(url) {
    this.readyState = 0;      // CONNECTING
    this.url = String(url || '');
    this.onopen = this.onmessage = this.onerror = null;
    const self = this;
    setTimeout(() => {
      if (self.readyState === 2) return;   // closed before we got a chance
      self.readyState = 1;                 // OPEN
      if (typeof self.onopen === 'function') self.onopen(new Event('open'));
    }, 0);
  }
  SilentEvents.prototype.close = function () { this.readyState = 2; };
  SilentEvents.prototype.addEventListener = function () {};
  SilentEvents.prototype.removeEventListener = function () {};
  window.EventSource = SilentEvents;

  // ---------------------------------------------------------------- 2. the desktop-only chrome

  // The server that owns the page is the node; a version mismatch is not something a page reload can fix here.
  // app.js only reloads when `p.version` changes, and the node never sends one, so nothing to do.

  function hideDesktopChrome() {
    // 打开… / 拖文件进来: the picture arrives on the socket. Keep the buttons out of the way entirely.
    for (var id of ['#btn-open', '#btn-open-2']) {
      var el = document.querySelector(id);
      if (el) el.hidden = true;
    }
    var fi = document.querySelector('#file-input');
    if (fi) fi.remove();

    // The empty state says "把 PNG 或 PSD 拖到这里" — here it means "run the workflow".
    var empty = document.querySelector('#empty');
    if (empty) {
      var lead = empty.querySelector('.lead');
      if (lead) lead.textContent = '等节点收到图片';
      var hint = empty.querySelector('.hint');
      if (hint) hint.textContent = '运行一次工作流，采样器输出的图会自动进到这里；也可以点下面的按钮取用节点收到的图片';
      var open2 = empty.querySelector('#btn-open-2');
      if (open2) {
        open2.textContent = '取用节点图片';
        open2.id = 'btn-adopt';
        open2.hidden = false;
      }
    }

    // Dragging a file onto the window still fires dragenter/drop handlers in app.js; a drop outside the page
    // would otherwise navigate the iframe to the file. Blocking default at the window is enough.
    for (var ev of ['dragover', 'drop']) {
      window.addEventListener(ev, function (e) { e.preventDefault(); }, false);
    }
  }

  // 「取用节点图片」: adopt whatever the node last saw. This is how the panel is usable before the graph has run,
  // and how it recovers if the page is reloaded mid-session.
  function wireAdopt() {
    document.addEventListener('click', function (e) {
      var b = e.target && e.target.closest && e.target.closest('#btn-adopt');
      if (!b) return;
      e.preventDefault();
      b.disabled = true;
      nativeFetch(API + '/open/socket', { method: 'POST' })
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
        .then(function (res) {
          if (!res.ok) throw new Error((res.j && res.j.detail) || '取不到节点图片');
          // app.js learns about a new document by polling GET /api/doc; nudge it by reloading the page, which
          // is what the desktop tool does after an update and costs one round trip.
          location.reload();
        })
        .catch(function (err) {
          b.disabled = false;
          var msg = document.querySelector('#status-msg');
          if (msg) { msg.textContent = '取用节点图片失败：' + err.message; msg.classList.add('bad'); }
        });
    }, true);
  }

  // 在文件夹中显示 has no OS handler behind it in a browser; say so rather than failing silently.
  function wireReveal() {
    document.addEventListener('click', function (e) {
      var b = e.target && e.target.closest && e.target.closest('#btn-reveal');
      if (!b) return;
      e.preventDefault();
      e.stopPropagation();
      var p = document.querySelector('#exported-notes');
      if (p) { p.textContent = '文件已经写进 ComfyUI 的 output/stocking/ 文件夹，请在那里查看。'; p.hidden = false; }
    }, true);
  }

  function boot() {
    hideDesktopChrome();
    wireAdopt();
    wireReveal();
    document.documentElement.classList.add('in-comfy');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
