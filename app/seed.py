"""Populate an empty database from the photos in SEED_DIR, once."""
import logging
import os
import time
import uuid
from datetime import datetime

import db
import ocr

log = logging.getLogger("water.seed")
SEED_DIR = os.environ.get("SEED_DIR", "/seed")
IMAGE_EXT = {".jpg", ".jpeg", ".png", ".webp", ".heic"}


def run_once():
    cleanup_orphan_images()
    if db.get_meta("seeded"):
        return
    with db.connect() as conn:
        has_rows = conn.execute("SELECT 1 FROM readings LIMIT 1").fetchone()
    if has_rows or not os.path.isdir(SEED_DIR):
        db.set_meta("seeded", "skipped")
        return

    files = sorted(
        os.path.join(SEED_DIR, f) for f in os.listdir(SEED_DIR)
        if os.path.splitext(f)[1].lower() in IMAGE_EXT
    )
    log.info("Seeding from %d photo(s) in %s", len(files), SEED_DIR)

    # Read every photo first, then insert in time order so the plausibility
    # check (readings never go down) compares against the right neighbour.
    found = []
    for path in files:
        name = os.path.basename(path)
        try:
            with open(path, "rb") as f:
                data = f.read()
            img = ocr.load_image(data)
        except PermissionError:
            log.warning("  %s: not readable by uid %d (try: chmod a+r on the host)", name, os.getuid())
            continue
        except Exception as e:
            log.warning("  %s: cannot decode (%s)", name, e)
            continue
        taken = (
            ocr.exif_datetime(data)
            or ocr.datetime_from_filename(name)
            or datetime.fromtimestamp(os.path.getmtime(path)).strftime("%Y-%m-%dT%H:%M:%S")
        )
        res = ocr.read_meter(img)
        if res["value"] is None:
            log.info("  %s: no meter reading found, skipped", name)
            continue
        log.info("  %s: %s -> %.3f m3 at %s", name, res["digits"], res["value"], taken)
        found.append((taken, res, img, name))

    found.sort(key=lambda x: x[0])
    with db.connect() as conn:
        for taken, res, img, name in found:
            image_name = f"{uuid.uuid4().hex}.jpg"
            ocr.save_jpeg(img, os.path.join(db.IMAGE_DIR, image_name))
            conn.execute(
                "INSERT INTO readings(ts, value, source, image, ocr_raw, note) VALUES (?,?,?,?,?,?)",
                (db.utc_iso(datetime.fromisoformat(taken)), res["value"], "seed",
                 image_name, res["digits"], f"seeded from {name}"),
            )
    db.set_meta("seeded", str(len(found)))
    log.info("Seeded %d reading(s)", len(found))


def cleanup_orphan_images(max_age_s=24 * 3600):
    """Delete photos that were OCR'd but never saved as a reading."""
    with db.connect() as conn:
        used = {r["image"] for r in conn.execute("SELECT image FROM readings WHERE image IS NOT NULL")}
    now = time.time()
    for f in os.listdir(db.IMAGE_DIR):
        p = os.path.join(db.IMAGE_DIR, f)
        if f not in used and now - os.path.getmtime(p) > max_age_s:
            os.remove(p)
