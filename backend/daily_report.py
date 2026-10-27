"""Daily production report email for directors (Alerts page).

What it sends
-------------
One email per day with two sections:

1. **Previous working day** - what happened on that day: units assembled,
   units packed (In Stock), units that passed QC, units delivered (Sold),
   units assembled that day now at Semi Finished, units moved to QC
   inspection and units that failed QC.
2. **Overall** - the same totals the dashboard cards show (Total Unit,
   In Stock, Waiting for Packing, Sold Units, In Production, Semi Finished,
   Under QC Inspection, QC Passed, QC Failed), computed with the dashboard's
   own rules so the two never disagree.

When it sends
-------------
Settings live in Firestore (`system_settings/daily_report_alert`): an on/off
switch, recipients, the send time (IST), the working days and a holiday
calendar. A background thread checks once a minute; on a working, non-holiday
day at or after the send time it sends once. The "sent today" marker is
claimed in a Firestore transaction, so several server instances (or a restart)
can never send twice. The report covers the most recent working, non-holiday
day before today - on a Monday after a weekend off, that is Friday.

Hosts that sleep between requests (Cloud Run) should also call
`POST /alerts/daily-report/run` from a scheduler (e.g. Cloud Scheduler every
15 minutes) with the `X-Cron-Secret` header set to ALERTS_CRON_SECRET; it runs
the same "send if due" check.
"""

import html
import logging
import os
import re
import threading
import time
from datetime import date, datetime, timedelta, timezone

from firebase_admin import firestore
from flask import Blueprint, jsonify, request

from auth_utils import roles_required
from dashboard import DISPATCHED_STATUSES, _display_number, _number, _sale_serials  # noqa: F401
from firebase_config import db
from mailer import send_html_email

logger = logging.getLogger("vector.daily_report")

daily_report_bp = Blueprint("daily_report", __name__)

ALERT_ROLES = ("admin", "coadmin")
IST = timezone(timedelta(hours=5, minutes=30))

SETTINGS_REF = db.collection("system_settings").document("daily_report_alert")
STATE_REF = db.collection("system_settings").document("daily_report_alert_state")

DEFAULT_SETTINGS = {
    "enabled": False,
    "recipients": [],
    "send_time": "09:00",
    # Monday = 0 ... Sunday = 6
    "working_days": [0, 1, 2, 3, 4, 5],
    "holidays": [],
}

EMAIL_PATTERN = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")
TIME_PATTERN = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
DATE_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}$")
MAX_RECIPIENTS = 50
MAX_HOLIDAYS = 400


# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------

def load_settings():
    snapshot = SETTINGS_REF.get()
    stored = snapshot.to_dict() if snapshot.exists else {}
    settings = {**DEFAULT_SETTINGS, **(stored or {})}
    settings["holidays"] = sorted(
        [h for h in settings.get("holidays") or [] if isinstance(h, dict) and h.get("date")],
        key=lambda item: item["date"],
    )
    return settings


def _load_state():
    snapshot = STATE_REF.get()
    return snapshot.to_dict() if snapshot.exists else {}


def _clean_settings(payload):
    """Validate a submitted settings object; raises ValueError with a message."""
    if not isinstance(payload, dict):
        raise ValueError("Settings must be an object")

    recipients = []
    for raw in payload.get("recipients") or []:
        email = str(raw or "").strip().lower()
        if not email:
            continue
        if not EMAIL_PATTERN.match(email):
            raise ValueError(f"Invalid email address: {email}")
        if email not in recipients:
            recipients.append(email)
    if len(recipients) > MAX_RECIPIENTS:
        raise ValueError(f"Up to {MAX_RECIPIENTS} recipients are allowed")

    send_time = str(payload.get("send_time") or "").strip()
    if not TIME_PATTERN.match(send_time):
        raise ValueError("Send time must be in HH:MM (24-hour) format")

    working_days = []
    for raw in payload.get("working_days") or []:
        try:
            day = int(raw)
        except (TypeError, ValueError):
            raise ValueError("Working days must be numbers 0 (Mon) to 6 (Sun)")
        if 0 <= day <= 6 and day not in working_days:
            working_days.append(day)
    if not working_days:
        raise ValueError("Select at least one working day")

    holidays = {}
    for raw in payload.get("holidays") or []:
        if isinstance(raw, dict):
            day, description = str(raw.get("date") or "").strip(), str(raw.get("description") or "").strip()
        else:
            day, description = str(raw or "").strip(), ""
        if not day:
            continue
        if not DATE_PATTERN.match(day):
            raise ValueError(f"Invalid holiday date: {day} (expected YYYY-MM-DD)")
        try:
            date.fromisoformat(day)
        except ValueError:
            raise ValueError(f"Invalid holiday date: {day}")
        holidays[day] = {"date": day, "description": description[:120] or "Holiday"}
    if len(holidays) > MAX_HOLIDAYS:
        raise ValueError(f"Up to {MAX_HOLIDAYS} holidays are allowed")

    enabled = bool(payload.get("enabled"))
    if enabled and not recipients:
        raise ValueError("Add at least one recipient before turning the daily email on")

    return {
        "enabled": enabled,
        "recipients": recipients,
        "send_time": send_time,
        "working_days": sorted(working_days),
        "holidays": sorted(holidays.values(), key=lambda item: item["date"]),
    }


