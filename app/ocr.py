"""Meter photo -> reading.

Pipeline: find text with RapidOCR (PaddleOCR models, bundled in the wheel, CPU
only, fully offline), keep the boxes that look like a run of counter digits,
re-read the best ones on an enlarged, contrast-normalised crop and score the
candidates. The counter is a row of drums: METER_INT_DIGITS black (m³) followed
by METER_DEC_DIGITS red (litres).
"""
import io
import logging
import os
import re
from datetime import datetime

import cv2
import numpy as np
from PIL import ExifTags, Image, ImageOps

try:
    import pillow_heif

    pillow_heif.register_heif_opener()
except ImportError:  # HEIC support is optional
    pass

log = logging.getLogger("water.ocr")

INT_DIGITS = int(os.environ.get("METER_INT_DIGITS", "5"))
DEC_DIGITS = int(os.environ.get("METER_DEC_DIGITS", "3"))
TOTAL_DIGITS = INT_DIGITS + DEC_DIGITS
MAX_SIDE = 1600

# Characters OCR commonly confuses with digits on drum counters.
LOOKALIKE = str.maketrans({"O": "0", "o": "0", "D": "0", "Q": "0", "I": "1", "l": "1", "|": "1",
                           "i": "1", "!": "1", "Z": "2", "z": "2", "S": "5", "s": "5", "B": "8",
                           "G": "6", "b": "6", "T": "7", "g": "9", "q": "9"})

_engine = None


def engine():
    global _engine
    if _engine is None:
        from rapidocr_onnxruntime import RapidOCR

        _engine = RapidOCR()
    return _engine


# ---------- image I/O ----------

def load_image(data: bytes) -> Image.Image:
    img = Image.open(io.BytesIO(data))
    img = ImageOps.exif_transpose(img).convert("RGB")
    img.thumbnail((MAX_SIDE, MAX_SIDE))
    return img


def save_jpeg(img: Image.Image, path: str):
    img.save(path, "JPEG", quality=85)


def exif_datetime(data: bytes):
    """EXIF capture time as naive local 'YYYY-MM-DDTHH:MM:SS', or None."""
    try:
        exif = Image.open(io.BytesIO(data)).getexif()
    except Exception:
        return None
    sub = exif.get_ifd(ExifTags.IFD.Exif)
    for raw in (sub.get(ExifTags.Base.DateTimeOriginal), sub.get(ExifTags.Base.DateTimeDigitized),
                exif.get(ExifTags.Base.DateTime)):
        if raw:
            try:
                return datetime.strptime(str(raw).strip("\x00 "), "%Y:%m:%d %H:%M:%S").isoformat()
            except ValueError:
                continue
    return None


_FILENAME_DT = re.compile(r"(20\d\d)[-_.]?(\d\d)[-_.]?(\d\d)[ _T-]?(\d\d)[.:_-]?(\d\d)[.:_-]?(\d\d)")


def datetime_from_filename(name: str):
    """Phones and chat apps encode the capture time in the name: IMG_20260920_125022, 2026-09-20 12.50.22 ..."""
    m = _FILENAME_DT.search(name)
    if not m:
        return None
    try:
        return datetime(*map(int, m.groups())).isoformat()
    except ValueError:
        return None


# ---------- OCR ----------

def _normalise(text: str) -> str:
    return re.sub(r"[\s.,:;'`\-_]", "", text.translate(LOOKALIKE))


def _looks_like_counter(text: str) -> bool:
    """Mostly digits and no real letters (serial numbers like J26OA120318 have some)."""
    t = _normalise(text)
    if len(t) < 3 or re.search(r"[A-Za-z]", t):
        return False
    return sum(c.isdigit() for c in t) >= max(3, len(t) - 2)


def _prep_variants(crop: np.ndarray):
    """The same crop at several heights, in colour and in gray. Each read gets some digits
    wrong in different ways (red drums especially); a vote across them is much steadier."""
    if crop.size == 0:
        return
    for height in (32, 48, 64, 96):
        f = height / crop.shape[0]
        s = cv2.resize(crop, None, fx=f, fy=f, interpolation=cv2.INTER_AREA if f < 1 else cv2.INTER_CUBIC)
        yield s
        yield cv2.cvtColor(cv2.cvtColor(s, cv2.COLOR_BGR2GRAY), cv2.COLOR_GRAY2BGR)


