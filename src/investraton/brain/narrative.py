"""Turns a computed Digest into prose.

Flow: build a fact-only prompt from the already-scored events -> ask the LLM ->
if the LLM returns nothing (template provider, or a failed call), fall back to a
deterministic Markdown rendering. Either way the numbers come from the engine.
"""

from __future__ import annotations

import logging

from ..models import Digest
from .llm import LLM, TemplateLLM

log = logging.getLogger(__name__)


def build_narrative(digest: Digest, llm: LLM) -> str:
    """The digest body is ALWAYS the deterministic template (correct numbers).

    The LLM only contributes a short, qualitative summary line on top — it can no
    longer invent figures or whole sections, because every number/item is rendered
    from the engine's computed data, not from the model's output.
    """
    summary = ""
    if not isinstance(llm, TemplateLLM):
        try:
            summary = (llm.generate(_summary_prompt(digest)) or "").strip()
        except Exception:  # noqa: BLE001 - never let the brain break delivery
            log.warning("LLM summary failed (%s); using template only.", llm.name)
    return _template_narrative(digest, summary)


def _summary_prompt(digest: Digest) -> str:
    lines = [
        "You are summarising a personal investment digest in 2-3 short sentences.",
        "STRICT RULES: do NOT state any euro amounts, percentages, prices or holdings — "
        "speak only qualitatively (e.g. 'a quiet week', 'concentration is in tech'). "
        "Do NOT invent events or positions. No buy/sell/hold advice. Plain text only.",
        "",
        f"Events this period: {len(digest.events)} owned, {len(digest.watchlist)} on watchlist.",
    ]
    if digest.events:
        lines.append("Top items: " + "; ".join(f"{e.ticker} ({e.kind})" for e in digest.events[:4]))
    if digest.structure:
        lines.append("Structure notes: " + "; ".join(f.title for f in digest.structure[:4]))
    if not digest.events and not digest.watchlist:
        lines.append("Nothing notable cleared the threshold this period.")
    lines.append("\nWrite the 2-3 sentence qualitative summary now:")
    return "\n".join(lines)


def _template_narrative(digest: Digest, summary: str = "") -> str:
    """Deterministic Markdown — the authoritative digest body. All numbers come
    from the engine. An optional qualitative `summary` (from the LLM) sits on top."""
    value = (
        f"Portfolio ≈ €{digest.portfolio_total_eur:,.0f}"
        if digest.amounts_provided
        else "Amounts not set"
    )
    out = [
        f"# Investraton — {digest.period.title()} Digest",
        f"_Generated {digest.generated_at:%Y-%m-%d %H:%M UTC} · {value} · {digest.data_freshness}_",
        "",
    ]
    if summary:
        out += [f"> 🧠 _{summary}_", ""]

    # --- What happened (events) ---
    out.append("## What happened")
    if not digest.events:
        out.append("Nothing cleared your relevance threshold this period. Quiet is good. ✅\n")
    else:
        by_sev = {"high": [], "medium": [], "low": []}
        for e in digest.events:
            by_sev.get(e.severity, by_sev["low"]).append(e)
        out.append(
            f"**{len(digest.events)} item(s)** cleared your relevance threshold, "
            "ranked by how much they touch *your* capital — not by drama.\n"
        )
        for sev, lab in (("high", "🔴 High"), ("medium", "🟠 Medium"), ("low", "🟡 Low")):
            if not by_sev[sev]:
                continue
            out.append(f"### {lab}")
            for e in by_sev[sev]:
                link = f" ([source]({e.url}))" if e.url else ""
                out.append(f"- **{e.ticker} · {e.headline}**{link}")
                out.append(f"  - _Urgency {e.urgency}/10._ {e.explanation}")
            out.append("")

    # --- On your radar (watchlist / discovery) ---
    if digest.watchlist:
        out.append("## On your radar")
        out.append("_Things you're tracking but don't own yet — discovery context, not advice._\n")
        for e in digest.watchlist:
            link = f" ([source]({e.url}))" if e.url else ""
            out.append(f"- **{e.ticker} · {e.headline}**{link}")
            out.append(f"  - _Urgency {e.urgency}/10._ {e.explanation}")
        out.append("")

    # --- Your structure (look-through / concentration / plan) ---
    if digest.structure:
        out.append("## Your structure")
        icon = {"watch": "🔴", "note": "🟠", "info": "▫️"}
        for f in digest.structure:
            out.append(f"- {icon.get(f.severity, '▫️')} **{f.title}**")
            out.append(f"  - {f.detail}")
        out.append("")

    out.append("_No buy/sell/hold advice — this is context, not a recommendation._")
    return "\n".join(out)
