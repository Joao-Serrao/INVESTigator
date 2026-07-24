"""Email delivery via SMTP (e.g. Gmail app password, or any provider)."""

from __future__ import annotations

import logging
import smtplib
from email.mime.text import MIMEText

from ..models import Digest

log = logging.getLogger(__name__)


def _send_raw(cfg: dict, subject: str, body: str) -> None:
    """Send one message. Raises on any problem so callers can surface the reason."""
    # Sender defaults to the login user (the usual case: you email yourself).
    sender = cfg.get("from") or cfg.get("user")
    recipient = cfg.get("to") or sender
    missing = [n for n, v in (("SMTP host", cfg.get("host")), ("your email", sender),
                              ("recipient", recipient)) if not v]
    if missing:
        raise ValueError("Email not configured — missing: " + ", ".join(missing))

    # Gmail/others display app passwords as "abcd efgh ijkl mnop"; the spaces are
    # presentational and must be removed before authenticating.
    password = (cfg.get("password") or "").replace(" ", "")

    msg = MIMEText(body, "plain", "utf-8")
    msg["Subject"] = subject
    msg["From"] = sender
    msg["To"] = recipient

    with smtplib.SMTP(cfg["host"], int(cfg.get("port") or 587), timeout=30) as server:
        server.starttls()
        if cfg.get("user"):
            server.login(cfg["user"], password)
        server.sendmail(sender, [a.strip() for a in recipient.split(",")], msg.as_string())


def send(digest: Digest, settings) -> None:
    subject = f"Investraton — {digest.period.title()} Digest ({digest.generated_at:%Y-%m-%d})"
    _send_raw(settings.smtp, subject, digest.narrative)


def send_test(settings) -> None:
    """Send a short test email. Raises on failure (used by the 'Send test email' button)."""
    _send_raw(
        settings.smtp,
        "Investraton — test email ✅",
        "This is a test from Investraton. If you received it, your email delivery is working.\n"
        "You can now set Email as a delivery channel for your digests.",
    )
