
import os
import logging
import time

from flask import Flask, g, request
from flask_cors import CORS
from read_cache import invalidate_read_cache

from login import login_bp
from adminlogin import admin_login_bp
from adminusers import admin_users_bp
from signup import signup_bp
from models import models_bp
from defective import defects_bp
from podetails import podetails_bp
from salesregister import saleregister_bp
from dailyproduction import dailyproduction_bp
from invoice import invoice_bp
from stockregister import stockregister_bp
from dashboard import dashboard_bp
from forgot_password import forgot_password_bp


def create_app():

    app = Flask(__name__)
    logger = logging.getLogger("vector.performance")

    @app.before_request
    def _start_request_timer():
        g.request_started_at = time.perf_counter()

    @app.after_request
    def _log_request_timing(response):
        started_at = getattr(g, "request_started_at", None)
        if started_at is None:
            return response
        elapsed_ms = (time.perf_counter() - started_at) * 1000
        auth_ms = getattr(g, "auth_duration_ms", 0.0)
        response.headers["Server-Timing"] = f"app;dur={elapsed_ms:.1f}, auth;dur={auth_ms:.1f}"
        # Keep normal Cloud Run logs concise; surface every slow API request.
        if elapsed_ms >= 500:
            logger.warning("slow_request method=%s path=%s status=%s total_ms=%.1f auth_ms=%.1f",
                           request.method, request.path, response.status_code, elapsed_ms, auth_ms)
        # Any successful data write makes every derived list/dashboard snapshot
        # stale.  Versioning avoids deleting large cache collections.
        if (
            request.method in {"POST", "PUT", "PATCH", "DELETE"}
            and response.status_code < 400
            and not request.path.startswith(("/login", "/forgot-password", "/account/change-password"))
        ):
            invalidate_read_cache()
        return response

    @app.get("/health")
    def health_check():
        return {"status": "ok"}, 200

    allowed_origins = os.getenv(
        "CORS_ORIGINS",
        "https://vector-app-884203903500.asia-south1.run.app,"
        "https://production.vector-power.com,"
        "http://localhost:3001,"
        "http://localhost:3002"
    ).split(",")

    CORS(
        app,
        resources={r"/*": {"origins": [origin.strip() for origin in allowed_origins]}},
    )

    app.register_blueprint(login_bp)
    app.register_blueprint(admin_login_bp)
    app.register_blueprint(admin_users_bp)
    app.register_blueprint(signup_bp)
    app.register_blueprint(models_bp)
    app.register_blueprint(defects_bp)
    app.register_blueprint(podetails_bp)
    app.register_blueprint(saleregister_bp)
    app.register_blueprint(dailyproduction_bp)
    app.register_blueprint(invoice_bp)
    app.register_blueprint(stockregister_bp)
    app.register_blueprint(dashboard_bp)
    app.register_blueprint(forgot_password_bp)
    return app


# ---------------------------------------------------------------------------
# How to protect a route in any other blueprint (models.py, invoice.py, etc):
#
#   from auth_utils import roles_required
#
#   @models_bp.route("/models", methods=["GET"])
#   @roles_required("admin", "coadmin")          # only these roles pass
#   def get_models():
#       ...
#
# Or, to allow "coadmin and above" without listing every role:
#
#   from auth_utils import min_role_required
#
#   @models_bp.route("/models", methods=["POST"])
#   @min_role_required("coadmin")                # coadmin + admin pass
#   def create_model():
#       ...
#
# Inside a protected view you can read who's calling via request.user, e.g.
# request.user["role"], request.user["email"], request.user["sub"].
# ---------------------------------------------------------------------------
