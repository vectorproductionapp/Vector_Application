"""Send an HTML email through the provider configured for the app.

Reuses the password-reset mail configuration (`MAIL_PROVIDER`, SMTP_* or
MICROSOFT_* variables), so a deployment that can send reset codes can send
reports too. Kept separate from forgot_password.py, whose builders are
specific to the OTP message.
"""

import os
import smtplib
import ssl
from email.message import EmailMessage
from urllib.parse import quote

import requests

from forgot_password import LOGO_CID, _logo_path, _mail_settings


def send_html_email(recipients, subject, html_body, text_body, logo_cid=LOGO_CID):
    """Deliver one message to every address in `recipients`.

    The HTML may reference the Vector logo as `cid:<logo_cid>`; it is embedded
    for SMTP and swapped for EMAIL_LOGO_URL (or dropped) for Microsoft Graph,
    which does not take inline parts on this path.
    """
    recipients = [address for address in (recipients or []) if address]
    if not recipients:
        raise ValueError("No recipients to send to")

    settings = _mail_settings()
    if settings["provider"] == "microsoft_graph":
        _send_graph(settings, recipients, subject, html_body, logo_cid)
    else:
        _send_smtp(settings, recipients, subject, html_body, text_body, logo_cid)


def _send_graph(settings, recipients, subject, html_body, logo_cid):
    logo_url = os.getenv("EMAIL_LOGO_URL", "").strip()
    html_body = html_body.replace(f"cid:{logo_cid}", logo_url) if logo_url else html_body.replace(
        f'src="cid:{logo_cid}"', 'src="" style="display:none"')

    token_response = requests.post(
        f"https://login.microsoftonline.com/{quote(settings['tenant_id'], safe='')}/oauth2/v2.0/token",
        data={
            "client_id": settings["client_id"],
            "client_secret": settings["client_secret"],
            "scope": "https://graph.microsoft.com/.default",
            "grant_type": "client_credentials",
        },
        timeout=15,
    )
    if token_response.status_code >= 400:
        raise RuntimeError(f"Microsoft identity token request failed with status {token_response.status_code}")
    access_token = token_response.json().get("access_token")
    if not access_token:
        raise RuntimeError("Microsoft identity response did not contain an access token")

    response = requests.post(
        f"https://graph.microsoft.com/v1.0/users/{quote(settings['sender'], safe='')}/sendMail",
        headers={"Authorization": f"Bearer {access_token}", "Content-Type": "application/json"},
        json={
            "message": {
                "subject": subject,
                "body": {"contentType": "HTML", "content": html_body},
                "toRecipients": [{"emailAddress": {"address": address}} for address in recipients],
            },
            "saveToSentItems": False,
        },
        timeout=20,
    )
    if response.status_code != 202:
        raise RuntimeError(f"Microsoft Graph sendMail failed with status {response.status_code}")


def _send_smtp(settings, recipients, subject, html_body, text_body, logo_cid):
    logo_path = _logo_path()
    embeds_logo = f"cid:{logo_cid}" in html_body
    if not logo_path and embeds_logo:
        html_body = html_body.replace(f'src="cid:{logo_cid}"', 'src="" style="display:none"')

    body = EmailMessage()
    body.set_content(text_body)
    body.add_alternative(html_body, subtype="html")

    message = body
    if logo_path and embeds_logo:
        # multipart/related(alternative(text, html) + inline logo), assembled
        # explicitly for the same reason as the password-reset message.
        message = EmailMessage()
        message.make_related()
        message.attach(body)
        with open(logo_path, "rb") as handle:
            message.add_related(
                handle.read(), maintype="image", subtype="png",
                cid=f"<{logo_cid}>", filename="vector-logo.png", disposition="inline",
            )

    message["Subject"] = subject
    message["From"] = settings["sender"]
    message["To"] = ", ".join(recipients)

    context = ssl.create_default_context()
    smtp_class = smtplib.SMTP_SSL if settings["use_ssl"] else smtplib.SMTP
    smtp_kwargs = {"host": settings["host"], "port": settings["port"], "timeout": 20}
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
