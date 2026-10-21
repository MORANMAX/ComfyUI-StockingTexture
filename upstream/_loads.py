"""One lock shared by the two model loaders.

`sam.SamService` and `depth.DepthService` each build a torch module and move it to the GPU; the desktop tool
starts them at import, from two threads, and on this torch build (2.12+cu130) that leaves SAM's own weights in
half precision — the first 点选 then fails with

    RuntimeError: Input type (struct c10::Half) and bias type (float) should be the same

(or the mirror image, "mat1 and mat2 must have the same dtype, but got Float and Half"). It was reproducible on
every run of the parallel version and on none of the serial ones, so the fix is to let them take turns building
their model. The lock is held only around construction, not around inference: a click still runs while the depth
model loads.
"""
import threading

LOCK = threading.Lock()
