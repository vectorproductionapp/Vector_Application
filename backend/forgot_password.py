import hashlib
import hmac
import html
import os
import re
import secrets
import smtplib
import ssl
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from urllib.parse import quote
 
import bcrypt
import requests
from flask import Blueprint, current_app, jsonify, request
 
from firebase_config import db, users_collection
 
 
forgot_password_bp = Blueprint("forgot_password", __name__)
reset_requests_collection = db.collection("password_reset_requests")
 
EMAIL_PATTERN = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
OTP_PATTERN = re.compile(r"^\d{6}$")
OTP_EXPIRY_MINUTES = int(os.getenv("PASSWORD_RESET_OTP_MINUTES", "10"))
RESET_TOKEN_EXPIRY_MINUTES = int(os.getenv("PASSWORD_RESET_TOKEN_MINUTES", "10"))
RESEND_COOLDOWN_SECONDS = int(os.getenv("PASSWORD_RESET_RESEND_SECONDS", "60"))
MAX_OTP_ATTEMPTS = int(os.getenv("PASSWORD_RESET_MAX_ATTEMPTS", "5"))
 
 
def _now():
    return datetime.now(timezone.utc)
 
 
def _as_utc(value):
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)
 
 
def _request_id(email):
    return hashlib.sha256(email.encode("utf-8")).hexdigest()
 
 
def _reset_secret():
    return (
        os.getenv("PASSWORD_RESET_SECRET")
        or os.getenv("JWT_SECRET")
        or "change-this-in-production"
    ).encode("utf-8")
 
 
def _digest(email, value, purpose):
    payload = f"{purpose}:{email}:{value}".encode("utf-8")
    return hmac.new(_reset_secret(), payload, hashlib.sha256).hexdigest()
 
 
def _bool_env(name, default=False):
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}
 
 
def _mail_settings():
    provider = os.getenv("MAIL_PROVIDER", "microsoft_graph").strip().lower()
    if provider in {"microsoft", "microsoft_graph", "graph", "outlook", "office365"}:
        settings = {
            "provider": "microsoft_graph",
            "tenant_id": os.getenv("MICROSOFT_TENANT_ID", "").strip(),
            "client_id": os.getenv("MICROSOFT_CLIENT_ID", "").strip(),
            "client_secret": os.getenv("MICROSOFT_CLIENT_SECRET", ""),
            "sender": os.getenv("MICROSOFT_SENDER_EMAIL", "").strip(),
        }
        missing = [
            name
            for name, value in (
                ("MICROSOFT_TENANT_ID", settings["tenant_id"]),
                ("MICROSOFT_CLIENT_ID", settings["client_id"]),
                ("MICROSOFT_CLIENT_SECRET", settings["client_secret"]),
                ("MICROSOFT_SENDER_EMAIL", settings["sender"]),
            )
            if not value
        ]
        if missing:
            raise RuntimeError(
                f"Microsoft Graph email configuration is missing: {', '.join(missing)}"
            )
        return settings
 
    if provider != "smtp":
        raise RuntimeError(
            "MAIL_PROVIDER must be microsoft_graph or smtp"
        )
 
    host = os.getenv("SMTP_HOST", "").strip()
    sender = os.getenv("SMTP_FROM_EMAIL", "").strip()
    if not host or not sender:
        raise RuntimeError("SMTP_HOST and SMTP_FROM_EMAIL must be configured")
 
    return {
        "provider": "smtp",
        "host": host,
        "port": int(os.getenv("SMTP_PORT", "587")),
        "username": os.getenv("SMTP_USERNAME", "").strip(),
        "password": os.getenv("SMTP_PASSWORD", ""),
        "sender": sender,
        "use_tls": _bool_env("SMTP_USE_TLS", True),
        "use_ssl": _bool_env("SMTP_USE_SSL", False),
    }
 
 
BRAND_RED = "#e31b23"
BRAND_DARK = "#1f1f1f"
BRAND_MUTED = "#6b6b6b"
BRAND_TINT = "#fdf1f2"
 