def _rec(crop: np.ndarray):
    """Recognition only (no detection) on an already tight crop."""
    if crop.size == 0:
        return "", 0.0
    res, _ = engine()(crop, use_det=False, use_cls=False, use_rec=True)
    if not res:
        return "", 0.0
    return res[0][0], float(res[0][1])


def _to_value(digits):
    if digits and len(digits) == TOTAL_DIGITS and digits.isdigit():
        return int(digits[:INT_DIGITS]) + int(digits[INT_DIGITS:]) / 10 ** DEC_DIGITS
    return None


def _boxes_from_det(arr: np.ndarray):
    res, _ = engine()(arr)
    out = []
    for box, text, conf in res or []:
        pts = np.array(box, dtype=np.float32)
        x0, y0 = pts.min(axis=0)
        x1, y1 = pts.max(axis=0)
        tl, tr = pts[0], pts[1]
        angle = float(np.degrees(np.arctan2(tr[1] - tl[1], tr[0] - tl[0])))
        out.append({"box": [float(x0), float(y0), float(x1), float(y1)], "text": text,
                    "conf": float(conf), "angle": angle})
    return out


def _merge_row(boxes):
    """Detection sometimes splits the black and red drums into two boxes; join neighbours on the same line."""
    merged = []
    for b in sorted(boxes, key=lambda b: b["box"][0]):
        if merged:
            m = merged[-1]
            mx0, my0, mx1, my1 = m["box"]
            x0, y0, x1, y1 = b["box"]
            h = max(my1 - my0, y1 - y0)
            same_line = abs((my0 + my1) / 2 - (y0 + y1) / 2) < h * 0.4
            if same_line and x0 - mx1 < h * 1.2:
                m["box"] = [min(mx0, x0), min(my0, y0), max(mx1, x1), max(my1, y1)]
                m["text"] += b["text"]
                m["conf"] = min(m["conf"], b["conf"])
                continue
        merged.append(dict(b))
    return merged


def _read_span(arr, box, seed_reads=()):
    """Read one counter-shaped box: several preprocessed reads, then a per-position vote.
    Positions nobody could read (e.g. a drum caught mid-roll) are re-read as a single cell."""
    H, W = arr.shape[:2]
    x0, y0, x1, y1 = box
    bh = y1 - y0
    px, py = int(bh * 0.15), int(bh * 0.1)  # tight: extra background hurts recognition a lot
    X0, Y0 = max(0, int(x0) - px), max(0, int(y0) - py)
    X1, Y1 = min(W, int(x1) + px), min(H, int(y1) + py)
    sub = arr[Y0:Y1, X0:X1]

    reads = list(seed_reads)
    for v in _prep_variants(sub):
        reads.append(_rec(v))

    votes = [dict() for _ in range(TOTAL_DIGITS)]
    used = []
    for text, conf in reads:
        t = _normalise(text)
        if len(t) != TOTAL_DIGITS or not _looks_like_counter(t):
            continue
        used.append((t, conf))
        for i, ch in enumerate(t):
            if ch.isdigit():
                votes[i][ch] = votes[i].get(ch, 0.0) + conf
    if not used:
        return None

    digits = []
    cell_w = (x1 - x0) / TOTAL_DIGITS
    for i, v in enumerate(votes):
        if v:
            digits.append(max(v, key=v.get))
            continue
        # Single-drum crop. Drums only move upwards, so a half-rolled one shows the lower digit on top.
        cx0 = max(0, int(x0 + i * cell_w - cell_w * 0.15))
        cx1 = min(W, int(x0 + (i + 1) * cell_w + cell_w * 0.15))
        cell = arr[Y0:Y1, cx0:cx1]
        found = None
        for var in _prep_variants(cell):
            t = _normalise(_rec(var)[0])
            if t[:1].isdigit():
                found = t[0]
                break
        if found is None:
            return None
        digits.append(found)

    agree = sum(max(v.values()) / sum(v.values()) if v else 0.0 for v in votes) / TOTAL_DIGITS
    conf = sum(c for _, c in used) / len(used)
    return "".join(digits), conf * agree, [r[0] for r in reads]


