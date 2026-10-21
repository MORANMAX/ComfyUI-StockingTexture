"""Where are the stockings? — the automatic *pre-processing* pass.

(The docstring below is the original one; the module is used from `nodes.StockingTexture._auto` and only
ever *proposes* regions. It never draws guide lines: those are the user's layer.)

Find the stocking region when the user has not painted one.

Path order, and why it is this order
------------------------------------
  mask in   A MASK socket is a deliberate, external answer (painted in ComfyUI, or produced by any segmenter).
            It wins outright: it is cleaned up, split into body parts, and used as-is.

  SAM       No mask. The hard part is *where to click*. An earlier version clicked the points the depth model
            called nearest-to-camera, which sounds right and is wrong on the pictures this tool exists for: the
            nearest object is usually a hand held toward the viewer, a knee, or a face, and prompting there
            segments a hand. What is actually wanted is the pair of limbs the stockings are on, so the points are
            chosen by a hypothesis about the *picture* — two roughly symmetric dark limb-shaped masses in the
            lower half — and only then handed to SAM. Depth, where present, refines the ranking rather than
            making the choice.

  colour    No SAM. The largest smooth *dark* area of one colour in the lower frame, per band. Conservative by
            design: a wrong region textures a face or a dress, so nothing is returned rather than a bad guess.

The caller is expected to let the user overrule any of this; the automatic pass exists to give a starting point,
not a verdict.
"""
import cv2
import numpy as np

MIN_AREA_FRAC = 0.012       # a region smaller than this fraction of the frame is not a body part


def _clean(mask, min_area):
    m = (mask > 0.5) if mask.dtype != bool else mask.copy()
    m = cv2.morphologyEx(m.astype(np.uint8), cv2.MORPH_OPEN, np.ones((3, 3), np.uint8)).astype(bool)
    m = cv2.morphologyEx(m.astype(np.uint8), cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8)).astype(bool)
    n, lab, st, _ = cv2.connectedComponentsWithStats(m.astype(np.uint8), connectivity=8)
    if n <= 1:
        return np.zeros_like(m)
    big = st[1:, 4].max()
    keep = [i for i in range(1, n) if st[i, 4] >= max(min_area, 0.02 * big)]
    return np.isin(lab, keep) if keep else np.zeros_like(m)


def split_parts(mask, min_area=0):
    """(parts, labels): the mask's connected pieces as separate body parts, each at least min_area px.

    A crotch painted up to a pair of thighs is one blob; splitting it there is what 部位 splitting does in the
    desktop tool, and the automatic path uses the same rule so each leg is solved on its own.
    """
    m = _clean(mask, min_area)
    n, lab = cv2.connectedComponents(m.astype(np.uint8), connectivity=8)
    parts = []
    for k in range(1, n):
        piece = lab == k
        if piece.sum() < min_area:
            continue
        parts.append(_split_waist(piece))
    flat = []
    for group in parts:
        flat.extend(group)
    if not flat:
        return [m] if m.any() else [], lab
    out = np.zeros(m.shape, np.int32)
    for i, p in enumerate(flat, 1):
        out[p] = i
    return flat, out


