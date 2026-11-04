"""Scheduled report emails, run by Cloud Scheduler.
 
Cloud Scheduler calls ``POST /internal/reports/run`` every minute, all day
(Asia/Kolkata).  Each call checks both reports and sends the ones that are
due, synchronously, before it answers.  Any send time works: the email goes
out at the first run at or after it, i.e. within a minute.
 
A run with nothing due is cheap: one Firestore read (the settings), Google's
token-signing keys from memory (see _CachingRequest), and no log line.  Nothing runs in the
background, so nothing depends on an instance staying alive.
 
Due
    Daily:  the report is on, it has recipients, today (IST) is a working,
            non-holiday day, and the time now is at or after the configured
            send time.
    Weekly: the weekly report is on, it has recipients, today is this ISO
            week's send day (the configured weekday, or the next working day
            when that is a holiday), and the time is at or after the
            configured weekly send time.
    Times are compared as "now >= send time", never as an exact minute, so a
    late or skipped scheduler tick still sends at the next one.  A send time
    in the last minutes of a day (e.g. 23:55) is first reached by the 00:00
    run, which is already the next day, so a run also sends yesterday's email
    when its time passed less than CATCH_UP_WINDOW ago and it was not sent.
 
At most once
    Before sending, a run claims ``report_runs/{report}_{period}`` (period is
    ``YYYY-MM-DD`` for daily, ``YYYY-Www`` for weekly) in a Firestore
    transaction with status "sending".  A doc that is "sent", or "sending" and
    under 10 minutes old, means skip.  Success sets "sent"; a failure sets
    "failed"; a later run tries again after RETRY_AFTER, at most
    MAX_ATTEMPTS times for that day / week.
 
Caller check
    A Google OIDC ID token from the scheduler's service account
    (``REPORT_SCHEDULER_SA``) whose audience is the service URL
    (``REPORT_AUDIENCE``, comma-separated if the service has several URLs),
    or the ``X-Report-Key`` header matching ``REPORT_RUN_KEY`` (a Secret
    Manager secret) for manual runs.
 
Response
    200 with ``{report, due, sent, skippedReason}`` (or ``{"results": [...]}``
    for both reports) whenever nothing failed, including "not due", so Cloud
    Scheduler does not retry for nothing.  500 only when a send failed.
"""
 
import hmac
import logging
import os
import threading
import time
from datetime import date, datetime, timedelta, timezone
 
from firebase_admin import firestore
from flask import Blueprint, jsonify, request
 
import daily_report
import weekly_stock_report
from firebase_config import db
from mailer import MailSession
 
log = logging.getLogger("vector.reports")
if not log.handlers:
    # Cloud Run keeps stdout; the root logger stays at WARNING, so give the
    # one-line-per-run summary its own INFO handler.
    _handler = logging.StreamHandler()
    _handler.setFormatter(logging.Formatter("%(levelname)s %(name)s %(message)s"))
    log.addHandler(_handler)
    log.setLevel(logging.INFO)
    log.propagate = False
 
IST = daily_report.IST
RUNS_COLLECTION = "report_runs"
SENDING_STALE_AFTER = timedelta(minutes=10)
# Runs come every minute, so a failed email waits a little before the next
# try (a mail server that is down is not hit every minute), and gives up after
# a few tries rather than risk repeated copies from a server that sent the
# mail but reported an error.
RETRY_AFTER = timedelta(minutes=5)
MAX_ATTEMPTS = 6
REPORT_NAMES = ("daily", "weekly")
 
# How far back a run still sends the previous day's email (covers send times
# just before midnight, plus one missed scheduler tick).
CATCH_UP_WINDOW = timedelta(minutes=35)
 
 
def _hour_minute(text):
    hour, minute = (int(part) for part in str(text).split(":"))
    return hour, minute
 
 
# ---------------------------------------------------------------------------
# Due checks: return (period_key, None) when due, else (None, reason)
# ---------------------------------------------------------------------------
 
def _due_at(day, hhmm):
    hour, minute = _hour_minute(hhmm)
    return datetime(day.year, day.month, day.day, hour, minute, tzinfo=IST)
 
 
