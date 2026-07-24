"""Discord delivery via an incoming webhook. Chunks long narratives to respect
Discord's 2000-char-per-message limit.
"""

from __future__ import annotations

import logging

import requests

from ..models import Digest

log = logging.getLogger(__name__)

_MAX = 1900  # leave headroom under Discord's 2000 limit


def send(digest: Digest, settings) -> None:
    url = settings.discord_webhook_url
    if not url:
        log.warning("Discord selected but DISCORD_WEBHOOK_URL is empty (skipping).")
        return
    for chunk in _chunks(digest.narrative, _MAX):
        resp = requests.post(url, json={"content": chunk}, timeout=30)
        resp.raise_for_status()


def _chunks(text: str, size: int):
    """Split on paragraph boundaries where possible, then hard-wrap."""
    buf = ""
    for para in text.split("\n"):
        if len(buf) + len(para) + 1 > size:
            if buf:
                yield buf
            while len(para) > size:
                yield para[:size]
                para = para[size:]
            buf = para
        else:
            buf = f"{buf}\n{para}" if buf else para
    if buf:
        yield buf