def _is_business_day(day, settings):
    holidays = {h["date"] for h in settings.get("holidays") or []}
    return day.weekday() in set(settings.get("working_days") or []) and day.isoformat() not in holidays


def report_day_for(today, settings):
    """The most recent working, non-holiday day before `today`."""
    day = today - timedelta(days=1)
    for _ in range(31):
        if _is_business_day(day, settings):
            return day
        day -= timedelta(days=1)
    return today - timedelta(days=1)


def next_send_at(now, settings, state):
    """When the next email is due, or None if the alert is off."""
    if not settings.get("enabled") or not settings.get("recipients"):
        return None
    hour, minute = (int(part) for part in settings["send_time"].split(":"))
    today = now.date()
    for offset in range(60):
        day = today + timedelta(days=offset)
        if not _is_business_day(day, settings):
            continue
        if day == today and state.get("last_sent_date") == today.isoformat():
            continue
        due = datetime(day.year, day.month, day.day, hour, minute, tzinfo=IST)
        # Past today's time but not sent yet: it goes out at the next check.
        return max(due, now)
    return None


# ---------------------------------------------------------------------------
# Figures
# ---------------------------------------------------------------------------

def _ist_day(value):
    """IST calendar day (date) of a Firestore timestamp or ISO date string."""
    if not value:
        return None
    if isinstance(value, datetime):
        if value.tzinfo is not None:
            value = value.astimezone(IST)
        return value.date()
    text = str(value).strip()
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        if parsed.tzinfo is not None:
            parsed = parsed.astimezone(IST)
        return parsed.date()
    except ValueError:
        pass
    match = re.match(r"^(\d{4})-(\d{2})-(\d{2})", text)
    if match:
        try:
            return date(int(match.group(1)), int(match.group(2)), int(match.group(3)))
        except ValueError:
            return None
    return None


def _first_day(unit, *fields):
    for field in fields:
        day = _ist_day(unit.get(field))
        if day:
            return day
    return None


def _text(value):
    return str(value or "").strip()