def read_meter(img: Image.Image, crop=None, previous=None):
    """Return {value, digits, confidence, box, candidates}. box/crop are (x, y, w, h) fractions."""
    arr = cv2.cvtColor(np.asarray(img), cv2.COLOR_RGB2BGR)
    H, W = arr.shape[:2]
    user = None
    if crop:
        x, y, w, h = crop
        user = (x * W, y * H, (x + w) * W, (y + h) * H)

    candidates, angle = _read(arr, user, previous)

    if abs(angle) > 2:
        # Tilted photo: level the counter row and read again. Axis-aligned crops of a slanted
        # row clip the top of some digits and the bottom of others.
        M = cv2.getRotationMatrix2D((W / 2, H / 2), angle, 1.0)
        level = cv2.warpAffine(arr, M, (W, H), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
        Minv = cv2.invertAffineTransform(M)
        more, _ = _read(level, _transform_box(M, user) if user else None, previous)
        for c in more:
            c["box"] = _transform_box(Minv, c["box"])
            c["score"] += 0.05  # prefer the levelled read when both agree on quality
        candidates += more

    candidates.sort(key=lambda c: c["score"], reverse=True)
    if candidates:
        log.info("OCR candidates (tilt %.1f°): %s", angle,
                 [(c["digits"], round(c["score"], 2), c["raw"]) for c in candidates])
    for c in candidates:
        x0, y0, x1, y1 = c["box"]
        x0, y0, x1, y1 = max(0, x0), max(0, y0), min(W, x1), min(H, y1)
        c["box"] = (x0 / W, y0 / H, (x1 - x0) / W, (y1 - y0) / H)
    return _result(candidates[0] if candidates else None, candidates)


def _transform_box(M, box):
    """Bounding box of an (x0, y0, x1, y1) rectangle after an affine transform."""
    x0, y0, x1, y1 = box
    pts = np.array([[x0, y0, 1], [x1, y0, 1], [x1, y1, 1], [x0, y1, 1]], dtype=np.float64) @ M.T
    return [float(pts[:, 0].min()), float(pts[:, 1].min()), float(pts[:, 0].max()), float(pts[:, 1].max())]


def _read(arr, user, previous):
    """Candidates (boxes in pixels) and the tilt of the most counter-like text row."""
    H, W = arr.shape[:2]
    region, rx, ry = arr, 0, 0
    if user:
        # People draw tight boxes; detection needs some context around the text to fire.
        mx, my = (user[2] - user[0]) * 0.25, (user[3] - user[1]) * 0.5
        rx, ry = int(max(0, user[0] - mx)), int(max(0, user[1] - my))
        region = arr[ry:int(min(H, user[3] + my)), rx:int(min(W, user[2] + mx))]
        if region.size == 0:
            return [], 0.0

    spans, angle, angle_len = [], 0.0, 0
    for d in _merge_row(_boxes_from_det(region)):
        if not _looks_like_counter(d["text"]):
            continue  # serial numbers, brand names, labels...
        x0, y0, x1, y1 = d["box"]
        x0, x1, y0, y1 = x0 + rx, x1 + rx, y0 + ry, y1 + ry
        if user and not (user[0] <= (x0 + x1) / 2 <= user[2] and user[1] <= (y0 + y1) / 2 <= user[3]):
            continue
        n = len(_normalise(d["text"]))
        if n > angle_len:
            angle, angle_len = d["angle"], n
        if n < TOTAL_DIGITS:
            # Red litre drums often aren't detected: extend the box to the right to cover them.
            x1 = min(W, x0 + (x1 - x0) / n * TOTAL_DIGITS * 1.04)
        spans.append(([x0, y0, x1, y1], [(d["text"], d["conf"])] if n == TOTAL_DIGITS else []))
    if user:
        # Fallback: read the user's box as one line of text.
        spans.append((list(user), []))

    candidates = []
    for box, seed in spans:
        r = _read_span(arr, box, seed)
        if not r:
            continue
        digits, conf, raw = r
        value = _to_value(digits)
        score = conf
        if previous is not None and value is not None:
            # Meters only count up, and rarely by more than a few m³ between photos.
            score += 0.5 if -0.002 <= value - previous <= 100 else -0.5
        candidates.append({"digits": digits, "value": value, "conf": conf, "score": score,
                           "raw": raw, "box": box})
    return candidates, angle


def _result(best, candidates):
    return {
        "value": best["value"] if best else None,
        "digits": best["digits"] if best else None,
        "confidence": round(best["conf"], 3) if best else 0.0,
        "box": best["box"] if best else None,
        "candidates": [{"digits": c["digits"], "value": c["value"], "score": round(c["score"], 3)}
                       for c in candidates[:5]],
    }
