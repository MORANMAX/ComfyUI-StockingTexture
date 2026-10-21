"""The bridge between a ComfyUI IMAGE socket and the upstream tool's Document.

The upstream tool's unit of work is a `Document`: it owns the art, the regions, the guide strokes, the
solve, the undo stack and the coverage map, and it renders through `look.Scene`. A ComfyUI node has no such
thing — a picture arrives as a float tensor on a socket, the user's clicks arrive over HTTP, and the result
has to go back out on another socket. This module is the thing in the middle that holds a Document between
those two moments.

    d = store.acquire(rgb, sid)   # the Document for this picture, created or reused
    d.state()                     # what the panel draws itself from
    out = store.render(rgb, sid, params)   # the finished picture, as the socket wants it

Nothing about the texture is decided here. `upstream/` is the desktop tool's own algorithm layer, copied
verbatim; this file only decides *which* Document a picture belongs to and *when* to render it.
"""
import threading
import time
import uuid

import cv2
import numpy as np

from .upstream import look
from .upstream.document import Document

MAX_DOCS = 8
TTL = 3600.0


def _fingerprint(rgb):
    """A cheap, stable digest of a picture: downscale, flatten to gray, keep the bytes.

    Used to answer "have I already seen this exact picture", which is what makes the first queue run after
    the user has already been editing work: the widget carrying the session id is not serialised into the
    prompt until run two, so on run one the node has no id and must recognise the picture itself.
    """
    try:
        small = cv2.resize(rgb, (32, 32), interpolation=cv2.INTER_AREA)
        return cv2.cvtColor(small, cv2.COLOR_RGB2GRAY).tobytes()
    except Exception:
        return None


class Store:
    """The open Documents, keyed by session id, plus a picture-fingerprint index for the first run."""

    def __init__(self):
        self._d = {}
        self._lock = threading.Lock()

    def acquire(self, rgb, sid=None):
        """The Document for `rgb`, or a new one when there is none to reuse.

        Reuse has two gates, and both exist for a reason: the id has to match (so the panel and the node
        agree), and the size has to match (so an old session's edits are never applied to a differently
        shaped picture — the masks would be meaningless). Failing both, a fingerprint match is tried: that
        is what rescues the very first queue run, when the widget is still empty.
        """
        sid = (sid or '').strip()
        with self._lock:
            if sid:
                d = self._d.get(sid)
                if d is not None and d.art.shape[:2] == rgb.shape[:2]:
                    d._touched = time.time()
                    return d
            found = self._find(rgb)
            if found is not None:
                if sid and sid != found.id:
                    self._d[sid] = found          # adopt the panel's id for the picture it already drew on
                found._touched = time.time()
                return found
        d = Document(np.ascontiguousarray(rgb), f'socket-{sid or uuid.uuid4().hex[:8]}')
        d._touched = time.time()
        with self._lock:
            self._d[sid or d.id] = d
            self._evict()
        return d

    def _find(self, rgb):
        fp = _fingerprint(rgb)
        if fp is None:
            return None
        best, best_t = None, -1.0
        for d in self._d.values():
            if d.art.shape[:2] != rgb.shape[:2]:
                continue
            if _fingerprint(d.art) != fp:
                continue
            t = getattr(d, '_touched', 0.0)
            if t > best_t:
                best, best_t = d, t
        return best

    def get(self, sid):
        with self._lock:
            d = self._d.get(sid)
            if d is not None:
                d._touched = time.time()
            return d

    def replace(self, sid, d):
        """Put a Document under this id, dropping whatever was there (used by 载入图片)."""
        with self._lock:
            self._d[sid] = d
            d._touched = time.time()
            self._evict()

    def drop(self, sid):
        with self._lock:
            d = self._d.pop(sid, None)
        if d is not None:
            try:
                d.close()
            except Exception:
                pass

    def _evict(self):
        now = time.time()
        for k, v in list(self._d.items()):
            if now - getattr(v, '_touched', now) > TTL:
                self._d.pop(k, None)
        while len(self._d) > MAX_DOCS:
            oldest = min(self._d.values(), key=lambda d: getattr(d, '_touched', 0.0))
            self._d.pop(oldest.id, None)


store = Store()


# ---------------------------------------------------------------------------- rendering
#
# The render is done straight from the upstream Scene, not from a re-implementation, so the picture on the
# IMAGE socket and the picture in the panel's 纹理 page are the same bytes by construction.

RENDER_DEFAULTS = dict(look.DEFAULTS)


def render(doc, params):
    """(rgb uint8, info dict) for a Document at these look parameters.

    The parameters a render starts from are the *document's own* look — the one the panel's 样式 / 密度 / 斜度 /
    亮点 controls write into `doc.look` on every slider move — and only then the explicit overrides in `params`.
    Starting from RENDER_DEFAULTS instead (which this did) made every render in the node silently drop whatever the
    panel was set to: 油光/140% in the panel still rendered 细线/100%/tilt 32, so the 成品 strip and the IMAGE
    socket showed a different picture than the one on screen.

    Raises nothing for a document with no regions: an empty selection is a legitimate state (the user has not
    said where the stockings are yet) and the honest answer is the picture back, unchanged.
    """
    q = look.clean_params({**RENDER_DEFAULTS, **(doc.look or {}), **(params or {})})
    REG, V, NX, NY, A = doc.fields()
    if not (REG > 0).any():
        return doc.art.copy(), {'empty': True, 'params': q}
    # A callable, not the array: Scene calls it on every sparkle render (see routes._scene_for).
    scene = look.scene_from_doc(doc, disparity=lambda: getattr(doc, 'disparity', None))
    bgr, info = scene.render(q)
    out = np.ascontiguousarray(bgr[..., ::-1])
    info = dict(info or {})
    info['params'] = q
    info['empty'] = False
    return out, info