def _split_waist(piece):
    """A blob that is two legs joined at a crotch: cut it where the cross-section pinches. Otherwise as is."""
    ys, xs = np.nonzero(piece)
    if len(ys) < 400:
        return [piece]
    y0, y1 = ys.min(), ys.max()
    height = y1 - y0 + 1
    if height < 60:
        return [piece]
    # row widths: a crotch shows as a local minimum after a wide top
    rows = np.arange(y0, y1 + 1)
    widths = np.array([(piece[r]).sum() for r in rows], np.float64)
    if widths.max() <= 0:
        return [piece]
    k = max(3, height // 12) | 1
    sm = np.convolve(widths, np.ones(k) / k, mode='same')
    top = int(0.15 * height)
    bottom = int(0.60 * height)
    if bottom <= top + 2:
        return [piece]
    seg = sm[top:bottom]
    if len(seg) < 3:
        return [piece]
    i = int(np.argmin(seg))
    if seg[i] > 0.72 * float(np.median(sm[top:bottom])):
        return [piece]                      # no real waist
    cut_row = rows[top + i]
    upper = piece.copy()
    lower = piece.copy()
    upper[cut_row + 2:, :] = False
    lower[:cut_row - 2, :] = False
    uc = _clean_bits(upper)
    lc = _clean_bits(lower)
    if len(uc) < 2 or len(lc) < 2:
        return [piece]
    return [upper, lower]


def _clean_bits(m):
    n, lab, st, _ = cv2.connectedComponentsWithStats(m.astype(np.uint8), connectivity=8)
    if n <= 1:
        return []
    big = st[1:, 4].max()
    return [lab == i for i in range(1, n) if st[i, 4] >= 0.05 * big]


def from_mask(mask, min_area_frac=MIN_AREA_FRAC):
    """Parts from a user-supplied HxW mask (float 0..1 or bool).

    The floor on a part's size is relative to how much there is, not to the frame: a leg is often a tenth of the
    picture, so a frame-relative floor throws away exactly the parts we are looking for.
    """
    m = (mask > 0.5)
    inside = int(m.sum())
    if inside < 64:
        return [], np.zeros(m.shape, np.int32)
    min_area = max(int(min_area_frac * inside), 64)
    parts, labels = split_parts(m, min_area)
    return [p for p in parts if p.any()], labels


MAX_SUBJECT_FRAC = 0.62      # a SAM result covering more than this much of the frame is not a body part
MIN_SUBJECT_FRAC = MIN_AREA_FRAC


# ---------------------------------------------------------------------------- where to click

DARK_L = 168.0               # Lab L*: stocking fabric sits below this. A white shirt does not.
SYMMETRY_TOL = 0.34          # |x_left + x_right - (w-1)| / w: how far a pair may sit off centre

# Stockings are worn on legs, and legs are below the waist. This is the one piece of knowledge that reliably
# separates a stocking from the other dark, low-chroma, elongated things in an illustration — hair above all,
# which is dark, low-chroma, ribbon-like and *top of frame*, and which the shape test alone therefore loves.
#
# A hard floor, not a weight: hair sits at cy/h ~ 0.15 and no amount of shape score should outvote "that is a
# head". When the whole picture really is legs (a close-up), the floor is below the frame's content anyway.
LEG_BAND_TOP = 0.30          # a limb's centre of mass must be below this fraction of the height
LEG_BAND_TOP_SOFT = 0.22     # between this and LEG_BAND_TOP it is allowed but strongly discounted


def _limb_candidates(rgb, k=8):
    """Points that plausibly sit on a *stockinged limb*, ranked.

    The tool textures knit fabric on legs. A leg in these pictures is a dark, low-chroma mass sitting in the
    lower part of the frame, and there are usually two of them roughly side by side. That is a much stronger
    signal than "nearest to the camera", and it costs no model: threshold the dark low-chroma pixels, take
    connected components, and keep the ones whose *position* is low and whose shape reads as a body — a limb
    or a pair of legs, never a scatter of print and never a head.

    Two shapes count, and both must be handled because the same pair of legs presents either way depending on
    the pose and on whether the crotch bridges them into one blob:

      * a single ribbon — one leg seen alone, or two legs the morphology has already separated: taller than
        wide, and its extent along the long axis is real;
      * a *pair* — two thighs joined at the crotch, which is wide rather than tall. This is the common case in
        the pictures this tool is for, and an earlier revision rejected it outright by demanding elong >= 1.25,
        which is why the whole lower body was thrown away and the prompt fell back to the frame centre.

    Position is what does the real work. Hair is dark, low-chroma and ribbon-like too, so a shape-only test
    puts a prompt on the sitter's head — which is exactly what an earlier revision did, and it textured the
    hair. Requiring the mass to sit below LEG_BAND_TOP removes that class of error outright.

    Returns a list of (x, y, score) in descending score order, one point per *leg* (a pair contributes two).
    """
    h, w = rgb.shape[:2]
    lab = cv2.cvtColor(rgb, cv2.COLOR_RGB2LAB).astype(np.float32)
    L, A, B = lab[..., 0], lab[..., 1] - 128, lab[..., 2] - 128
    chroma = np.hypot(A, B)
    # dark and not a saturated print; measured against the frame's own middle so it adapts to the art's exposure
    med = float(np.median(L))
    dark = (L < min(med - 8.0, DARK_L)) & (chroma < 46.0)
    dark = cv2.morphologyEx(dark.astype(np.uint8), cv2.MORPH_OPEN, np.ones((5, 5), np.uint8)).astype(bool)
    dark = cv2.morphologyEx(dark.astype(np.uint8), cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8)).astype(bool)
    n, labels, stats, cent = cv2.connectedComponentsWithStats(dark.astype(np.uint8), connectivity=8)
    frame = float(h * w)
    out = []
    for i in range(1, n):
        x, y, bw, bh, area = stats[i]
        if area < 0.006 * frame or area > 0.75 * frame:
            continue
        if bh < 40 or bw < 20:
            continue
        # a letterbox bar: it spans (nearly) the full height *and* sits against the left/right edge. These are
        # the black borders AI galleries add after upscaling a portrait, and they pass every shape test a leg
        # passes, so they have to be excluded by where they are rather than what they look like.
        if bh > 0.92 * h and (x <= 2 or x + bw >= w - 2):
            continue
        ys_, xs_ = np.nonzero(labels == i)
        if not len(ys_):
            continue
        # a bar across the top or bottom edge that hugs it is a frame, not legs
        if (y <= 2 or y + bh >= h - 2) and bw > 0.9 * w:
            continue
        # where the mass actually sits, weighted by how much of it is at each row (a bounding-box centre lies
        # when a piece is diagonal, which limbs are)
        cy_frac = float(ys_.mean()) / h
        if cy_frac < LEG_BAND_TOP_SOFT:
            continue                         # a head, a canopy, a high shelf of hair
        fill = area / float(bw * bh)
        elong = bh / max(bw, 1.0)
        ribbon = elong >= 1.25 and fill >= 0.28
        # a pair of legs joined at the crotch is *wide*, and its silhouette still fills its box reasonably
        pair = elong < 1.25 and fill >= 0.42
        if not (ribbon or pair):
            continue
        # a wide flat band across the whole frame is a shadow or a hem, not legs: a pair is at most ~3/4 wide
        if bw > 0.92 * w and bh < 0.55 * h:
            continue
        # an edge stripe: tall, thin and pressed against a side, it is a border or a curtain, not a leg
        if bw < 0.06 * w and (x <= 2 or x + bw >= w - 2):
            continue
        base = (min(elong, 6.0) / 6.0) * 0.20 + fill * 0.15 + max(0.0, cy_frac - 0.30) * 0.85
        if cy_frac < LEG_BAND_TOP:
            base *= 0.45                     # allowed, but a leg is not usually up there
        # the lower the mass reaches, the more likely it is the legs the stockings are on rather than a torso
        bottom_frac = (y + bh) / h
        base += 0.35 * max(0.0, bottom_frac - 0.75)
        if ribbon and bw < 0.035 * w and elong > 3.0:
            base *= 0.75                     # a hairline, not a limb a medial point is meaningful on
        pts = _mass_points(ys_, xs_, h, w, pair)
        for order, (px, py) in enumerate(pts):
            out.append((px, py, base * (1.0 - 0.12 * order)))
    out.sort(key=lambda t: -t[2])
    return out[:k]