def compute_report(report_day):
    """Both sections of the email, as plain numbers."""
    units = [doc.to_dict() or {} for doc in db.collection("assembly_units").stream()]
    sales = [doc.to_dict() or {} for doc in db.collection("sale_register").stream()]

    # --- Section 1: what happened on report_day -------------------------
    assembled = semi_finished = in_production = 0
    qc_passed = qc_inspection = qc_failed = packed = 0
    for unit in units:
        qty = _number(unit.get("qty"))
        stage = _text(unit.get("stage"))
        qc = _text(unit.get("qc"))
        if _ist_day(unit.get("date")) == report_day:
            assembled += qty
        # The day the unit reached its current stage. Units saved before
        # `stageAt` existed fall back to their assembly date.
        stage_day = _first_day(unit, "stageAt", "date")
        if stage_day == report_day:
            if stage == "Semi Finished":
                semi_finished += qty
            elif stage == "In Production":
                in_production += qty
        qc_day = _first_day(unit, "qcAt", "date")
        if qc == "Passed" and qc_day == report_day:
            qc_passed += qty
        if qc in ("Under Inspection", "Pending") and qc_day == report_day:
            qc_inspection += qty
        failed_today = qc == "Failed" and qc_day == report_day
        if not failed_today:
            failed_today = any(
                isinstance(entry, dict) and _ist_day(entry.get("failedAt")) == report_day
                for entry in unit.get("qcFailureHistory") or []
            )
        if failed_today:
            qc_failed += qty
        if (_text(unit.get("packagingStatus")).casefold() == "packed"
                and _first_day(unit, "packagedAt", "updatedAt", "date") == report_day):
            packed += qty

    delivered = [s for s in sales if _text(s.get("dispatch")).casefold() == "delivered"]
    sold_on_day = sum(
        _number(s.get("qty")) for s in delivered
        if _first_day(s, "deliveredAt", "updatedAt") == report_day
    )

    day_section = {
        "assembled": assembled,
        "packed": packed,
        "qcPassed": qc_passed,
        "sold": sold_on_day,
        "semiFinished": semi_finished,
        "inProduction": in_production,
        "qcInspection": qc_inspection,
        "qcFailed": qc_failed,
    }

    # --- Section 2: overall, with the dashboard's rules ----------------
    stage_totals = {}
    total_qc_passed = total_qc_failed = total_qc_inspection = 0
    for unit in units:
        qty = _number(unit.get("qty"))
        stage = unit.get("stage", "")
        stage_totals[stage] = stage_totals.get(stage, 0) + qty
        qc = unit.get("qc", "")
        if qc == "Passed":
            total_qc_passed += qty
        elif qc == "Failed":
            total_qc_failed += qty
        elif qc in ("Under Inspection", "Pending"):
            total_qc_inspection += qty

    sold_serials = set()
    for sale in delivered:
        sold_serials |= {serial.casefold() for serial in _sale_serials(sale)}
    in_stock_added = in_stock_sold = in_stock_packed = 0
    for unit in units:
        if _text(unit.get("qc")).casefold() != "passed":
            continue
        qty = _number(unit.get("qty"))
        in_stock_added += qty
        if _text(unit.get("serial")).casefold() in sold_serials:
            in_stock_sold += qty
        elif _text(unit.get("packagingStatus")).casefold() == "packed":
            in_stock_packed += qty

    total_in_production = stage_totals.get("In Production", 0)
    total_semi = stage_totals.get("Semi Finished", 0)
    overall = {
        "total": total_in_production + total_semi + total_qc_passed + total_qc_failed + total_qc_inspection,
        "inStock": in_stock_packed,
        # QC passed, not sold, not packed yet (the dashboard's card).
        "awaitingPacking": max(0, in_stock_added - in_stock_sold - in_stock_packed),
        "sold": sum(_number(s.get("qty")) for s in delivered),
        "inProduction": total_in_production,
        "semiFinished": total_semi,
        "qcInspection": total_qc_inspection,
        "qcPassed": total_qc_passed,
        "qcFailed": total_qc_failed,
    }

    as_numbers = lambda section: {key: _display_number(value) for key, value in section.items()}  # noqa: E731
    return {"reportDate": report_day.isoformat(), "day": as_numbers(day_section), "overall": as_numbers(overall)}


# ---------------------------------------------------------------------------
# Email
# ---------------------------------------------------------------------------

DAY_ROWS = [
    ("assembled", "Units Assembled", "Units recorded with this assembly date"),
    ("packed", "In Stock (Packed)", "Units packed on this day"),
    ("qcPassed", "QC Passed", "Units that passed QC on this day"),
    ("sold", "Sold Units", "Sales marked Delivered on this day"),
    ("semiFinished", "Units Semi Finished", "Units moved to Semi Finished this day"),
    ("qcInspection", "Under QC Inspection", "Units moved to QC inspection this day"),
    ("qcFailed", "QC Failed", "Units that failed QC on this day"),
]

OVERALL_ROWS = [
    ("total", "Total Unit", "In production + semi finished + QC"),
    ("inStock", "In Stock", "Packing completed, ready to dispatch"),
    ("awaitingPacking", "Waiting for Packing", "QC passed, packing not done yet"),
    ("sold", "Sold Units", "Dispatch status delivered"),
    ("inProduction", "Units In Production", "Live operational total"),
    ("semiFinished", "Units Semi Finished", "Moving through production"),
    ("qcInspection", "Under QC Inspection", "Awaiting quality decision"),
    ("qcPassed", "QC Passed (Total)", "Cleared quality inspection"),
    ("qcFailed", "QC Failed", "Units that failed quality inspection"),
]

BRAND_RED = "#e31b23"


def _esc(value):
    return html.escape(str(value), quote=True)


def _pretty(day):
    return day.strftime("%A, %d %b %Y")


