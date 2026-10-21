"""The upstream stocking-texture-tool's algorithm layer, copied from silvermoong (MIT).

Copied so the node's texture *is* the desktop tool's texture: document.py owns the regions, the guides, the
solve and the undo stack, and look.py owns style, density, strength and sparkles. Nothing here is rewritten —
a port that re-derived this would be a second implementation to keep in sync, which is exactly how a port drifts.

What deviates, and why (do NOT copy these back from upstream — the node breaks):

  _loads.py   new. One lock around model construction, shared by sam.py and depth.py. Building SAM and the
              depth model concurrently leaves SAM's weights in half precision on this torch build, and every
              点选 then fails with "Input type (struct c10::Half) and bias type (float) should be the same".
  sam.py      _loads.LOCK held around sam_model_registry[...](...)  — construction only, not inference.
  depth.py    _loads.LOCK held around from_pretrained(...)          — construction only, not inference.
  psd_io.py   psd-tools made optional (try/except ImportError + a _need_psd() guard on the three functions
              that read a PSD). A ComfyUI install usually has no psd-tools, and a missing optional dependency
              must not stop the whole algorithm layer from importing. This file is also CRLF; upstream is LF.
  __init__.py this docstring; upstream's is empty.

Everything else is byte-for-byte identical to G:\\siwa\\stocking. See ../STRUCTURE.md §2.2 for the full table.
"""
