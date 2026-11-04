import os
from pathlib import Path

from dotenv import load_dotenv


environment = os.getenv("APP_ENV", "development").lower()
env_filename = ".env.production" if environment == "production" else ".env"
load_dotenv(Path(__file__).resolve().parent / env_filename)

from __init__ import create_app


app = create_app()

if __name__ == "__main__":
    host = os.getenv("HOST", "0.0.0.0")
    port = int(os.getenv("PORT", "5000"))
    # Cloud Scheduler cannot reach a local server, so `python app.py` checks
    # the report emails itself every minute (LOCAL_REPORT_SCHEDULER=off to stop).
    from report_runs import start_local_ticker
    start_local_ticker()
    app.run(host=host, port=port, threaded=True)
