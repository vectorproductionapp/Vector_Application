"""Weekly stock register email with the full list attached as Excel.

What it sends
-------------
Once a week: a short email (same look as the daily report) with
`Vector-Stock-Register-<date>.xlsx` attached. The workbook contains one
**Stock Register** sheet with every material row and column from Stock Register
> Table View. The email contains the report date and attachment details only.

The data comes only from the existing Stock Register Table View endpoint
(`list_stock_register`), called as-is, so the attachment matches that page.

When it sends
-------------
It follows the Alerts page: only while the weekly email is ON, to the same
recipients, at the same send time, on the selected weekday - or, if that day
is a holiday / not a working day, on the next working day. It is claimed
once per scheduled ISO week in Firestore, so it never sends twice.
Set WEEKLY_STOCK_REPORT=off to disable it.

The daily report's background thread checks it every minute; on hosts that
sleep (Cloud Run), add a weekly Cloud Scheduler job (e.g. "0 10 * * 1",
Asia/Kolkata) calling POST /alerts/weekly-stock-report/run with the
X-Cron-Secret header (ALERTS_CRON_SECRET).

Testing (no schedule involved)
------------------------------
    python weekly_stock_report.py preview [--out DIR] [--open]
        Builds the workbook and the email HTML, saves both, prints their file
        paths and the HTML. --open shows the HTML in the browser. Sends nothing.

    python weekly_stock_report.py test-send --to you@example.com
        Sends the real email, with the attachment, to that address only.
        Subject starts with "[Test]"; the weekly schedule is not touched.
"""

import inspect
import io
import logging
import os
import sys
from datetime import datetime, timedelta, timezone

if __name__ == "__main__":
    # Command-line use: read backend/.env before Firebase is initialised by the
    # imports below, and never start the background schedulers.
    os.environ.setdefault("DAILY_REPORT_SCHEDULER", "off")
    try:
        from dotenv import load_dotenv
        load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))
    except ImportError:
        pass

from firebase_admin import firestore
from flask import Blueprint, Flask, Response, jsonify, request

try:
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
    from openpyxl.utils import get_column_letter
    OPENPYXL_AVAILABLE = True
except ModuleNotFoundError:
    Workbook = None
    Alignment = Border = Font = PatternFill = Side = None
    get_column_letter = None
    OPENPYXL_AVAILABLE = False

import daily_report
from auth_utils import roles_required
import stockregister
from firebase_config import db
from mailer import send_html_email

logger = logging.getLogger("vector.weekly_stock_report")

weekly_stock_report_bp = Blueprint("weekly_stock_report", __name__)

IST = daily_report.IST
XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
STATE_REF = db.collection("system_settings").document("weekly_stock_report_state")
# The Stock Register page is also available to production in-charges.  They
# may download the workbook, but cannot preview, test, or alter email alerts.
STOCK_DOWNLOAD_ROLES = (*daily_report.ALERT_ROLES, "production_incharge")


def _enabled():
    return os.getenv("WEEKLY_STOCK_REPORT", "on").strip().lower() not in {"0", "off", "false", "no"}


def _send_weekday(settings=None):
    if settings and settings.get("weekly_send_day") is not None:
        try:
            return min(6, max(0, int(settings["weekly_send_day"])))
        except (TypeError, ValueError):
            logger.warning("invalid weekly_send_day setting; using Monday")
            return 0
    try:
        return min(6, max(0, int(os.getenv("WEEKLY_STOCK_REPORT_DAY", "0"))))
    except ValueError:
        return 0


# ---------------------------------------------------------------------------
# Data - the existing Stock Register endpoints, unchanged
# ---------------------------------------------------------------------------

_context_app = Flask("weekly_stock_report")