def _mass_points(ys, xs, h, w, pair, spread=0.18):
    """Where inside one dark component to click: one point on its thickest row, or one per lobe when it is a pair.

    A single point on a merged pair of legs lands between them — on the crotch or the gap — so SAM is prompted
    there and returns one clump containing both. Splitting the component's own pixels into a left and a right
    lobe around its horizontal middle, and clicking the widest row of each, puts the prompt on an actual leg and
    is what finally gets both stockings in one pass.
    """
    rows = np.bincount(ys, minlength=h)
    ry = int(np.argmax(rows))
    row_xs = np.sort(xs[ys == ry])
    if len(row_xs) == 0:
        return []
    if not pair:
        return [(int(np.median(row_xs)), ry)]
    mid = float(np.median(row_xs))
    left = row_xs[row_xs < mid - spread * w * 0.5]
    right = row_xs[row_xs > mid + spread * w * 0.5]
    pts = []
    if len(left) >= 4:
        pts.append((int(np.median(left)), ry))
    if len(right) >= 4:
        pts.append((int(np.median(right)), ry))
    if len(pts) >= 2:
        return pts
    # the widest row does not separate cleanly (a skirt, a single column of pixels); fall back to the whole
    # component's left/right halves by centroid instead of by that one row
    mid = float(np.median(xs))
    a = xs < mid
    b = ~a
    if a.sum() >= 16 and b.sum() >= 16:
        return [(int(np.median(xs[a])), int(np.median(ys[a]))),
                (int(np.median(xs[b])), int(np.median(ys[b])))]
    return [(int(np.median(row_xs)), ry)]


