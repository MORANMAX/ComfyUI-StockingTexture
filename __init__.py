"""丝袜纹理 Stocking Texture for ComfyUI.

Registers one native node and the routes its three-picture panel talks to. The panel is a view onto the same
session the node renders from, so the picture in the panel and the picture on the IMAGE socket are the same
picture by construction.

A port of silvermoong/stocking-texture-tool (MIT).
"""
from .nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS, _resolve_sam_models

# Only the node's own extension belongs here. ComfyUI collects every `.js` under this directory — recursively —
# and imports each one into the ComfyUI page as an extension. The desktop tool's page lives in `panel/`
# (served by routes.panel_file) precisely so it is NOT collected: its scripts need a document the ComfyUI page
# does not have, and importing them there aborts the frontend's startup, so no node definitions arrive and no
# node of any kind can be added.
WEB_DIRECTORY = './web'

try:
    from . import routes
    routes.register()
except Exception as _exc:      # never let a route problem stop the node from loading
    print(f'[stocking] 编辑器路由未挂载：{_exc}')

# Loading torch + the SAM checkpoint takes a few seconds; doing it now means the first click on 点选
# does not look like a hang. A failure here is not fatal — the node still renders, just without 点选.
_resolve_sam_models()

__all__ = ['NODE_CLASS_MAPPINGS', 'NODE_DISPLAY_NAME_MAPPINGS', 'WEB_DIRECTORY']