def _endpoint_rows(view, path, key):
    """Every row a Stock Register endpoint returns (its `allRows`).

    The views are called directly (auth / cache decorators unwrapped) inside a
    throwaway request context, so the rows are exactly what the pages show.
    """
    with _context_app.test_request_context(f"{path}?page=1&limit=10000"):
        result = inspect.unwrap(view)()
        response = result[0] if isinstance(result, tuple) else result
        body = response.get_json() or {}
    if not body.get("success"):
        raise RuntimeError(body.get("message") or f"Could not read {path}")
    return body.get("allRows") or body.get(key) or []


def load_data():
    return _endpoint_rows(stockregister.list_stock_register, "/stock-register", "stockRows")


# ---------------------------------------------------------------------------
# Workbook
# ---------------------------------------------------------------------------

MATERIAL_COLUMNS = [
    ("phase", "Phase", 14), ("code", "Product Code", 14), ("desc", "Material Description", 40),
    ("inBoq", "BOM", 16), ("make", "Make", 14), ("model", "Linked Finished Model", 18),
    ("reqQty", "Qty per Unit (BOM)", 18), ("opening", "Opening Stock", 14),
    ("purchased", "Qty Purchased (Received)", 22), ("consumed", "Qty Consumed (Production)", 24),
    ("closing", "Closing Stock", 14), ("minLevel", "Min Stock Level (from BOQ)", 24),
    ("status", "Stock Status", 22), ("lastUpdated", "Last Updated", 14),
]

DARK = "1F1F1F"
BRAND_RED = "E31B23"
THIN = Side(style="thin", color="D9D4CC")
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)
STATUS_FILLS = {
    "in stock": "E6F4EC",        # green tint
    "awaiting packing": "FFF4D6",  # amber tint
    "sold": "FDE8E8",            # red tint
}


def _date_text(value):
    """`2026-10-23...` -> `23-10-2026`, matching the app's tables."""
    text = str(value or "").strip()
    if len(text) >= 10 and text[4] == "-" and text[7] == "-":
        return f"{text[8:10]}-{text[5:7]}-{text[0:4]}"
    return text


def _cell_value(key, value):
    if key in ("assembledDate", "packagedDate", "lastUpdated"):
        return _date_text(value)
    if key == "inBoq":
        return "Linked" if value else "Not in BOQ"
    if isinstance(value, (int, float)):
        return value
    return "" if value is None else str(value)


def _title_block(sheet, title, subtitle, width):
    sheet.merge_cells(start_row=1, start_column=1, end_row=1, end_column=width)
    sheet.merge_cells(start_row=2, start_column=1, end_row=2, end_column=width)
    sheet["A1"] = title
    sheet["A1"].font = Font(bold=True, size=15, color=DARK)
    sheet["A2"] = subtitle
    sheet["A2"].font = Font(italic=True, size=10, color="6B6B6B")
    sheet.row_dimensions[1].height = 24
    # A thin brand-red rule under the title.
    for column in range(1, width + 1):
        sheet.cell(row=3, column=column).border = Border(top=Side(style="medium", color=BRAND_RED))


