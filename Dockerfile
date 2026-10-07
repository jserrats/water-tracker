FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN apt-get update \
 && apt-get install -y --no-install-recommends tzdata \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
# rapidocr is installed without deps: it would pull the GUI build of OpenCV (needs X/GL libs).
# Its OCR models ship inside the wheel, so nothing is downloaded at runtime.
RUN pip install -r requirements.txt \
 && pip install --no-deps rapidocr-onnxruntime==1.4.4 \
 && python -c "from rapidocr_onnxruntime import RapidOCR; RapidOCR()"

COPY app/ /app/

RUN useradd --uid 1000 --create-home app && mkdir -p /data && chown app /data
USER app

ENV DATA_DIR=/data SEED_DIR=/seed
VOLUME /data
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz')" || exit 1
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers"]
