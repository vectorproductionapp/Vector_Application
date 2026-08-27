import os
from pathlib import Path

from dotenv import load_dotenv


environment = os.getenv("APP_ENV", "development").lower()
env_filename = ".env.production" if environment == "production" else ".env"
load_dotenv(Path(__file__).resolve().parent / env_filename)

from __init__ import create_app


app = create_app()

if __name__ == "__main__":
    app.run(
        host=os.getenv("HOST", "0.0.0.0"),
        port=int(os.getenv("PORT", "5003")),
        debug=os.getenv("DEBUG", "").lower() == "true"
    )
