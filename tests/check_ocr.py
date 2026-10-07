"""Run the OCR over the sample photos and compare with known readings.

    docker compose run --rm -v ./tests:/tests water-tracker python /tests/check_ocr.py
"""
import os
import sys

sys.path.insert(0, os.environ.get("APP_DIR", "/app"))
import ocr  # noqa: E402

PICS = os.environ.get("SEED_DIR", "/seed")
# name: (expected m³, tolerance)
EXPECTED = {
    "2026-09-20 12.50.22.jpg": (None, 0),           # radio module label, no counter
    "2026-09-20 12.50.33.jpg": (None, 0),           # radio module label, no counter
    "2026-09-20 12.50.36.jpg": (142.738, 0),
    "photo_2026-09-20 17.06.53.jpeg": (142.776, 0.009),  # last drum caught mid-roll (6 -> 7)
    "photo_2026-09-20 17.06.56.jpeg": (142.760, 0),
}

failed = 0
for name, (want, tol) in EXPECTED.items():
    with open(os.path.join(PICS, name), "rb") as f:
        data = f.read()
    res = ocr.read_meter(ocr.load_image(data))
    ok = res["value"] == want if want is None else res["value"] is not None and abs(res["value"] - want) <= tol + 1e-6
    failed += not ok
    print(f"{'OK  ' if ok else 'FAIL'} {name}: got {res['digits']} -> {res['value']}, want {want}"
          f"  date={ocr.exif_datetime(data) or ocr.datetime_from_filename(name)}")
    if not ok:
        print("     candidates:", res["candidates"])
sys.exit(1 if failed else 0)