def _cards_html(rows, values, accent):
    """Two cards per row; table layout so every mail client renders it."""
    cells = []
    for key, label, note in rows:
        cells.append(
            f'<td width="50%" valign="top" style="padding:6px;">'
            f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
            f'style="border:1px solid #ececec;border-left:4px solid {accent};border-radius:8px;background:#ffffff;">'
            f'<tr><td style="padding:12px 14px;font-family:Arial,Helvetica,sans-serif;">'
            f'<div style="font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#6b6b6b;">{_esc(label)}</div>'
            f'<div style="font-size:24px;font-weight:700;color:#1f1f1f;margin-top:4px;">{_esc(values.get(key, 0))}</div>'
            f'<div style="font-size:12px;color:#8a8a8a;margin-top:2px;">{_esc(note)}</div>'
            f"</td></tr></table></td>"
        )
    rows_html = []
    for index in range(0, len(cells), 2):
        pair = cells[index:index + 2]
        if len(pair) == 1:
            pair.append('<td width="50%" style="padding:6px;"></td>')
        rows_html.append(f"<tr>{''.join(pair)}</tr>")
    return f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0">{"".join(rows_html)}</table>'


def build_email(report, generated_at=None):
    """(subject, html, text) for a computed report."""
    report_day = date.fromisoformat(report["reportDate"])
    generated_at = generated_at or datetime.now(IST)
    subject = f"Vector daily production report - {report_day.strftime('%d %b %Y')}"
    app_url = os.getenv("APP_FRONTEND_URL", "https://production.vector-power.com").rstrip("/")
    # Use a public HTTPS asset for reports.  Some Outlook clients do not
    # resolve ``cid:`` images from messages sent through external SMTP
    # providers, which leaves a broken-image placeholder in the report.
    # The React build copies this file from public/images, and deployments
    # with a CDN or different asset host can override it explicitly.
    logo_url = os.getenv("EMAIL_LOGO_URL", "").strip() or f"{app_url}/images/vector-pdf.png"

    body = f"""<!doctype html>
<html><body style="margin:0;padding:0;background:#f5f4f1;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f4f1;padding:24px 12px;">
<tr><td align="center">
<table role="presentation" width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;">
  <tr><td style="padding:20px 24px;border-bottom:3px solid {BRAND_RED};font-family:Arial,Helvetica,sans-serif;">
    <img src="{_esc(logo_url)}" alt="Vector" width="60" height="64" style="display:block;width:60px;height:64px;margin-bottom:10px;border:0;">
    <div style="font-size:20px;font-weight:700;color:#1f1f1f;">Vector daily production report</div>
    <div style="font-size:13px;color:#6b6b6b;margin-top:4px;">Production &amp; Sales Control &middot; generated {_esc(generated_at.strftime('%d %b %Y, %I:%M %p'))} IST</div>
  </td></tr>
  <tr><td style="padding:20px 18px 6px;font-family:Arial,Helvetica,sans-serif;">
    <div style="font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:{BRAND_RED};padding:0 6px;">Section 1</div>
    <div style="font-size:17px;font-weight:700;color:#1f1f1f;padding:2px 6px 8px;">{_esc(_pretty(report_day))}</div>
    {_cards_html(DAY_ROWS, report["day"], BRAND_RED)}
  </td></tr>
  <tr><td style="padding:16px 18px 6px;font-family:Arial,Helvetica,sans-serif;">
    <div style="font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#2f6f4f;padding:0 6px;">Section 2</div>
    <div style="font-size:17px;font-weight:700;color:#1f1f1f;padding:2px 6px 8px;">Overall totals (as of today)</div>
    {_cards_html(OVERALL_ROWS, report["overall"], "#3fae7c")}
  </td></tr>
  <!-- Centred red button and note, the same footer as the password-reset email. -->
  <tr><td align="center" style="padding:22px 24px 0;font-family:Arial,Helvetica,sans-serif;">
    <a href="{_esc(app_url)}/dashboard"
       style="display:inline-block;background:{BRAND_RED};color:#ffffff;text-decoration:none;font-size:15px;font-weight:700;padding:13px 30px;border-radius:8px;">
      Open the dashboard
    </a>
  </td></tr>
  <tr><td align="center" style="padding:16px 32px 24px;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.6;color:#6b6b6b;text-align:center;">
    You receive this email because you are listed as a recipient<br>on the Vector Alerts page.
  </td></tr>
</table>
</td></tr></table>
</body></html>"""

    lines = [f"Vector daily production report - {_pretty(report_day)}", "", "SECTION 1 - " + _pretty(report_day)]
    lines += [f"  {label}: {report['day'].get(key, 0)}" for key, label, _ in DAY_ROWS]
    lines += ["", "SECTION 2 - Overall totals (as of today)"]
    lines += [f"  {label}: {report['overall'].get(key, 0)}" for key, label, _ in OVERALL_ROWS]
    lines += ["", f"Dashboard: {app_url}/dashboard"]
    return subject, body, "\n".join(lines)