def _table_sheet(workbook, name, title, subtitle, columns, rows, status_key=None, alert_word=None):
    sheet = workbook.create_sheet(name)
    width = len(columns)
    _title_block(sheet, title, subtitle, width)
    header_row = 4
    for index, (_, label, column_width) in enumerate(columns, start=1):
        cell = sheet.cell(row=header_row, column=index, value=label)
        cell.font = Font(bold=True, color="FFFFFF")
        cell.fill = PatternFill("solid", fgColor=DARK)
        cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
        cell.border = BORDER
        sheet.column_dimensions[get_column_letter(index)].width = column_width
    sheet.row_dimensions[header_row].height = 30

    for offset, row in enumerate(rows, start=1):
        excel_row = header_row + offset
        status = str(row.get(status_key) or "").strip().lower() if status_key else ""
        fill_color = STATUS_FILLS.get(status)
        if alert_word and alert_word in status:
            fill_color = STATUS_FILLS["sold"]
        if not fill_color and offset % 2 == 0:
            fill_color = "F7F5F1"  # zebra stripe
        for index, (key, _, _) in enumerate(columns, start=1):
            value = _cell_value(key, row.get(key))
            cell = sheet.cell(row=excel_row, column=index, value=value)
            cell.border = BORDER
            cell.alignment = Alignment(vertical="center", horizontal="right" if isinstance(value, (int, float)) else "left",
                                       wrap_text=key == "desc")
            if fill_color:
                cell.fill = PatternFill("solid", fgColor=fill_color)
            if key == status_key:
                cell.font = Font(bold=True)

    if not rows:
        sheet.merge_cells(start_row=header_row + 1, start_column=1, end_row=header_row + 1, end_column=width)
        sheet.cell(row=header_row + 1, column=1, value="No records").font = Font(italic=True, color="6B6B6B")

    total_row = header_row + len(rows) + 2
    sheet.cell(row=total_row, column=1, value=f"Total: {len(rows)} record{'s' if len(rows) != 1 else ''}").font = Font(bold=True)
    sheet.freeze_panes = sheet.cell(row=header_row + 1, column=1)
    if rows:
        sheet.auto_filter.ref = f"A{header_row}:{get_column_letter(width)}{header_row + len(rows)}"
    sheet.sheet_view.showGridLines = False
    sheet.page_setup.orientation = "landscape"
    sheet.page_setup.fitToWidth = 1
    sheet.print_title_rows = f"{header_row}:{header_row}"
    return sheet


def build_workbook(materials, generated_at):
    if not OPENPYXL_AVAILABLE:
        raise RuntimeError(
            "openpyxl is required to generate the weekly stock register Excel export. "
            "Install backend requirements or add openpyxl to the environment."
        )

    stamp = generated_at.strftime("%A, %d %b %Y")
    workbook = Workbook()
    workbook.remove(workbook.active)
    _table_sheet(
        workbook,
        "Stock Register",
        "Vector - Stock Register",
        f"Stock Register > Table View · as on {stamp}",
        MATERIAL_COLUMNS,
        materials,
        status_key="status",
        alert_word="reorder",
    )

    buffer = io.BytesIO()
    workbook.save(buffer)
    return buffer.getvalue()


# ---------------------------------------------------------------------------
# Email
# ---------------------------------------------------------------------------

def build_email(generated_at):
    """Build the weekly attachment email with its report date and no summary."""
    esc = daily_report._esc
    app_url = os.getenv("APP_FRONTEND_URL", "https://production.vector-power.com").rstrip("/")
    logo_src = daily_report.email_logo_src()
    as_on = generated_at.strftime("%A, %d %b %Y")
    subject = f"Vector weekly power conditioner stock - {generated_at.strftime('%d %b %Y')}"
    text_style = "font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.6;color:#1f1f1f;"
    body = f"""<!doctype html>
<html><body style="margin:0;padding:0;background:#f5f4f1;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f4f1;padding:24px 12px;">
<tr><td align="center">
<table role="presentation" width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%;background:#ffffff;border-radius:12px;">
  <tr><td align="right" style="padding:22px 28px 6px;">
    <img src="{esc(logo_src)}" alt="Vector" width="48" height="51" style="display:inline-block;width:48px;height:51px;border:0;">
  </td></tr>
  <tr><td style="padding:6px 28px 0;{text_style}">
    <p style="margin:0 0 12px;">Dear <b>Team</b>,</p>
    <p style="margin:0 0 16px;">Please find attached the weekly power conditioner stock as on <b>{esc(as_on)}</b>.</p>
  </td></tr>
  <tr><td style="padding:16px 28px 0;{text_style}">
    <p style="margin:0 0 4px;">Regards,</p>
    <p style="margin:0 0 20px;"><b>Vector Production</b></p>
  </td></tr>
  <tr><td align="center" style="padding:8px 24px 8px;font-family:Arial,Helvetica,sans-serif;">
    <a href="{esc(app_url)}/stock"
       style="display:inline-block;background:{daily_report.BRAND_RED};color:#ffffff;text-decoration:none;font-size:15px;font-weight:700;padding:13px 30px;border-radius:8px;">
      Open the Stock Register
    </a>
    <p style="margin:10px 0 16px;font-size:11px;color:#777777;">
      This is a system-generated report. Powered by Vector Production.
    </p>
  </td></tr>
</table>
</td></tr></table>
</body></html>"""
    lines = [
        "Dear Team,",
        "",
        f"Please find attached the weekly power conditioner stock as on {as_on}.",
        "",
        "Regards,",
        "Vector Production",
        "",
        f"Open the Stock Register: {app_url}/stock",
        "",
        "This is a system-generated report. Powered by Vector Production.",
    ]
    return subject, body, "\n".join(lines)