LOGO_CID = "vector-logo"
LOGO_DISPLAY_WIDTH = 96
LOGO_FILENAME = "vector-pdf.png"
 
 
def _logo_path():
    """Locate the Vector logo, preferring the shared public/images folder.
 
    The backend Docker image only contains the ``backend`` directory, so
    ``public/images`` exists locally only. ``backend/assets`` is kept as a
    fallback for production builds.
    """
    configured = os.getenv("EMAIL_LOGO_PATH", "").strip()
    backend_dir = os.path.dirname(os.path.abspath(__file__))
    repo_dir = os.path.dirname(backend_dir)
    candidates = [configured] if configured else []
    candidates.append(os.path.join(repo_dir, "public", "images", LOGO_FILENAME))
    candidates.append(os.path.join(backend_dir, "assets", "vector-logo.png"))
    for candidate in candidates:
        if candidate and os.path.isfile(candidate):
            return candidate
    return None
 
 
def _frontend_url():
    return os.getenv("APP_FRONTEND_URL", "https://production.vector-power.com").rstrip("/")
 
 
def _escape(value):
    return html.escape(str(value or ""), quote=True)
 
 
def _logo_image_size():
    """Return (width, height) for the embedded logo, preserving aspect ratio.
 
    Both the ``width``/``height`` attributes and the inline style must agree:
    Gmail scales an image with only ``width`` set far larger than intended.
    """
    logo_path = _logo_path()
    if not logo_path:
        return None
    width = LOGO_DISPLAY_WIDTH
    try:
        with open(logo_path, "rb") as handle:
            header = handle.read(32)
        if header[:8] != b"\x89PNG\r\n\x1a\n":
            return width, None
        # PNG IHDR: width and height are big-endian uint32 at bytes 16 and 20.
        native_width = int.from_bytes(header[16:20], "big")
        native_height = int.from_bytes(header[20:24], "big")
        if not native_width or not native_height:
            return width, None
        return width, round(width * native_height / native_width)
    except (OSError, ValueError):
        return width, None
 
 
def _otp_email_html(otp, name="", logo_src=""):
    greeting = f"Hello {_escape(name)}," if name else "Hello,"
    app_url = _frontend_url()
    logo_size = _logo_image_size() if logo_src else None
    if logo_size:
        width, height = logo_size
        dimensions = f'width="{width}" height="{height}" '
        styles = f"width:{width}px;height:{height}px;"
    else:
        dimensions = ""
        styles = ""
    logo_markup = (
        f'<img src="{_escape(logo_src)}" alt="Vector" {dimensions}'
        f'style="display:block;{styles}max-width:100%;border:0;margin:0 auto;" />'
        if logo_src
        else ""
    )
    return f"""<!DOCTYPE html>
<html lang="en">
  <body style="margin:0;padding:0;background:{BRAND_TINT};">
    <div style="background:{BRAND_TINT};padding:32px 16px;font-family:Arial,Helvetica,sans-serif;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td align="center">
            <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"
                   style="width:100%;max-width:600px;background:#ffffff;border-radius:14px;overflow:hidden;">
              <tr>
                <td align="center" style="padding:32px 32px 8px;">
                  {logo_markup}
                </td>
              </tr>
              <tr>
                <td align="center" style="padding:12px 32px 0;">
                  <p style="margin:0;font-size:13px;font-weight:700;letter-spacing:2px;color:{BRAND_RED};">
                    VECTOR PRODUCTION MANAGEMENT
                  </p>
                </td>
              </tr>
              <tr>
                <td style="padding:20px 32px 0;">
                  <h1 style="margin:0;font-size:26px;line-height:1.3;font-weight:700;color:{BRAND_DARK};">
                    Reset your password
                  </h1>
                </td>
              </tr>
              <tr>
                <td style="padding:16px 32px 0;font-size:15px;line-height:1.6;color:{BRAND_DARK};">
                  <p style="margin:0 0 12px;">{greeting}</p>
                  <p style="margin:0;">
                    We received a request to reset the password for your
                    <strong>Vector Production Management Application</strong> account.
                    Use the verification code below to continue.
                  </p>
                </td>
              </tr>
              <tr>
                <td style="padding:20px 32px 0;">
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
                         style="width:100%;background:{BRAND_TINT};border-radius:10px;">
                    <tr>
                      <td style="padding:18px;font-size:14px;color:{BRAND_MUTED};text-align:center;">
                        Verification code
                        <div style="padding-top:8px;">
                          <span style="display:inline-block;font-size:30px;font-weight:700;letter-spacing:8px;color:{BRAND_DARK};">{_escape(otp)}</span>
                        </div>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
              <tr>
                <td align="center" style="padding:26px 32px 0;">
                  <a href="{_escape(app_url)}/login"
                     style="display:inline-block;background:{BRAND_RED};color:#ffffff;text-decoration:none;
                            font-size:15px;font-weight:700;padding:13px 30px;border-radius:8px;">
                    Sign in to Vector
                  </a>
                </td>
              </tr>
              <tr>
                <td align="center" style="padding:20px 32px 32px;font-size:12px;line-height:1.6;color:{BRAND_MUTED};">
                  This code expires in {OTP_EXPIRY_MINUTES} minutes.<br />
                  If you were not expecting this password reset, please ignore this email or contact your Vector administrator.
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </div>
  </body>
</html>"""
 
 
def _otp_email_text(otp):
    return "\n".join(
        [
            "Reset your Vector password",
            "",
            "Use this verification code to continue:",
            "",
            otp,
            "",
            f"This code expires in {OTP_EXPIRY_MINUTES} minutes.",
            "If you were not expecting this password reset, you can ignore this email.",
        ]
    )
 
 