def daily_due(now, settings, store=None):
    """Today's email once its time is reached; yesterday's within the
    catch-up window if it was never sent (send times close to midnight)."""
    today = now.date()
    if not settings.get("enabled"):
        return None, "disabled"
    if not settings.get("recipients"):
        return None, "no recipients"
    send_time = settings.get("send_time") or "09:00"
 
    yesterday = today - timedelta(days=1)
    if (
        store is not None
        and daily_report._is_business_day(yesterday, settings)
        and timedelta(0) <= now - _due_at(yesterday, send_time) <= CATCH_UP_WINDOW
        and not store.is_sent(f"daily_{yesterday.isoformat()}")
    ):
        return f"daily_{yesterday.isoformat()}", None
 
    if not daily_report._is_business_day(today, settings):
        return None, "not a working day"
    if now < _due_at(today, send_time):
        return None, "not yet time"
    return f"daily_{today.isoformat()}", None
 
 
def _weekly_period_for(day, settings):
    """The ISO week whose weekly email is due on `day`, or None.
 
    That is this week's send day, or last week's when a holiday pushed it
    into this week.
    """
    this_monday = day - timedelta(days=day.weekday())
    for monday in (this_monday, this_monday - timedelta(days=7)):
        if weekly_stock_report._send_day_of_week(monday, settings) == day:
            return weekly_stock_report._week_key(monday)
    return None
 
 
def weekly_due(now, settings, store=None):
    today = now.date()
    if not weekly_stock_report._enabled() or not settings.get("weekly_enabled"):
        return None, "disabled"
    if not settings.get("recipients"):
        return None, "no recipients"
    send_time = settings.get("weekly_send_time") or settings.get("send_time") or "09:00"
 
    # A send time just before midnight on yesterday's send day.
    yesterday = today - timedelta(days=1)
    yesterday_week = _weekly_period_for(yesterday, settings)
    if (
        store is not None
        and yesterday_week
        and timedelta(0) <= now - _due_at(yesterday, send_time) <= CATCH_UP_WINDOW
        and not store.is_sent(f"weekly_{yesterday_week}")
    ):
        return f"weekly_{yesterday_week}", None
 
    week = _weekly_period_for(today, settings)
    if week is None:
        return None, "not the send day"
    if now < _due_at(today, send_time):
        return None, "not yet time"
    return f"weekly_{week}", None
 
 
# ---------------------------------------------------------------------------
# Building each email (content and templates are the reports' own)
# ---------------------------------------------------------------------------
 
def build_daily(now, settings, period_key):
    # The email's own day: today, or yesterday when catching up after midnight.
    send_day = date.fromisoformat(period_key.split("_", 1)[1])
    report_day = daily_report.report_day_for(send_day, settings)
    report = daily_report.compute_report(report_day)
    subject, html, text = daily_report.build_email(report, now)
    state = {"last_sent_date": send_day.isoformat(), "last_report_date": report_day.isoformat()}
    return subject, html, text, [], state
 
 
def build_weekly(now, settings, period_key):
    subject, html, text, attachment = weekly_stock_report.build_report(now)
    state = {"last_sent_week": period_key.split("_", 1)[1]}
    return subject, html, text, [attachment], state
 
 
REPORTS = {
    "daily": {"due": daily_due, "build": build_daily, "state_ref": lambda: daily_report.STATE_REF},
    "weekly": {"due": weekly_due, "build": build_weekly, "state_ref": lambda: weekly_stock_report.STATE_REF},
}
 
 
# ---------------------------------------------------------------------------
# Run records (at-most-once)
# ---------------------------------------------------------------------------
 
def decide_claim(existing, now):
    """Whether a run may send, given the existing run record (or None)."""
    existing = existing or {}
    status = existing.get("status")
    if status == "sent":
        return False, "already sent"
    if status == "sending":
        started = existing.get("startedAt")
        if started is not None and now - started < SENDING_STALE_AFTER:
            return False, "another run is sending"
    if status == "failed":
        if int(existing.get("attempts") or 0) >= MAX_ATTEMPTS:
            return False, f"gave up after {MAX_ATTEMPTS} failed attempts"
        failed_at = existing.get("failedAt")
        if failed_at is not None and now - failed_at < RETRY_AFTER:
            return False, "waiting to retry"
    return True, None
 
 
@firestore.transactional
def _claim_in_transaction(transaction, ref, report, period_key, now):
    snapshot = ref.get(transaction=transaction)
    existing = (snapshot.to_dict() or {}) if snapshot.exists else {}
    allowed, reason = decide_claim(existing, now)
    if not allowed:
        return False, reason
    transaction.set(ref, {
        "report": report,
        "period": period_key.split("_", 1)[1],
        "status": "sending",
        "startedAt": now,
        "attempts": int(existing.get("attempts") or 0) + 1,
        "error": "",
    }, merge=True)
    return True, None
 
 