def _pair_points(rgb, k=8):
    """Limb candidates, ordered so that the two legs of a pair are prompted first.

    A picture with stockings almost always has *two* legs, and finding only one leaves the other bare — visible,
    and reported by users as "it only did one". The candidates already carry one point per leg, so the ordering
    here is mostly a matter of ensuring the highest-scoring few — which are the legs — are the ones SAM sees,
    rather than a stray ribbon elsewhere in the frame.
    """
    cands = _limb_candidates(rgb, k=k)
    if not cands:
        return []
    return [(x, y) for x, y, _s in cands[:k]]


def _subject_points(disp, h, w, k, rgb=None):
    """Where to prompt SAM: limb-shaped masses first, depth only to break ties.

    This used to be "the nearest pixel in each band", which fails on exactly the pictures the tool is for — the
    nearest thing is a hand thrust at the viewer. The shape hypothesis leads now, and depth is used only to order
    points that the shape test already accepted.
    """
    if rgb is not None:
        pts = _pair_points(rgb, k=k)
        if pts:
            return pts
    # no usable shape signal: fall back to the depth-led points, then to a plain grid
    if disp is not None:
        return _depth_points(disp, h, w, k)
    return _grid_points(h, w, k)


def _depth_points(disp, h, w, k):
    """The nearest pixel within each of a few bands down the lower half of the frame."""
    lo = int(0.35 * h)
    ys = np.linspace(lo, h - 2, k).astype(int)
    out = []
    band = max((h - lo) // k, 4)
    for y in ys:
        y0, y1 = max(y - band // 2, 0), min(y + band // 2 + 1, h)
        vals = disp[y0:y1, :]
        if not np.isfinite(vals).any():
            continue
        i = int(np.nanargmax(vals))
        yy, xx = np.unravel_index(i, vals.shape)
        if vals[yy, xx] <= np.nanmedian(vals):
            continue
        out.append((xx, y0 + yy))
    return out


def _grid_points(h, w, k):
    out = []
    for f in np.linspace(0.45, 0.85, k):
        out.append((w * 0.5, h * f))
    return out


# ---------------------------------------------------------------------------- the SAM path


def sam_auto_masks(rgb, disparity=None, sam_service=None, max_points=8, cluster=False):
    """Parts found by prompting SAM at the points the shape hypothesis says are limbs.

    SAM does not answer with one mask; it answers with a *scale ladder* — at a point on a thigh it offers the
    lace top, the whole stocking, and the entire character, in that order, and its own "best" index is a guess
    that is frequently wrong (it returned the whole frame for this tool's own test art). So every proposal is
    scored here instead of trusted: the one that fills most of the frame is penalised, the one that is a speck
    is penalised, and a dark, low-chroma, shaded mask is preferred over a bright flat one. The best few per
    point survive, and the containment pass then removes the nested duplicates.

    Every returned mask is also checked against the frame's area: SAM happily returns the whole background as one
    segment, and a "body part" that is most of the picture poisons both the course field and the side estimate.

    cluster: join the accepted masks only while they are neighbours. A face, a hand and a skirt are three
    different things and merging them into one blob gives a region no course field can be solved on, so by
    default each accepted mask is kept as its own part and the solver decides per part whether it has geometry.

    Returns (parts, labels) or (None, None) when SAM is unusable, so the caller can fall back.
    """
    if sam_service is None:
        return None, None
    h, w = rgb.shape[:2]
    frame = float(h * w)
    pts = _subject_points(disparity, h, w, max_points, rgb=rgb)
    if not len(pts):
        return None, None
    masks = []
    tried = 0
    try:
        for x, y in pts:
            cand, best, _ = sam_service.candidates(rgb, float(x), float(y))
            tried += 1
            if not cand:
                continue
            scored = []
            for j, cm in enumerate(cand):
                m = np.asarray(cm, bool)
                frac = float(m.sum()) / frame
                if frac < MIN_SUBJECT_FRAC or frac > MAX_SUBJECT_FRAC:
                    continue
                # a leg is a large-ish but not frame-sized piece whose prompt point is actually inside it
                if not m[int(np.clip(y, 0, h - 1)), int(np.clip(x, 0, w - 1))]:
                    continue
                fabric = _looks_like_stocking(rgb, m)
                # size: a thigh on a standing figure is a few percent to a eighth of the frame. A piece past a
                # fifth is the torso, the whole costume, or the canvas, and must lose to a tighter proposal even
                # if it is dark — this is the single term that stops "textured the dress".
                if frac <= 0.20:
                    size_pref = 1.0 - abs(frac - 0.10) / 0.20
                else:
                    size_pref = -2.0 * (frac - 0.20) / 0.25
                s = (0.60 if fabric else 0.0) + 0.40 * size_pref + (0.10 if j == best else 0.0)
                scored.append((s, m, frac))
            if not scored:
                continue
            scored.sort(key=lambda t: -t[0])
            masks.append(scored[0][1])
            # keep the runner-up too when it is the same object at a finer scale; the containment pass merges
            if len(scored) > 1 and scored[1][0] > scored[0][0] - 0.12:
                masks.append(scored[1][1])
    except Exception as e:
        print(f'[stocking] SAM failed: {type(e).__name__}: {e}', flush=True)
        return None, None
    if not masks:
        return None, None
    out = []
    for m in masks:
        parts, _ = from_mask(m)
        out.extend(parts)
    if not out:
        return None, None
    # drop pieces that another accepted piece already contains (SAM's nested proposals for one object)
    out.sort(key=lambda p: -p.sum())
    kept = []
    for p in out:
        if any((p & q).sum() > 0.9 * p.sum() for q in kept):
            continue
        kept.append(p)
    # keep the ones that read as fabric; if that empties the list, keep them all and let the user prune
    fabric = [p for p in kept if _looks_like_stocking(rgb, p)]
    if fabric:
        kept = fabric
    labels = np.zeros((h, w), np.int32)
    for i, p in enumerate(kept, 1):
        labels[p] = i
    return kept, labels


def _looks_like_stocking(rgb, mask):
    """Is this piece plausibly stocking fabric rather than skin, a shirt, a dress or a background?

    A stocking is a *shaded, dark, low-chroma* surface: it carries the artist's lighting, so it is not flat, and
    it sits well below the picture's mid lightness. Testing those three together separates fabric from the things
    SAM happily hands back — a flat backdrop, a white shirt, a bare thigh — far more reliably than any one of them.

    The bar is deliberately strict about darkness, because the failure it guards against is not "missed a leg"
    but "textured the dress": a teal gown is low-chroma-ish and shaded, so it passes a loose test, and then the
    whole costume receives knit. Real stocking fabric in these illustrations sits far below the frame's own
    middle lightness, and that is the number used here — measured *against the frame*, not against a constant,
    so the same rule holds on a bright illustration and on a dark one.
    """
    m = np.asarray(mask, bool)
    n = int(m.sum())
    if n < 256:
        return False
    lab = cv2.cvtColor(rgb, cv2.COLOR_RGB2LAB).astype(np.float32)
    Lall = lab[..., 0]
    Lm, Am, Bm = Lall[m], lab[..., 1][m] - 128, lab[..., 2][m] - 128
    med_L = float(np.median(Lm))
    frame_med = float(np.median(Lall))
    # dark either in absolute terms, or clearly below the picture's own middle (a dark-mode illustration)
    if med_L > min(DARK_L, frame_med - 22.0):
        return False                          # a dress, a shirt, a wall, a pale thigh
    if float(np.median(np.hypot(Am, Bm))) > 46.0:
        return False                          # strongly coloured: a print, a logo, dyed hair
    p16, p84 = np.percentile(Lm, [16, 84])
    if float(p84 - p16) / 255.0 < 0.008:
        return False                          # one flat tone with no shading at all
    return True


MAX_REGION_FRAC = 0.45       # a "body part" bigger than this share of the frame is the frame, not a part
DARK_MAX = 150.0             # Lab L*: stockings are darker than this. A pale dress is not a stocking.


def colour_fallback(rgb, min_area_frac=MIN_AREA_FRAC, bands=6, max_region_frac=MAX_REGION_FRAC):
    """A conservative guess with no models at all: the largest smooth *dark* area of one colour in the lower frame.

    Stockings are painted as a big, fairly flat region of a single colour with a broad core, in the lower half of
    the picture, and they are nearly always darker than the skin, the background or a dress. Three things
    therefore have to hold, and any candidate failing one is dropped:

      * it sits below its own band's median lightness, so a pale dress on a pale background is not a candidate;
      * its lightness is under DARK_MAX, because the point of the tool is knit fabric, and its most visible effect
        is on the mid-to-dark tones the desktop tool's own strength model is tuned for;
      * it covers less than max_region_frac of the frame, since a part that is most of the picture means the
        guess swallowed the character.

    Working per band rather than once over the whole image is what makes this work on art where the background
    covers most of the canvas: a global histogram is dominated by the background, and a global chroma percentile
    collapses to zero on a nearly neutral picture, so both have to be measured locally.

    When nothing qualifies the answer is None, and the node says so. Guessing wrongly is much worse than not
    guessing: a wrong region textures a face or a dress.
    """
    h, w = rgb.shape[:2]
    frame = float(h * w)
    lab = cv2.cvtColor(rgb, cv2.COLOR_RGB2LAB).astype(np.float32)
    L, A, B = lab[..., 0], lab[..., 1] - 128, lab[..., 2] - 128
    chroma = np.hypot(A, B)
    lo = int(0.35 * h)
    best = None
    for b in range(bands):
        y0 = lo + (h - lo) * b // bands
        y1 = lo + (h - lo) * (b + 1) // bands
        if y1 - y0 < 8:
            continue
        Lb = L[y0:y1]
        cb = chroma[y0:y1]
        med = float(np.median(Lb))
        # below the band's own middle, dark enough to be fabric, not a saturated print
        cand = (Lb < med - 6) & (Lb < DARK_MAX) & (cb < max(float(np.percentile(cb, 60)), 6.0))
        if cand.sum() < 64:
            continue
        hist = np.bincount(np.clip(Lb[cand] / 3, 0, 85).astype(int), minlength=86).astype(np.float64)
        hist = np.convolve(hist, np.ones(7) / 7, mode='same')
        lv = float(np.argmax(hist)) * 3 + 1.5
        if lv >= DARK_MAX:
            continue
        m = np.zeros((h, w), bool)
        m[y0:y1] = cand & (np.abs(Lb - lv) < 26)
        if m.sum() < 64:
            continue
        parts, labels = from_mask(m, min_area_frac)
        if not parts:
            continue
        area = int(sum(p.sum() for p in parts))
        if area > max_region_frac * frame:
            continue
        if best is None or area > best[0]:
            best = (area, parts, labels)
    if best is None:
        return None
    return best[1], best[2]


# ---------------------------------------------------------------------------- node entry point
#
# The upstream package owns the SAM model as a process-wide service whose `candidates()` takes a *document*
# (it holds a cached embedding per picture). The point-selection logic above predates that split and takes a
# bare array. This adapter is the whole seam between them, so neither side has to know about the other.


def sam_auto(doc, disparity=None, max_points=8):
    """Regions for a Document, as (parts, labels), using the upstream SAM service.

    Returns ([], None) when SAM is unusable or finds nothing, so the caller can fall back to colour or simply
    tell the user to click.
    """
    from .upstream import sam as sam_mod

    rgb = np.ascontiguousarray(doc.art)
    if disparity is None:
        disparity = getattr(doc, 'disparity', None)

    class _Adapter:
        status = sam_mod.service.status
        error = sam_mod.service.error

        @staticmethod
        def candidates(rgb_arr, x, y):
            return sam_mod.service.candidates(doc, float(x), float(y))

    parts, labels = sam_auto_masks(rgb, disparity, _Adapter(), max_points=max_points)
    return parts or [], labels
