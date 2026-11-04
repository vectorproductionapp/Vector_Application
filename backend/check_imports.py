"""Fail the build if the app cannot be imported.

Runs inside `docker build` (see Dockerfile) and in CI, so an image with a
missing package (e.g. openpyxl) is never deployed and never crash-loops on
Cloud Run.  Firebase is replaced by mocks so no Google credentials or network
are needed; every other import is real.

    python check_imports.py
"""

import importlib
import os
import sys
from unittest import mock

# Packages imported lazily inside functions: `import app` alone would not
# notice if they were missing.
LAZY_IMPORTS = (
    "openpyxl", "openpyxl.styles", "openpyxl.utils", "flask_compress", "firebase_admin.auth",
    "google.oauth2.id_token", "google.auth.transport.requests",
)


def main():
    os.environ.setdefault("JWT_SECRET", "import-check-only")
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

    import firebase_admin
    from firebase_admin import firestore, storage

    with mock.patch.object(firebase_admin, "initialize_app"), \
            mock.patch.object(firebase_admin, "_apps", {"import-check": object()}), \
            mock.patch.object(firestore, "client", return_value=mock.MagicMock()), \
            mock.patch.object(storage, "bucket", return_value=mock.MagicMock()):
        app_module = importlib.import_module("app")
        for name in LAZY_IMPORTS:
            importlib.import_module(name)

    rules = {rule.rule for rule in app_module.app.url_map.iter_rules()}
    for required in ("/health", "/dashboard", "/realtime/token", "/internal/reports/run"):
        if required not in rules:
            raise SystemExit(f"route {required} is not registered")
    print(f"import check OK: {len(rules)} routes")


if __name__ == "__main__":
    main()