class FirestoreRunStore:
    def _ref(self, key):
        return db.collection(RUNS_COLLECTION).document(key)
 
    def claim(self, key, report, now):
        return _claim_in_transaction(db.transaction(), self._ref(key), report, key, now)
 
    def is_sent(self, key):
        snapshot = self._ref(key).get()
        return snapshot.exists and (snapshot.to_dict() or {}).get("status") == "sent"
 
    def mark_sent(self, key, recipient_count, now):
        self._ref(key).set({"status": "sent", "sentAt": now, "recipients": recipient_count, "error": ""}, merge=True)
 
    def mark_failed(self, key, error, now):
        self._ref(key).set({"status": "failed", "failedAt": now, "error": error[:500]}, merge=True)
 
 
# ---------------------------------------------------------------------------
# One report run
# ---------------------------------------------------------------------------
 
def _update_page_status(spec, fields):
    """The Alerts page reads its "last sent" status from the old state docs."""
    try:
        spec["state_ref"]().set(fields, merge=True)
    except Exception:
        log.warning("could not update the report status document", exc_info=True)
 
 
def run_report(name, now, settings, store, session):
    """Send report `name` if it is due. Returns (result dict, failed bool)."""
    started = time.perf_counter()
    spec = REPORTS[name]
    result = {"report": name, "due": False, "sent": False, "skippedReason": None}
    recipients = list(settings.get("recipients") or [])
    failed = False
    try:
        period_key, reason = spec["due"](now, settings, store)
        if not period_key:
            result["skippedReason"] = reason
            return result, False
        result["due"] = True
 
        now_utc = now.astimezone(timezone.utc)
        claimed, reason = store.claim(period_key, name, now_utc)
        if not claimed:
            result["skippedReason"] = reason
            return result, False
 
        try:
            subject, html, text, attachments, state = spec["build"](now, settings, period_key)
            session.send(recipients, subject, html, text, attachments=attachments)
        except Exception as exc:
            failed = True
            # Error text can carry addresses (e.g. "recipient refused");
            # the run record and the Alerts page keep it, the log does not.
            store.mark_failed(period_key, str(exc), now_utc)
            _update_page_status(spec, {"last_status": "failed", "last_error": str(exc)[:500]})
            result["skippedReason"] = f"send failed ({type(exc).__name__})"
            return result, True
 
        sent_at = datetime.now(timezone.utc)
        store.mark_sent(period_key, len(recipients), sent_at)
        _update_page_status(spec, {
            **state,
            "last_status": "sent",
            "last_sent_at": sent_at,
            "last_recipients": recipients,
            "last_error": "",
        })
        result["sent"] = True
        return result, False
    finally:
        # Runs every minute: log only runs where something was due, so the
        # log is one line per email (sent, skipped as already sent, or failed).
        log.log(
            logging.INFO if result["due"] or failed else logging.DEBUG,
            "report_run report=%s due=%s sent=%s recipients=%d skipped=%s failed=%s ms=%d",
            name, result["due"], result["sent"], len(recipients) if result["sent"] else 0,
            result["skippedReason"] or "-", failed, (time.perf_counter() - started) * 1000,
        )
 
 
def run_reports(names, now=None, settings=None, store=None, session_factory=MailSession):
    """Run each report in `names` with one shared mail connection."""
    now = now or datetime.now(IST)
    settings = settings if settings is not None else daily_report.load_settings()
    store = store or FirestoreRunStore()
    results, any_failed = [], False
    with session_factory() as session:
        for name in names:
            result, failed = run_report(name, now, settings, store, session)
            results.append(result)
            any_failed = any_failed or failed
    return results, any_failed
 
 
# ---------------------------------------------------------------------------
# Local ticker (development only)
# ---------------------------------------------------------------------------
 
_local_ticker_started = False
 
 
def start_local_ticker(interval_seconds=60):
    """Run the reports once a minute inside this process.
 
    Only for `python app.py` on a developer machine, where Cloud Scheduler
    cannot reach the server.  Production (gunicorn on Cloud Run) never calls
    this.  Turn it off with LOCAL_REPORT_SCHEDULER=off.  Sending stays
    at-most-once through the report_runs claims, so it is safe next to the
    production scheduler.
    """
    global _local_ticker_started
    if os.getenv("LOCAL_REPORT_SCHEDULER", "on").strip().lower() in {"0", "off", "false", "no"}:
        log.info("local report ticker is off (LOCAL_REPORT_SCHEDULER)")
        return
    if _local_ticker_started:
        return
    _local_ticker_started = True
 
    def loop():
        time.sleep(10)
        while True:
            try:
                run_reports(REPORT_NAMES)
                # report_run already logs each send or failure; nothing more here.
            except Exception:
                log.exception("local report ticker run failed")
            time.sleep(interval_seconds)
 
    threading.Thread(target=loop, name="local-report-ticker", daemon=True).start()
    log.info("local report ticker started: checks daily/weekly emails every %ss", interval_seconds)
 
 