# ---------------------------------------------------------------------------
# Sending
# ---------------------------------------------------------------------------

@firestore.transactional
def _claim_today(transaction, today_iso):
    snapshot = STATE_REF.get(transaction=transaction)
    state = snapshot.to_dict() if snapshot.exists else {}
    if state.get("last_sent_date") == today_iso:
        return False
    transaction.set(STATE_REF, {
        "last_sent_date": today_iso,
        "last_status": "sending",
        "last_attempt_at": datetime.now(timezone.utc),
    }, merge=True)
    return True


# Firestore reads cost money and the scheduler runs every minute, so it works
# from memory as much as it can:
# - settings are re-read at most every SETTINGS_CACHE_SECONDS (a save on this
#   instance refreshes them at once; another instance picks a save up within
#   that window);
# - once today's email is sent (or another instance sent it), the day is
#   remembered and no further reads happen until tomorrow.
# That is roughly 150 reads a day per instance instead of ~2,000.
SETTINGS_CACHE_SECONDS = 600
_cache_lock = threading.Lock()
_settings_cache = {"value": None, "loaded_at": 0.0}
_handled_day = {"date": None}


def cached_settings():
    with _cache_lock:
        if _settings_cache["value"] is not None and time.monotonic() - _settings_cache["loaded_at"] < SETTINGS_CACHE_SECONDS:
            return _settings_cache["value"]
    value = load_settings()
    remember_settings(value)
    return value


def remember_settings(value):
    with _cache_lock:
        _settings_cache["value"] = value
        _settings_cache["loaded_at"] = time.monotonic()


def send_if_due(now=None):
    """Send today's report when it is due. Returns a short status string."""
    now = now or datetime.now(IST)
    today = now.date()
    if _handled_day["date"] == today:
        return "already sent"
    settings = cached_settings()
    if not settings.get("enabled"):
        return "disabled"
    if not settings.get("recipients"):
        return "no recipients"
    if not _is_business_day(today, settings):
        return "not a working day"
    hour, minute = (int(part) for part in settings["send_time"].split(":"))
    if (now.hour, now.minute) < (hour, minute):
        return "not yet time"
    if not _claim_today(db.transaction(), today.isoformat()):
        _handled_day["date"] = today
        return "already sent"
    _handled_day["date"] = today

    report_day = report_day_for(today, settings)
    try:
        report = compute_report(report_day)
        subject, body, text = build_email(report, now)
        send_html_email(settings["recipients"], subject, body, text)
        STATE_REF.set({
            "last_status": "sent",
            "last_sent_at": datetime.now(timezone.utc),
            "last_report_date": report_day.isoformat(),
            "last_recipients": settings["recipients"],
            "last_error": "",
        }, merge=True)
        logger.info("daily report sent for %s to %d recipient(s)", report_day, len(settings["recipients"]))
        return "sent"
    except Exception as exc:  # recorded on the page; the marker stays so it does not retry every minute
        STATE_REF.set({"last_status": "failed", "last_error": str(exc)[:500]}, merge=True)
        logger.exception("daily report failed")
        return f"failed: {exc}"


_scheduler_started = False
_scheduler_lock = threading.Lock()


def start_scheduler():
    """Start the once-a-minute check in a daemon thread (once per process)."""
    global _scheduler_started
    if os.getenv("DAILY_REPORT_SCHEDULER", "on").strip().lower() in {"0", "off", "false", "no"}:
        return
    with _scheduler_lock:
        if _scheduler_started:
            return
        _scheduler_started = True

    def loop():
        time.sleep(15)
        while True:
            try:
                send_if_due()
            except Exception:
                logger.exception("daily report scheduler check failed")
            time.sleep(60)

    threading.Thread(target=loop, name="daily-report-scheduler", daemon=True).start()


# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------

def _iso(value):
    return value.isoformat() if hasattr(value, "isoformat") else value


