# Water tracker

Self-hosted, phone-friendly web app to track a water meter from photos.

- 📷 **Take photo**: opens the phone camera, OCRs the counter, you confirm, saved.
- 🖼️ **Upload photo**: same, with the date taken from EXIF (then from the file name, e.g.
  `IMG_20260920_125022.jpg`, then from the file's modified time). It's editable before saving.
- ✏️ **Manual entry**, and edit/delete any reading.
- Usage chart (litres per hour/day/week/month) and meter chart, with 24h/7d/30d/90d/1y/All ranges.
  Pinch or scroll to zoom, and use the slider to pan.
- **Export CSV** button in the header (`/api/readings.csv`).
- Runs fully offline: the OCR models (RapidOCR / PaddleOCR ONNX) ship inside the image, and the
  chart library is vendored in `app/static/vendor/`. Nothing is fetched from the internet at runtime.

## Run

```sh
docker compose up -d
```

Open `http://<host>:8080` from your phone. The image is built by GitHub Actions
(`.github/workflows/docker.yml`) for amd64 and arm64 and published to
`ghcr.io/jserrats/water-tracker`:

| Event                | Tags pushed                         |
| -------------------- | ----------------------------------- |
| push to `main`       | `latest`, `sha-<short>`             |
| tag `v1.2.3`         | `1.2.3`, `1.2`, `sha-<short>`       |
| pull request         | built only, not pushed              |

Pin a version in `docker-compose.yml` instead of `latest` if you prefer. Pulling needs internet,
but running does not. For a host with no internet at all, pull elsewhere and copy the image:
`docker save ghcr.io/jserrats/water-tracker:latest | ssh host docker load`.

To build locally instead: `docker build -t ghcr.io/jserrats/water-tracker:latest .`

On first boot with an empty database, every photo in `./pics` is OCR'd and added as a reading.
Photos with no readable counter are skipped. This happens only once. Remove the `./pics` mount
in `docker-compose.yml` to start empty. The container runs as uid 1000, so on a Linux host make
the photos readable first (`chmod a+r pics/*`).

### Configuration (environment)

| Variable           | Default         | Meaning                                                 |
| ------------------ | --------------- | ------------------------------------------------------- |
| `TZ`               | `Europe/Madrid` | Time zone used for EXIF times (EXIF has no zone)        |
| `METER_INT_DIGITS` | `5`             | Black drums (whole m³)                                  |
| `METER_DEC_DIGITS` | `3`             | Red drums (litres)                                      |

Data (SQLite + photos) lives in the `water-data` volume.
Back it up with `docker compose cp water-tracker:/data ./backup`.

## OCR tips

- Fill the frame with the counter and avoid glare on the glass.
- If the reading is wrong, drag a rectangle around the digits on the photo and tap **Read again**.
  A tight crop is much more reliable.
- Always check the value before saving. The app warns you when a reading is lower than the
  previous one, or implies an implausible flow.

The camera button uses the browser's native file picker (`capture="environment"`). It works over
plain HTTP on the LAN; a live in-page viewfinder would need HTTPS.

Check the OCR against the sample photos:

```sh
docker compose run --rm -v ./tests:/tests water-tracker python /tests/check_ocr.py
```