# ---------------------------------------------------------------------------
# Caller check
# ---------------------------------------------------------------------------
 
CERTS_CACHE_SECONDS = 3600
_certs_cache = {}  # url -> (expires_at, response)
_certs_lock = threading.Lock()
_transport = []
 
 
class _CachingRequest:
    """google-auth transport that keeps Google's public signing keys for an hour.
 
    `verify_oauth2_token` downloads the keys on every call; with a run every
    minute that would be 1,440 extra downloads a day.  The keys rotate over
    days, so an hour-old copy is always valid.
    """
 
    def __init__(self):
        from google.auth.transport import requests as google_requests
 
        self._inner = google_requests.Request()
 
    def __call__(self, url, method="GET", body=None, headers=None, timeout=None, **kwargs):
        cacheable = method == "GET" and body is None
        if cacheable:
            with _certs_lock:
                hit = _certs_cache.get(url)
            if hit and hit[0] > time.monotonic():
                return hit[1]
        response = self._inner(url, method=method, body=body, headers=headers, timeout=timeout, **kwargs)
        if cacheable and getattr(response, "status", None) == 200:
            with _certs_lock:
                _certs_cache[url] = (time.monotonic() + CERTS_CACHE_SECONDS, response)
        return response
 
 
def _google_request():
    if not _transport:
        _transport.append(_CachingRequest())
    return _transport[0]
 
 
def _verify_oidc(token):
    """'ok', 'invalid' (bad/expired token, wrong audience) or 'forbidden'."""
    audiences = [a.strip().rstrip("/") for a in os.getenv("REPORT_AUDIENCE", "").split(",") if a.strip()]
    expected_email = os.getenv("REPORT_SCHEDULER_SA", "").strip().lower()
    if not audiences or not expected_email:
        log.warning("report hook: REPORT_AUDIENCE / REPORT_SCHEDULER_SA are not set; OIDC callers are refused")
        return "invalid"
    try:
        from google.oauth2 import id_token
 
        info = id_token.verify_oauth2_token(
            token, _google_request(), audience=audiences if len(audiences) > 1 else audiences[0]
        )
    except Exception:
        return "invalid"
    if str(info.get("email") or "").lower() != expected_email or not info.get("email_verified", False):
        return "forbidden"
    return "ok"
 
 
def authorize_caller():
    """None when the caller may run reports, else a (response, status)."""
    key = request.headers.get("X-Report-Key", "")
    if key:
        expected = os.getenv("REPORT_RUN_KEY", "")
        if expected and hmac.compare_digest(key.encode(), expected.encode()):
            return None
        return jsonify({"success": False, "message": "Invalid report key"}), 401
    header = request.headers.get("Authorization", "")
    if not header.startswith("Bearer "):
        return jsonify({"success": False, "message": "Missing credentials"}), 401
    verdict = _verify_oidc(header[len("Bearer "):].strip())
    if verdict == "ok":
        return None
    if verdict == "forbidden":
        return jsonify({"success": False, "message": "This caller may not run reports"}), 403
    return jsonify({"success": False, "message": "Invalid token"}), 401
 
 
# ---------------------------------------------------------------------------
# Hook
# ---------------------------------------------------------------------------
 
reports_bp = Blueprint("report_runs", __name__)
 
 
@reports_bp.route("/internal/reports/run", methods=["POST"])
def run_reports_hook():
    denied = authorize_caller()
    if denied:
        return denied
    which = str(request.args.get("report") or "all").strip().lower()
    if which != "all" and which not in REPORT_NAMES:
        return jsonify({"success": False, "message": "report must be daily, weekly or all"}), 400
    names = REPORT_NAMES if which == "all" else (which,)
    try:
        results, failed = run_reports(names)
    except Exception as exc:
        # Settings could not be read, etc.  Nothing was sent.
        log.error("report_run error=%s", type(exc).__name__)
        return jsonify({"success": False, "message": "Report run failed before sending"}), 500
    body = results[0] if len(results) == 1 else {"results": results}
    return jsonify(body), 500 if failed else 200
 
 