def _send_microsoft_graph_email(settings, email, otp, user=None):
    user = user or {}
    token_response = requests.post(
        (
            "https://login.microsoftonline.com/"
            f"{quote(settings['tenant_id'], safe='')}/oauth2/v2.0/token"
        ),
        data={
            "client_id": settings["client_id"],
            "client_secret": settings["client_secret"],
            "scope": "https://graph.microsoft.com/.default",
            "grant_type": "client_credentials",
        },
        timeout=10,
    )
    if token_response.status_code >= 400:
        raise RuntimeError(
            f"Microsoft identity token request failed with status {token_response.status_code}"
        )
 
    access_token = token_response.json().get("access_token")
    if not access_token:
        raise RuntimeError("Microsoft identity response did not contain an access token")
 
    sender = quote(settings["sender"], safe="")
    send_response = requests.post(
        f"https://graph.microsoft.com/v1.0/users/{sender}/sendMail",
        headers={
            "Authorization": f"Bearer {access_token}",
            "Content-Type": "application/json",
        },
        json={
            "message": {
                "subject": "Your Vector password reset code",
                "body": {
                    "contentType": "HTML",
                    "content": _otp_email_html(
                        otp,
                        name=user.get("name"),
                        logo_src=os.getenv("EMAIL_LOGO_URL", "").strip(),
                    ),
                },
                "toRecipients": [
                    {"emailAddress": {"address": email}}
                ],
            },
            "saveToSentItems": False,
        },
        timeout=10,
    )
    if send_response.status_code != 202:
        raise RuntimeError(
            f"Microsoft Graph sendMail failed with status {send_response.status_code}"
        )
 
 
def _build_otp_message(settings, email, otp, user):
    """Build multipart/related(alternative(text, html) + inline logo).
 
    Python's ``add_related`` refuses to wrap an existing
    ``multipart/alternative`` in ``multipart/related``, so the structure is
    assembled explicitly: the logo must live in a *related* part that contains
    the alternative body as its first child.
    """
    logo_path = _logo_path()
    logo_src = f"cid:{LOGO_CID}" if logo_path else ""
 
    body = EmailMessage()
    body.set_content(_otp_email_text(otp))
    body.add_alternative(
        _otp_email_html(
            otp,
            name=user.get("name"),
            logo_src=logo_src,
        ),
        subtype="html",
    )
 
    message = body
    if logo_path:
        message = EmailMessage()
        message.make_related()
        message.attach(body)
        with open(logo_path, "rb") as handle:
            message.add_related(
                handle.read(),
                maintype="image",
                subtype="png",
                cid=f"<{LOGO_CID}>",
                filename="vector-logo.png",
                disposition="inline",
            )
 
    message["Subject"] = "Reset your Vector password"
    message["From"] = settings["sender"]
    message["To"] = email
    return message
 
 