def build_report(now=None):
    """Everything one weekly email needs: (subject, html, text, attachment)."""
    now = now or datetime.now(IST)
    materials = load_data()
    workbook = build_workbook(materials, now)
    filename = f"Vector-Stock-Register-{now.strftime('%Y-%m-%d')}.xlsx"
    subject, html, text = build_email(now)
    return subject, html, text, (filename, workbook, XLSX_MIME)


# ---------------------------------------------------------------------------
# Weekly schedule
# ---------------------------------------------------------------------------

_handled_week = {"key": None}


def _week_key(day):
    year, week, _ = day.isocalendar()
    return f"{year}-W{week:02d}"


def _send_day_of_week(today, settings):
    """The day this ISO week's email is due: the configured weekday, or the
    first working day after it."""
    monday = today - timedelta(days=today.weekday())
    day = monday + timedelta(days=_send_weekday(settings))
    for _ in range(7):
        if daily_report._is_business_day(day, settings):
            return day
        day += timedelta(days=1)
    return None


def _next_weekly_send_at(now, settings, state):
    """Return the next weekly send time, including a next-business-day shift."""
    if not _enabled() or not settings.get("weekly_enabled") or not settings.get("recipients"):
        return None
    hour, minute = (int(part) for part in settings["weekly_send_time"].split(":"))
    monday = now.date() - timedelta(days=now.weekday())
    for week_offset in range(-1, 10):
        week_start = monday + timedelta(days=week_offset * 7)
        send_day = _send_day_of_week(week_start, settings)
        if send_day is None or send_day < now.date():
            continue
        week_key = _week_key(week_start)
        if state.get("last_sent_week") == week_key:
            continue
        due = datetime(
            send_day.year, send_day.month, send_day.day, hour, minute,
            tzinfo=daily_report.IST,
        )
        return max(due, now) if send_day == now.date() else due
    return None


@firestore.transactional
def _claim_week(transaction, week_key):
    snapshot = STATE_REF.get(transaction=transaction)
    state = snapshot.to_dict() if snapshot.exists else {}
    if state.get("last_sent_week") == week_key:
        return False
    transaction.set(STATE_REF, {
        "last_sent_week": week_key,
        "last_status": "sending",
        "last_attempt_at": datetime.now(timezone.utc),
    }, merge=True)
    return True


