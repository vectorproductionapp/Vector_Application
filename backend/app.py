import os
from pathlib import Path

from dotenv import load_dotenv


environment = os.getenv("APP_ENV", "development").lower()
env_filename = ".env.production" if environment == "production" else ".env"
load_dotenv(Path(__file__).resolve().parent / env_filename)

from __init__ import create_app
from realtime import run as run_with_realtime


app = create_app()

if __name__ == "__main__":
    host = os.getenv("HOST", "0.0.0.0")
    port = int(os.getenv("PORT", "5000"))
    # `run_with_realtime` serves Flask's routes and the /ws WebSocket from the
    # same port: Werkzeug's own server cannot upgrade connections, and polling
    # has been replaced by these live updates.
    run_with_realtime(app, host=host, port=port)