def _settings_payload(settings):
    state = _load_state()
    now = datetime.now(IST)
    upcoming = next_send_at(now, settings, state)
    return {
        "settings": {key: settings.get(key) for key in DEFAULT_SETTINGS},
        "status": {
            "lastSentAt": _iso(state.get("last_sent_at")),
            "lastReportDate": state.get("last_report_date"),
            "lastStatus": state.get("last_status", ""),
            "lastError": state.get("last_error", ""),
            "lastTestAt": _iso(state.get("last_test_at")),
            "nextSendAt": upcoming.isoformat() if upcoming else None,
            "nextReportDate": report_day_for(upcoming.date(), settings).isoformat() if upcoming else None,
            "serverTime": now.isoformat(),
        },
    }


@daily_report_bp.route("/alerts/daily-report/settings", methods=["GET"])
@roles_required(*ALERT_ROLES)
def get_daily_report_settings():
    try:
        return jsonify({"success": True, **_settings_payload(load_settings())}), 200
    except Exception as exc:
        return jsonify({"success": False, "message": f"Failed to load alert settings: {exc}"}), 500


@daily_report_bp.route("/alerts/daily-report/settings", methods=["PUT"])
@roles_required(*ALERT_ROLES)
def save_daily_report_settings():
    try:
        settings = _clean_settings(request.get_json(silent=True) or {})
    except ValueError as exc:
        return jsonify({"success": False, "message": str(exc)}), 400
    try:
        SETTINGS_REF.set({
            **settings,
            "updatedAt": datetime.now(timezone.utc),
            "updatedBy": request.user.get("email") or request.user.get("name") or "",
        }, merge=True)
        # The scheduler on this instance uses the new settings straight away.
        remember_settings({**DEFAULT_SETTINGS, **settings})
        return jsonify({"success": True, "message": "Alert settings saved", **_settings_payload(settings)}), 200
    except Exception as exc:
        return jsonify({"success": False, "message": f"Failed to save alert settings: {exc}"}), 500


@daily_report_bp.route("/alerts/daily-report/preview", methods=["GET"])
@roles_required(*ALERT_ROLES)
def preview_daily_report():
    """The email as it would be sent now, for the page's preview."""
    try:
        settings = load_settings()
        requested = _ist_day(request.args.get("date")) if request.args.get("date") else None
        report_day = requested or report_day_for(datetime.now(IST).date(), settings)
        report = compute_report(report_day)
        subject, body, _ = build_email(report)
        body = body.replace('src="cid:vector-logo"', 'src="/images/vector-pdf.png"')
        return jsonify({"success": True, "subject": subject, "html": body, "report": report}), 200
    except Exception as exc:
        return jsonify({"success": False, "message": f"Failed to build the preview: {exc}"}), 500


@daily_report_bp.route("/alerts/daily-report/send-test", methods=["POST"])
@roles_required(*ALERT_ROLES)
def send_test_daily_report():
    """Send the report now - to one address, or to every saved recipient.

    Does not count as the day's scheduled send.
    """
    body = request.get_json(silent=True) or {}
    settings = load_settings()
    target = str(body.get("email") or "").strip().lower()
    if target and not EMAIL_PATTERN.match(target):
        return jsonify({"success": False, "message": "Enter a valid email address"}), 400
    recipients = [target] if target else settings.get("recipients") or []
    if not recipients:
        return jsonify({"success": False, "message": "Add a recipient or enter an email to send the test to"}), 400
    try:
        report_day = report_day_for(datetime.now(IST).date(), settings)
        report = compute_report(report_day)
        subject, html_body, text = build_email(report)
        send_html_email(recipients, f"[Test] {subject}", html_body, text)
        STATE_REF.set({"last_test_at": datetime.now(timezone.utc)}, merge=True)
        return jsonify({"success": True, "message": f"Test email sent to {', '.join(recipients)}"}), 200
    except Exception as exc:
        return jsonify({"success": False, "message": f"Could not send the email: {exc}"}), 502


@daily_report_bp.route("/alerts/daily-report/run", methods=["POST"])
def run_daily_report():
    """Scheduler hook: same 'send if due' check as the background thread."""
    secret = os.getenv("ALERTS_CRON_SECRET", "").strip()
    if not secret or request.headers.get("X-Cron-Secret", "") != secret:
        return jsonify({"success": False, "message": "Forbidden"}), 403
    return jsonify({"success": True, "result": send_if_due()}), 200
