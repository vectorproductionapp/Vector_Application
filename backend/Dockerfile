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

# Never run the API as root.
RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin vector \
    && chown -R vector:vector /app
USER vector

EXPOSE 8080

# Gunicorn, gthread workers (implied by --threads) so flask-sock can complete
# the /ws WebSocket upgrade.
#
#   --workers 1   realtime.py broadcasts in-process: the socket set that gets
#                 the "something changed" notice and the request that writes
#                 the change must live in the same worker, otherwise roughly
#                 half of the notifications are silently dropped.  Raise it
#                 with WEB_CONCURRENCY only if you first move broadcasts onto
#                 a shared broker (Firestore pub/sub, Redis, ...).
#   --threads 16  every held WebSocket occupies one thread, so the per-worker
#                 thread pool is what the API actually runs on.
#   --timeout 0   a silent-but-connected WebSocket must never be reaped.
CMD exec gunicorn \
      --bind :${PORT} \
      --workers ${WEB_CONCURRENCY:-1} \
      --threads ${GUNICORN_THREADS:-16} \
      --timeout ${GUNICORN_TIMEOUT:-0} \
      app:app
