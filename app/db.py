import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone

DATA_DIR = os.environ.get("DATA_DIR", "/data")
DB_PATH = os.path.join(DATA_DIR, "water.db")
IMAGE_DIR = os.path.join(DATA_DIR, "images")

SCHEMA = """
CREATE TABLE IF NOT EXISTS readings (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ts         TEXT NOT NULL,          -- ISO 8601, UTC
    value      REAL NOT NULL,          -- cubic metres
    source     TEXT NOT NULL,          -- camera | upload | manual | seed
    image      TEXT,                   -- file name inside IMAGE_DIR
    ocr_raw    TEXT,
    note       TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX IF NOT EXISTS readings_ts ON readings(ts);
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT
);
"""


def init():
    os.makedirs(IMAGE_DIR, exist_ok=True)
    with connect() as conn:
        conn.executescript(SCHEMA)


@contextmanager
def connect():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def get_meta(key):
    with connect() as conn:
        row = conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
        return row["value"] if row else None


def set_meta(key, value):
    with connect() as conn:
        conn.execute(
            "INSERT INTO meta(key, value) VALUES(?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, value),
        )


def utc_iso(ts: datetime) -> str:
    """Normalise to 'YYYY-MM-DDTHH:MM:SSZ'. Naive datetimes are taken as server local time (TZ)."""
    if ts.tzinfo is None:
        ts = ts.astimezone()
    return ts.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