def _send_smtp_email(settings, email, otp, user=None):
    user = user or {}
    message = _build_otp_message(settings, email, otp, user)
 
    context = ssl.create_default_context()
    smtp_class = smtplib.SMTP_SSL if settings["use_ssl"] else smtplib.SMTP
    smtp_kwargs = {"host": settings["host"], "port": settings["port"], "timeout": 10}
    if settings["use_ssl"]:
        smtp_kwargs["context"] = context
 
    with smtp_class(**smtp_kwargs) as server:
        if not settings["use_ssl"] and settings["use_tls"]:
            server.ehlo()
            server.starttls(context=context)
            server.ehlo()
        if settings["username"]:
            server.login(settings["username"], settings["password"])
        server.send_message(message)
 
 
def _send_otp_email(email, otp, user=None):
    settings = _mail_settings()
    if settings["provider"] == "microsoft_graph":
        _send_microsoft_graph_email(settings, email, otp, user)
        return
    _send_smtp_email(settings, email, otp, user)
 
 
def _json_body():
    data = request.get_json(silent=True)
    return data if isinstance(data, dict) else {}
 
 
def _valid_email(email):
    return bool(EMAIL_PATTERN.fullmatch(email))
 
 
@forgot_password_bp.post("/forgot-password/request")
def request_password_reset():
    data = _json_body()
    email = (data.get("email") or "").strip().lower()
 
    if not _valid_email(email):
        return jsonify({"success": False, "message": "Enter a valid email address"}), 400
 
    matches = users_collection.where("email", "==", email).limit(1).get()
    if not matches:
        return jsonify({
            "success": False,
            "message": "This email address does not exist.",
        }), 404
 
    try:
        _mail_settings()
    except (RuntimeError, ValueError):
        current_app.logger.exception("Password-reset email is not configured")
        return jsonify({
            "success": False,
            "message": "Password reset email is temporarily unavailable. Contact your administrator.",
        }), 503
 
    now = _now()
    reset_ref = reset_requests_collection.document(_request_id(email))
    existing_snapshot = reset_ref.get()
    existing = existing_snapshot.to_dict() if existing_snapshot.exists else {}
    sent_at = _as_utc(existing.get("sent_at"))
 
    if sent_at:
        elapsed = (now - sent_at).total_seconds()
        if elapsed < RESEND_COOLDOWN_SECONDS:
            retry_after = max(1, int(RESEND_COOLDOWN_SECONDS - elapsed))
            return jsonify({
                "success": False,
                "message": f"Please wait {retry_after} seconds before requesting another code.",
                "retryAfter": retry_after,
            }), 429
 
    user_doc = matches[0]
    user_data = user_doc.to_dict() or {}
    otp = f"{secrets.randbelow(1_000_000):06d}"
 
    reset_ref.set({
        "email": email,
        "user_id": user_doc.id,
        "otp_digest": _digest(email, otp, "otp"),
        "expires_at": now + timedelta(minutes=OTP_EXPIRY_MINUTES),
        "sent_at": now,
        "attempts": 0,
        "verified": False,
        "reset_token_digest": None,
        "reset_token_expires_at": None,
    })
 
    try:
        _send_otp_email(email, otp, user_data)
    except Exception:
        reset_ref.delete()
        current_app.logger.exception("Unable to send password-reset email")
        return jsonify({
            "success": False,
            "message": "The verification email could not be sent. Please try again later.",
        }), 503
 
    return jsonify({
        "success": True,
        "message": "A verification code has been sent to your email.",
        "retryAfter": RESEND_COOLDOWN_SECONDS,
    }), 200
 
 
