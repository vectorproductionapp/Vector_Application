import hashlib
import hmac
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


def _otp_email_html(otp):
    return f"""
    <div style="font-family:Arial,sans-serif;color:#242424;line-height:1.5">
      <h2 style="margin-bottom:8px">Reset your Vector password</h2>
      <p>Use this verification code to continue:</p>
      <p style="font-size:30px;font-weight:700;letter-spacing:8px;margin:24px 0">
        {otp}
      </p>
      <p>This code expires in {OTP_EXPIRY_MINUTES} minutes.</p>
      <p style="color:#666">If you did not request this reset, you can ignore this email.</p>
    </div>
    """


def _send_microsoft_graph_email(settings, email, otp):
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
                    "content": _otp_email_html(otp),
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


def _send_smtp_email(settings, email, otp):
    message = EmailMessage()
    message["Subject"] = "Your Vector password reset code"
    message["From"] = settings["sender"]
    message["To"] = email
    message.set_content(
        "\n".join(
            [
                "Use this verification code to reset your Vector password:",
                "",
                otp,
                "",
                f"This code expires in {OTP_EXPIRY_MINUTES} minutes.",
                "If you did not request a password reset, you can ignore this email.",
            ]
        )
    )
    message.add_alternative(_otp_email_html(otp), subtype="html")

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


def _send_otp_email(email, otp):
    settings = _mail_settings()
    if settings["provider"] == "microsoft_graph":
        _send_microsoft_graph_email(settings, email, otp)
        return
    _send_smtp_email(settings, email, otp)


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
        _send_otp_email(email, otp)
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