def send_weekly_if_due(now=None):
    """Send this week's stock register email when it is due."""
    if not _enabled():
        return "disabled"
    now = now or datetime.now(IST)
    today = now.date()
    settings = daily_report.cached_settings()
    if not settings.get("weekly_enabled"):
        return "disabled"
    if not settings.get("recipients"):
        return "no recipients"
    anchor_monday = today - timedelta(days=today.weekday())
    if _send_day_of_week(anchor_monday, settings) == today:
        week = _week_key(anchor_monday)
    else:
        previous_monday = anchor_monday - timedelta(days=7)
        if _send_day_of_week(previous_monday, settings) != today:
            return "not the send day"
        week = _week_key(previous_monday)
    if _handled_week["key"] == week:
        return "already sent"
    hour, minute = (int(part) for part in settings["weekly_send_time"].split(":"))
    if (now.hour, now.minute) < (hour, minute):
        return "not yet time"
    if not _claim_week(db.transaction(), week):
        _handled_week["key"] = week
        return "already sent"
    _handled_week["key"] = week
    try:
        subject, html, text, attachment = build_report(now)
        send_html_email(settings["recipients"], subject, html, text, attachments=[attachment])
        STATE_REF.set({
            "last_status": "sent",
            "last_sent_at": datetime.now(timezone.utc),
            "last_recipients": settings["recipients"],
            "last_error": "",
        }, merge=True)
        logger.info("weekly stock register sent to %d recipient(s)", len(settings["recipients"]))
        return "sent"
    except Exception as exc:
        STATE_REF.set({"last_status": "failed", "last_error": str(exc)[:500]}, merge=True)
        logger.exception("weekly stock register failed")
        return f"failed: {exc}"


@weekly_stock_report_bp.route("/alerts/weekly-stock-report/run", methods=["POST"])
def run_weekly_stock_report():
    """Scheduler hook (weekly cron): same 'send if due' check as the thread."""
    secret = os.getenv("ALERTS_CRON_SECRET", "").strip()
    if not secret or request.headers.get("X-Cron-Secret", "") != secret:
        return jsonify({"success": False, "message": "Forbidden"}), 403
    return jsonify({"success": True, "result": send_weekly_if_due()}), 200


# ---------------------------------------------------------------------------
# Alerts page: preview / download / test (never touch the schedule)
# ---------------------------------------------------------------------------

WEEKDAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]


def _schedule_info():
    snapshot = STATE_REF.get()
    state = snapshot.to_dict() if snapshot.exists else {}
    sent_at = state.get("last_sent_at")
    daily_settings = daily_report.cached_settings()
    next_send_at = _next_weekly_send_at(datetime.now(daily_report.IST), daily_settings, state)
    return {
        "enabled": _enabled(),
        "weeklyEnabled": bool(daily_settings.get("weekly_enabled")),
        "sendDay": WEEKDAY_NAMES[_send_weekday(daily_settings)],
        "sendTime": daily_settings.get("weekly_send_time", daily_settings.get("send_time", "09:00")),
        "nextSendAt": next_send_at.isoformat() if next_send_at else None,
        "dailyEnabled": bool(daily_settings.get("enabled")),
        "recipientCount": len(daily_settings.get("recipients") or []),
        "lastSentAt": sent_at.isoformat() if hasattr(sent_at, "isoformat") else sent_at,
        "lastStatus": state.get("last_status", ""),
        "lastError": state.get("last_error", ""),
    }


@weekly_stock_report_bp.route("/alerts/weekly-stock-report/status", methods=["GET"])
@roles_required(*daily_report.ALERT_ROLES)
def weekly_stock_report_status():
    """Schedule metadata for the Alerts page; does not load stock data."""
    try:
        return jsonify({"success": True, "schedule": _schedule_info()}), 200
    except Exception as exc:
        return jsonify({"success": False, "message": f"Failed to load weekly report schedule: {exc}"}), 500


@weekly_stock_report_bp.route("/alerts/weekly-stock-report/preview", methods=["GET"])
@roles_required(*daily_report.ALERT_ROLES)
def preview_weekly_stock_report():
    """The weekly email as it would be sent now (HTML + summary), nothing sent."""
    try:
        subject, html, _, (filename, _, _) = build_report()
        html = html.replace('src="cid:vector-logo"', 'src="/images/vector-pdf.png"')
        return jsonify({"success": True, "subject": subject, "html": html, "filename": filename,
                        "schedule": _schedule_info()}), 200
    except Exception as exc:
        return jsonify({"success": False, "message": f"Failed to build the preview: {exc}"}), 500


