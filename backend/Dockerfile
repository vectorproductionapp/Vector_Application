# Cloud Run backend image (blue/green compatible).
#
# The image is environment-agnostic and contains no configuration: APP_ENV,
# JWT_SECRET, CORS_ORIGINS, FIREBASE_STORAGE_BUCKET, the SMTP/Graph credentials
# and the Firebase/Google credentials all come from Cloud Run environment
# variables or Secret Manager references at deploy time.  `backend/.dockerignore`
# keeps every .env file, every *.json service-account key and every log out of
# this image, so a locally saved `vector_prod.json` can never ship.

FROM python:3.12-slim

# Cloud Run supplies PORT at runtime; the default only matters for local runs.
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PORT=8080

WORKDIR /app

# Dependencies first so a source-only change reuses this layer.
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Runtime payload only (see .dockerignore).
COPY . ./

# Refuse to build an image that cannot start: imports the whole app (Firebase
# mocked, no credentials needed) plus the lazily imported packages.  A missing
# package fails here instead of crash-looping on Cloud Run.
RUN python check_imports.py

# Never run the API as root.
RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin vector \
    && chown -R vector:vector /app
USER vector

EXPOSE 8080

# Gunicorn with one process and a small thread pool.
#
#   --workers 1   one process per instance keeps memory inside 512Mi and the
#                 dashboard memory cache (read_cache.py) shared by all threads.
#   --threads 8   requests are short (no WebSocket any more); Cloud Run
#                 --concurrency 40 lets extra requests queue here briefly
#                 instead of starting a second instance.
#   --timeout 0   Cloud Run's own request timeout (--timeout) is the limit.
CMD exec gunicorn \
      --bind :${PORT} \
      --workers ${WEB_CONCURRENCY:-1} \
      --threads ${GUNICORN_THREADS:-8} \
      --timeout ${GUNICORN_TIMEOUT:-0} \
      app:app
