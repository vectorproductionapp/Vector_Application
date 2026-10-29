
import os
import logging
import re
import time

from flask import Flask, g, request
from flask_cors import CORS
from read_cache import invalidate_read_cache
from realtime import attach, record_change, scope_for_path

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
from documents import documents_bp
from daily_report import daily_report_bp, start_scheduler
from weekly_stock_report import weekly_stock_report_bp


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
        # stale.  Versioning avoids deleting large cache collections, and the
        # same moment is pushed to open browsers over the WebSocket so only the
        # affected view refreshes (no page reload, no polling).
        if (
            request.method in {"POST", "PUT", "PATCH", "DELETE"}
            and response.status_code < 400
            and not request.path.startswith(("/login", "/forgot-password", "/account/change-password"))
        ):
            invalidate_read_cache()
            actor = getattr(getattr(request, "user", None) or {}, "email", "")
            record_change(
                scope_for_path(request.path),
                action=request.method.lower(),
                actor=actor,
            )
        return response

    @app.get("/health")
    def health_check():
        return {"status": "ok"}, 200

    # Exact origins only - never "*".  A value containing *, ^, $, [ or ( is
    # treated as a regular expression by Flask-CORS, which is how the optional
    # preview-channel entry below is expressed.
    allowed_origins = [
        origin.strip()
        for origin in os.getenv(
            "CORS_ORIGINS",
            "https://vector-application-531004235498.asia-south1.run.app,"
            "https://vector-production-506505.web.app,"
            "https://production.vector-power.com,"
            "http://localhost:3001,"
            "http://localhost:3002"
        ).split(",")
        if origin.strip()
    ]

    # Optional, off by default: let THIS project's Firebase Hosting preview
    # channels through so a green frontend can be validated before promotion.
    #
    # Preview URLs are https://<siteId>--<channelId>-<hash>.web.app, and
    # <siteId> is the globally unique Firebase project id, so scoping the
    # pattern to it can only ever match this project's own preview channels -
    # it is deliberately not a *.web.app wildcard, which anyone could satisfy
    # by creating their own Firebase project.
    if os.getenv("CORS_ALLOW_PREVIEW_CHANNELS", "").strip().lower() in {"1", "true", "yes"}:
        site_id = (
            os.getenv("FIREBASE_SITE_ID", "").strip()
            or os.getenv("FIREBASE_PROJECT_ID", "").strip()
        )
        if site_id:
            allowed_origins.append(
                rf"^https://{re.escape(site_id)}--[a-z0-9-]+\.web\.app$"
            )
        else:
            logger.warning(
                "CORS_ALLOW_PREVIEW_CHANNELS is set but FIREBASE_SITE_ID/FIREBASE_PROJECT_ID "
                "is empty; preview origins were NOT added to CORS"
            )

    CORS(
        app,
        resources={r"/*": {"origins": allowed_origins}},
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
    app.register_blueprint(documents_bp)
    app.register_blueprint(daily_report_bp)
    app.register_blueprint(weekly_stock_report_bp)
    # Daily director report: checks once a minute, sends once per working day.
    start_scheduler()

    # Live updates: a WebSocket at /ws that pushes "something changed" notices,
    # so open pages refresh only their own view instead of polling or reloading.
    attach(app)
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
