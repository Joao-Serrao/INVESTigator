"""Urgency scoring + event construction.

DESIGN: urgency is **additive and clamped**, never multiplicative. Each factor is
a 0..1 signal; we take a weighted sum and clamp to [0, 10]. This means a single
weak factor (e.g. low plan-relevance) lowers a score but never silently nukes an
otherwise important event the way `a * b * c` does. The result is a *sort key*
for "how much should this rise to my attention", not a verdict.

Severity/relevance are heuristic-first (rules + keywords). The LLM is not in this
loop — it only narrates the events this module produces.
"""

from __future__ import annotations

from ..config import Plan
from ..models import Event, Holding, NewsItem, PriceSnapshot, Subject

# Weights sum to 10 → urgency naturally lands on a 0..10 scale.
W_EXPOSURE = 4.0
W_SEVERITY = 3.0
W_PLAN = 2.0
W_TIME = 1.0

# Keywords that bump news severity. Crude but transparent and tunable.
_HIGH_SEVERITY_KW = (
    "lawsuit", "fraud", "investigation", "bankruptcy", "default", "guidance cut",
    "profit warning", "downgrade", "recall", "data breach", "resigns", "ceo steps down",
    "plunge", "crash", "halt", "delist",
)
_MED_SEVERITY_KW = (
    "earnings", "results", "guidance", "acquisition", "merger", "dividend", "buyback",
    "upgrade", "partnership", "launch", "forecast", "outlook", "revenue", "layoff",
)


def _clamp(x: float, lo: float = 0.0, hi: float = 10.0) -> float:
    return max(lo, min(hi, x))


def _severity_label(score10: float) -> str:
    if score10 >= 6.5:
        return "high"
    if score10 >= 3.5:
        return "medium"
    return "low"


def _news_severity_factor(title: str) -> float:
    title_l = title.lower()
    if any(kw in title_l for kw in _HIGH_SEVERITY_KW):
        return 0.9
    if any(kw in title_l for kw in _MED_SEVERITY_KW):
        return 0.55
    return 0.2


# Watchlist items are things you're actively considering, so they get a baseline of
# attention even without portfolio exposure — the user explicitly wants these surfaced.
WATCHLIST_INTEREST_BASE = 3.0


def watchlist_event(subj: Subject, item: NewsItem, plan: Plan) -> Event | None:
    severity_f = max(_news_severity_factor(item.title), 0.3)  # never fully mute a watched name
    score = _clamp(WATCHLIST_INTEREST_BASE + 4.0 * severity_f + 1.0)  # interest + severity + recency
    kind_word = "theme" if subj.is_theme else "potential entry"
    explanation = (
        f"On your watchlist ({kind_word}), not yet owned. Surfaced because you asked to "
        f"track {subj.name} — this is discovery context for capital you might deploy."
    )
    return Event(
        ticker=subj.ticker or subj.name,
        kind="watchlist",
        severity=_severity_label(score),
        urgency=round(score, 2),
        headline=item.title,
        explanation=explanation,
        url=item.url,
    )


def _plan_relevance(h: Holding, plan: Plan) -> float:
    """0..1 — does this position sit in a bucket the plan actively cares about?"""
    targets = plan.allocation_targets or {}
    # Map holding type -> a plan bucket key when possible.
    bucket = h.type if h.type in targets else None
    weight_in_plan = targets.get(bucket, 0.0) if bucket else 0.0
    on_watchlist = h.ticker.upper() in {str(w).upper() for w in (plan.watchlist or [])}
    rel = 0.4 + 0.6 * min(1.0, weight_in_plan / 0.5)  # base relevance + bucket emphasis
    if on_watchlist:
        rel = max(rel, 0.9)
    return min(1.0, rel)


def price_event(h: Holding, snap: PriceSnapshot, plan: Plan) -> Event | None:
    if snap.change_pct_1d is None:
        return None
    move = abs(snap.change_pct_1d)
    if move < plan.thresholds.price_move_pct:
        return None  # severity thresholding: ignore small moves

    exposure_f = min(1.0, h.portfolio_weight / 0.15)  # 15%+ position = full exposure signal
    severity_f = min(1.0, move / 10.0)  # a 10%+ move maxes the severity factor
    plan_f = _plan_relevance(h, plan)
    time_f = 0.5 if snap.stale else 1.0

    score = _clamp(
        W_EXPOSURE * exposure_f + W_SEVERITY * severity_f + W_PLAN * plan_f + W_TIME * time_f
    )
    direction = "up" if snap.change_pct_1d > 0 else "down"
    stale_note = " (cached/stale price)" if snap.stale else ""
    explanation = (
        f"{h.name or h.ticker} is {h.portfolio_weight*100:.1f}% of your portfolio; "
        f"a {move:.1f}% {direction} move{stale_note} therefore moves real capital you hold."
    )
    return Event(
        ticker=h.ticker,
        kind="price_move",
        severity=_severity_label(score),
        urgency=round(score, 2),
        headline=f"{h.ticker} {direction} {move:.1f}% on the day",
        explanation=explanation,
    )


def news_event(h: Holding, item: NewsItem, plan: Plan) -> Event | None:
    on_watchlist = h.ticker.upper() in {str(w).upper() for w in (plan.watchlist or [])}
    severity_f = _news_severity_factor(item.title)

    # Severity gate: generic chatter about a stock you happen to own is NOT news.
    # Only surface materially-flagged items (earnings/lawsuit/M&A/...) — or anything
    # touching a watchlist target. This is the core noise filter.
    if severity_f < 0.5 and not on_watchlist:
        return None

    # For news, severity should lead and exposure should modulate — otherwise a big
    # holding floods the digest. Cap exposure's news contribution at 0.6.
    exposure_f = min(0.6, h.portfolio_weight / 0.25)
    plan_f = _plan_relevance(h, plan)
    time_f = 1.0  # news fetched within the lookback window is by definition recent

    score = _clamp(
        W_EXPOSURE * exposure_f + W_SEVERITY * severity_f + W_PLAN * plan_f + W_TIME * time_f
    )
    explanation = (
        f"Concerns {h.name or h.ticker} ({h.portfolio_weight*100:.1f}% of your portfolio, "
        f"tagged '{h.strategy_tag or h.type}'). Surfaced because it intersects a position you hold."
    )
    return Event(
        ticker=h.ticker,
        kind="news",
        severity=_severity_label(score),
        urgency=round(score, 2),
        headline=item.title,
        explanation=explanation,
        url=item.url,
    )