@forgot_password_bp.post("/forgot-password/verify")
def verify_password_reset_otp():
    data = _json_body()
    email = (data.get("email") or "").strip().lower()
    otp = str(data.get("otp") or "").strip()
 
    if not _valid_email(email) or not OTP_PATTERN.fullmatch(otp):
        return jsonify({"success": False, "message": "Enter the six-digit verification code"}), 400
 
    reset_ref = reset_requests_collection.document(_request_id(email))
    snapshot = reset_ref.get()
    record = snapshot.to_dict() if snapshot.exists else None
    now = _now()
 
    if not record:
        return jsonify({"success": False, "message": "Invalid or expired verification code"}), 400
 
    expires_at = _as_utc(record.get("expires_at"))
    if not expires_at or now >= expires_at:
        reset_ref.delete()
        return jsonify({"success": False, "message": "The verification code has expired"}), 400
 
    attempts = int(record.get("attempts", 0))
    if attempts >= MAX_OTP_ATTEMPTS:
        reset_ref.delete()
        return jsonify({
            "success": False,
            "message": "Too many incorrect attempts. Request a new code.",
        }), 429
 
    expected_digest = record.get("otp_digest") or ""
    submitted_digest = _digest(email, otp, "otp")
    valid_otp = bool(record.get("user_id")) and hmac.compare_digest(
        expected_digest, submitted_digest
    )
 
    if not valid_otp:
        attempts += 1
        reset_ref.update({"attempts": attempts})
        remaining = max(0, MAX_OTP_ATTEMPTS - attempts)
        message = "Invalid verification code"
        if remaining:
            message += f". {remaining} attempt{'s' if remaining != 1 else ''} remaining."
        return jsonify({"success": False, "message": message}), 400
 
    reset_token = secrets.token_urlsafe(32)
    reset_ref.update({
        "verified": True,
        "otp_digest": None,
        "reset_token_digest": _digest(email, reset_token, "reset-token"),
        "reset_token_expires_at": now + timedelta(minutes=RESET_TOKEN_EXPIRY_MINUTES),
    })
 
    return jsonify({
        "success": True,
        "message": "Email verified",
        "resetToken": reset_token,
    }), 200
 
 
@forgot_password_bp.post("/forgot-password/reset")
def reset_password():
    data = _json_body()
    email = (data.get("email") or "").strip().lower()
    reset_token = str(data.get("resetToken") or "").strip()
    new_password = data.get("newPassword") or ""
 
    if not _valid_email(email) or not reset_token:
        return jsonify({"success": False, "message": "The password reset session is invalid"}), 400
    if len(new_password) < 8:
        return jsonify({
            "success": False,
            "message": "Password must be at least 8 characters",
        }), 400
    encoded_password = new_password.encode("utf-8")
    if len(encoded_password) > 72:
        return jsonify({"success": False, "message": "Password is too long"}), 400
 
    reset_ref = reset_requests_collection.document(_request_id(email))
    snapshot = reset_ref.get()
    record = snapshot.to_dict() if snapshot.exists else None
    now = _now()
 
    if not record or not record.get("verified"):
        return jsonify({"success": False, "message": "The password reset session is invalid"}), 400
 
    token_expires_at = _as_utc(record.get("reset_token_expires_at"))
    expected_digest = record.get("reset_token_digest") or ""
    submitted_digest = _digest(email, reset_token, "reset-token")
 
    if (
        not token_expires_at
        or now >= token_expires_at
        or not hmac.compare_digest(expected_digest, submitted_digest)
    ):
        reset_ref.delete()
        return jsonify({"success": False, "message": "The password reset session has expired"}), 400
 
    user_id = record.get("user_id")
    user_ref = users_collection.document(user_id) if user_id else None
    user_snapshot = user_ref.get() if user_ref else None
    if not user_snapshot or not user_snapshot.exists:
        reset_ref.delete()
        return jsonify({"success": False, "message": "The password reset session is invalid"}), 400
 
    password_hash = bcrypt.hashpw(
        encoded_password, bcrypt.gensalt()
    ).decode("utf-8")
    user_ref.update({"password": password_hash})
    reset_ref.delete()
 
    return jsonify({
        "success": True,
        "message": "Password changed successfully. You can now sign in.",
    }), 200
 

 