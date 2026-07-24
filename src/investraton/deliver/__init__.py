"""Delivery layer. Each channel takes a finished Digest and pushes its narrative.
Channels are selected by config (console / discord / email) and fail independently
so one broken channel never blocks the others.
"""

from __future__ import annotations

import logging

from ..models import Digest
from . import console, discord, email

log = logging.getLogger(__name__)

_CHANNELS = {
    "console": console.send,
    "discord": discord.send,
    "email": email.send,
}


def deliver(digest: Digest, settings) -> list[dict]:
    """Send to every configured channel, isolating failures. Returns a per-channel
    report so the app can SHOW what succeeded/failed instead of hiding it in logs."""
    report = []
    for channel in settings.delivery:
        fn = _CHANNELS.get(channel)
        if fn is None:
            log.warning("Unknown delivery channel '%s' (skipping).", channel)
            report.append({"channel": channel, "ok": False, "error": "unknown channel"})
            continue
        try:
            fn(digest, settings)
            report.append({"channel": channel, "ok": True})
        except Exception as e:  # noqa: BLE001 - isolate channel failures
            log.error("Delivery via '%s' failed: %s", channel, e)
            report.append({"channel": channel, "ok": False, "error": f"{type(e).__name__}: {e}"})
    return report
