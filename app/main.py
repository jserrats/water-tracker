import csv
import io
import logging
import os
import uuid
from contextlib import asynccontextmanager
from datetime import datetime

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

import db
import ocr
import seed

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("water")

STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")
MAX_UPLOAD_BYTES = 25 * 1024 * 1024


@asynccontextmanager
async def lifespan(_app):
    db.init()
    seed.run_once()
    yield


app = FastAPI(title="Water Tracker", lifespan=lifespan)


class ReadingIn(BaseModel):
    ts: datetime
    value: float = Field(ge=0)
    source: str = Field(default="manual", pattern="^(camera|upload|manual)$")
    image: str | None = None
    ocr_raw: str | None = None
    note: str | None = Field(default=None, max_length=500)


def row_to_dict(row):
    return {k: row[k] for k in row.keys()}


def check_image_name(name):
    # Only accept names we generated ourselves; never a path.
    if name is None:
        return None
    if os.path.basename(name) != name or not os.path.isfile(os.path.join(db.IMAGE_DIR, name)):
        raise HTTPException(400, "unknown image")
    return name


@app.get("/api/readings")
def list_readings():
    with db.connect() as conn:
        rows = conn.execute("SELECT * FROM readings ORDER BY ts, id").fetchall()
    return [row_to_dict(r) for r in rows]


@app.post("/api/readings", status_code=201)
def create_reading(r: ReadingIn):
    image = check_image_name(r.image)
    with db.connect() as conn:
        cur = conn.execute(
            "INSERT INTO readings(ts, value, source, image, ocr_raw, note) VALUES (?,?,?,?,?,?)",
            (db.utc_iso(r.ts), r.value, r.source, image, r.ocr_raw, r.note),
        )
        row = conn.execute("SELECT * FROM readings WHERE id = ?", (cur.lastrowid,)).fetchone()
    return row_to_dict(row)


class ReadingPatch(BaseModel):
    ts: datetime | None = None
    value: float | None = Field(default=None, ge=0)
    note: str | None = Field(default=None, max_length=500)


@app.patch("/api/readings/{rid}")
def update_reading(rid: int, p: ReadingPatch):
    fields, args = [], []
    if p.ts is not None:
        fields.append("ts = ?"); args.append(db.utc_iso(p.ts))
    if p.value is not None:
        fields.append("value = ?"); args.append(p.value)
    if p.note is not None:
        fields.append("note = ?"); args.append(p.note)
    with db.connect() as conn:
        if fields:
            conn.execute(f"UPDATE readings SET {', '.join(fields)} WHERE id = ?", (*args, rid))
        row = conn.execute("SELECT * FROM readings WHERE id = ?", (rid,)).fetchone()
    if not row:
        raise HTTPException(404, "not found")
    return row_to_dict(row)


@app.delete("/api/readings/{rid}", status_code=204)
def delete_reading(rid: int):
    with db.connect() as conn:
        row = conn.execute("SELECT image FROM readings WHERE id = ?", (rid,)).fetchone()
        if not row:
            raise HTTPException(404, "not found")
        conn.execute("DELETE FROM readings WHERE id = ?", (rid,))
        still_used = row["image"] and conn.execute(
            "SELECT 1 FROM readings WHERE image = ?", (row["image"],)
        ).fetchone()
    if row["image"] and not still_used:
        try:
            os.remove(os.path.join(db.IMAGE_DIR, row["image"]))
        except FileNotFoundError:
            pass


@app.get("/api/readings.csv")
def export_csv():
    with db.connect() as conn:
        rows = conn.execute(
            "SELECT id, ts, value, source, note FROM readings ORDER BY ts, id"
        ).fetchall()
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["id", "timestamp_utc", "reading_m3", "source", "note"])
    for r in rows:
        w.writerow([r["id"], r["ts"], f"{r['value']:.3f}", r["source"], r["note"] or ""])
    name = f"water-readings-{datetime.now().strftime('%Y%m%d')}.csv"
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{name}"'},
    )


@app.post("/api/ocr")
async def run_ocr(
    file: UploadFile | None = File(default=None),
    image: str | None = Form(default=None),  # re-read a previously uploaded image
    crop: str | None = Form(default=None),  # "x,y,w,h" as fractions of the (rotated) image
):
    box = None
    if crop:
        try:
            box = tuple(float(v) for v in crop.split(","))
            assert len(box) == 4 and all(0 <= v <= 1 for v in box)
        except Exception:
            raise HTTPException(400, "crop must be four fractions x,y,w,h")

    if image:
        image_name = check_image_name(image)
        with open(os.path.join(db.IMAGE_DIR, image_name), "rb") as f:
            img = ocr.load_image(f.read())
        taken_at = None
    elif file:
        data = await file.read(MAX_UPLOAD_BYTES + 1)
        if len(data) > MAX_UPLOAD_BYTES:
            raise HTTPException(413, "image too large")
        try:
            img = ocr.load_image(data)
        except Exception:
            raise HTTPException(400, "could not decode image")
        seed.cleanup_orphan_images()
        image_name = f"{uuid.uuid4().hex}.jpg"
        ocr.save_jpeg(img, os.path.join(db.IMAGE_DIR, image_name))
        taken_at = ocr.exif_datetime(data) or ocr.datetime_from_filename(file.filename or "")
    else:
        raise HTTPException(400, "send a file or an image name")

    # OCR is CPU-bound; keep the event loop responsive.
    result = await run_in_threadpool(ocr.read_meter, img, crop=box, previous=last_value())
    return {"image": image_name, "taken_at": taken_at, **result}


def last_value():
    with db.connect() as conn:
        row = conn.execute("SELECT value FROM readings ORDER BY ts DESC, id DESC LIMIT 1").fetchone()
    return row["value"] if row else None


@app.get("/api/images/{name}")
def get_image(name: str):
    check_image_name(name)
    return FileResponse(os.path.join(db.IMAGE_DIR, name), media_type="image/jpeg")


@app.get("/healthz")
def healthz():
    return {"ok": True}


class RevalidatingStaticFiles(StaticFiles):
    """Make browsers re-check (cheap 304s via ETag) so an upgrade never pairs old HTML with new JS."""

    def file_response(self, *args, **kwargs):
        resp = super().file_response(*args, **kwargs)
        resp.headers["Cache-Control"] = "no-cache"
        return resp


app.mount("/", RevalidatingStaticFiles(directory=STATIC_DIR, html=True), name="static")