@weekly_stock_report_bp.route("/alerts/weekly-stock-report/excel", methods=["GET"])
@roles_required(*STOCK_DOWNLOAD_ROLES)
def download_weekly_stock_excel():
    """The workbook the weekly email attaches, as a download."""
    try:
        _, _, _, (filename, workbook, mime) = build_report()
        return Response(workbook, mimetype=mime, headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Cache-Control": "no-store",
        })
    except Exception as exc:
        return jsonify({"success": False, "message": f"Failed to build the Excel file: {exc}"}), 500


@weekly_stock_report_bp.route("/alerts/weekly-stock-report/send-test", methods=["POST"])
@roles_required(*daily_report.ALERT_ROLES)
def send_test_weekly_stock_report():
    """Send the weekly email now, to one address or every saved recipient.

    Marked "[Test]" and does not count as the week's scheduled email.
    """
    body = request.get_json(silent=True) or {}
    target = str(body.get("email") or "").strip().lower()
    if target and not daily_report.EMAIL_PATTERN.match(target):
        return jsonify({"success": False, "message": "Enter a valid email address"}), 400
    recipients = [target] if target else daily_report.load_settings().get("recipients") or []
    if not recipients:
        return jsonify({"success": False, "message": "Add a recipient or enter an email to send the test to"}), 400
    try:
        subject, html, text, attachment = build_report()
        send_html_email(recipients, f"[Test] {subject}", html, text, attachments=[attachment])
        return jsonify({"success": True, "message": f"Weekly test email sent to {', '.join(recipients)} with {attachment[0]}"}), 200
    except Exception as exc:
        return jsonify({"success": False, "message": f"Could not send the email: {exc}"}), 502


# ---------------------------------------------------------------------------
# Preview / test commands (never touch the schedule)
# ---------------------------------------------------------------------------

def preview(out_dir=None, open_browser=False):
    """Build the workbook + email HTML, save both, return their paths and the HTML."""
    subject, html, _, (filename, workbook, _) = build_report()
    out_dir = os.path.abspath(out_dir or os.path.join(os.path.dirname(os.path.abspath(__file__)), "preview_output"))
    os.makedirs(out_dir, exist_ok=True)
    xlsx_path = os.path.join(out_dir, filename)
    html_path = os.path.join(out_dir, filename.replace(".xlsx", "-email.html"))
    with open(xlsx_path, "wb") as handle:
        handle.write(workbook)
    logo_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets", "vector-logo.png")
    with open(html_path, "w", encoding="utf-8") as handle:
        handle.write(html.replace('src="cid:vector-logo"', f'src="file:///{logo_file.replace(os.sep, "/")}"'))
    if open_browser:
        import webbrowser
        webbrowser.open(f"file:///{html_path.replace(os.sep, '/')}")
    return {"subject": subject, "xlsx": xlsx_path, "html_file": html_path, "html": html}


def test_send(address):
    subject, html, text, attachment = build_report()
    send_html_email([address], f"[Test] {subject}", html, text, attachments=[attachment])
    return f"Test email sent to {address} with {attachment[0]}"


def _main(argv):
    import argparse
    parser = argparse.ArgumentParser(description="Weekly stock register email - preview / test")
    commands = parser.add_subparsers(dest="command", required=True)
    p_preview = commands.add_parser("preview", help="build the Excel + email HTML, send nothing")
    p_preview.add_argument("--out", help="folder for the files (default: backend/preview_output)")
    p_preview.add_argument("--open", action="store_true", help="open the email HTML in the browser")
    p_test = commands.add_parser("test-send", help="send to one test address only")
    p_test.add_argument("--to", required=True, help="the test address")
    args = parser.parse_args(argv)

    if args.command == "preview":
        result = preview(args.out, args.open)
        print(f"Subject : {result['subject']}")
        print(f"Excel   : {result['xlsx']}")
        print(f"HTML    : {result['html_file']}")
        print("\n----- email HTML -----\n" + result["html"])
    else:
        print(test_send(args.to.strip()))


if __name__ == "__main__":
    _main(sys.argv[1:])
