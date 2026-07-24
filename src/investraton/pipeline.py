"""The orchestrator: ingest -> store -> score -> dedup -> narrate -> deliver.

This is the whole v0 loop in one readable function. Each stage degrades
gracefully and contributes to an honest data-freshness label.
"""

from __future__ import annotations

import json
import logging

from .brain.llm import get_llm
from .brain.narrative import build_narrative
from .config import Plan, load_app_settings, load_plan, load_settings
from .deliver import deliver
from .engine.concentration import analyse_concentration
from .engine.lookthrough import LookThrough, compute_lookthrough
from .engine.plan_align import analyse_plan
from .engine.scoping import build_subjects, get_complexity
from .engine.urgency import news_event, price_event, watchlist_event
from .engine.valuation import apply_current_values
from .engine.weights import compute_weights
from .ingest.etf_holdings import get_composition
from .ingest.holdings import load_all_holdings
from .ingest.news import fetch_news_for_subjects
from .ingest.prices import fetch_prices
from .models import Digest, Finding, Holding, utcnow
from .store import Store

log = logging.getLogger(__name__)


def _cap_items(events, per_ticker: int, total: int):
    """Keep at most `per_ticker` items per ticker (highest urgency first), then
    truncate to `total`. Assumes `events` is already sorted by urgency desc."""
    seen: dict[str, int] = {}
    kept = []
    for ev in events:
        key = ev.ticker.upper()
        if seen.get(key, 0) >= per_ticker:
            continue
        seen[key] = seen.get(key, 0) + 1
        kept.append(ev)
        if len(kept) >= total:
            break
    return kept


def analyse_structure(holdings: list[Holding], plan: Plan) -> tuple[list[Finding], LookThrough]:
    """Compute the portfolio's structural picture: ETF look-through, concentration,
    overlap, and plan drift. Shared by the digest and the `structure` command."""
    lt = compute_lookthrough(holdings, get_composition)
    findings = analyse_concentration(lt) + analyse_plan(holdings, plan)
    return findings, lt


def run_digest(
    period: str = "weekly",
    deliver_output: bool = True,
    focus: str = "all",
    complexity: str = "standard",
    delivery_override: list | None = None,
    skip_if_empty: bool = False,
) -> Digest:
    settings = load_settings()
    plan = load_plan()
    cx = get_complexity(complexity, plan.thresholds.min_urgency_to_report)
    news_sources = load_app_settings().get("news_sources", [])

    with Store(settings.db_path) as store:
        # 1. Ingest holdings; price + value them, then weight by current value.
        holdings, source_notes = load_all_holdings(settings, plan)
        if not holdings:
            log.warning("No holdings found. Add positions to data/holdings.csv.")
        held_prices = fetch_prices([h.ticker for h in holdings if h.ticker], store)
        apply_current_values(holdings, held_prices, store)
        total_eur, amounts_given = compute_weights(holdings)
        subjects = build_subjects(holdings, plan.watchlist, focus)
        owned_subjects = [s for s in subjects if s.owned]
        watch_subjects = [s for s in subjects if not s.owned]
        holding_by_key = {h.key: h for h in holdings}

        # 2. Prices for any watchlist-only tickers (held are already fetched) + news.
        owned_keys = {h.key for h in holdings}
        watch_tickers = [s.ticker for s in watch_subjects if s.ticker and s.key not in owned_keys]
        prices = {**held_prices, **(fetch_prices(watch_tickers, store) if watch_tickers else {})}
        news_by_subject = fetch_news_for_subjects(
            subjects, plan.thresholds.news_lookback_days, store, news_sources
        )
        n_news = sum(len(v) for v in news_by_subject.values())

        # 3. Score into events (deterministic). Holdings -> price + news events;
        #    watchlist subjects -> discovery events.
        events, watch_events = [], []
        for s in owned_subjects:
            h = holding_by_key.get(s.key)
            if h is None:
                continue
            snap = prices.get(s.key)
            if snap is not None:
                ev = price_event(h, snap, plan)
                if ev is not None:
                    events.append(ev)
            for item in news_by_subject.get(s.key, []):
                ev = news_event(h, item, plan)
                if ev is not None:
                    events.append(ev)
        for s in watch_subjects:
            for item in news_by_subject.get(s.key, []):
                ev = watchlist_event(s, item, plan)
                if ev is not None:
                    watch_events.append(ev)

        # 4. Threshold (per complexity) + dedup, then anti-flood caps.
        # Dedup is scoped to this digest's TIER (period) so e.g. a weekly digest can
        # still surface articles that the daily one already showed.
        scope = period
        kept = _filter(events, cx.min_urgency, cx.max_per_subject, cx.max_total, store, scope)
        # Watchlist uses its OWN (more permissive) thresholds — when you're tracking a
        # name you usually want to see ~everything about it, not just high-urgency items.
        th = plan.thresholds
        watch_kept = (
            _filter(watch_events, th.watchlist_min_urgency, th.watchlist_max_per_item, 60, store, scope)
            if cx.include_watchlist else []
        )

        # 5. Structural analysis (only when the preset asks for it and we hold things).
        if cx.include_structure and holdings:
            structure, lt = analyse_structure(holdings, plan)
        else:
            structure, lt = [], None

        # 6. Build the digest + narrative.
        stale_prices = sum(1 for s in prices.values() if s.stale)
        freshness = _freshness_label(source_notes, len(prices), stale_prices, n_news, focus, cx.label)
        if not amounts_given and holdings:
            freshness += " · amounts not set (equal-weighted)"
        if lt is not None:
            freshness += f" · look-through covers {lt.coverage*100:.0f}% of portfolio"
        digest = Digest(
            generated_at=utcnow(),
            period=period,
            events=kept,
            portfolio_total_eur=total_eur,
            data_freshness=freshness,
            amounts_provided=amounts_given,
            structure=structure,
            watchlist=watch_kept,
        )
        digest.narrative = build_narrative(digest, get_llm(settings))

        # 7. Save to history (every run, so the History view captures previews too).
        store.save_digest(
            {"period": period, "focus": focus, "complexity": cx.label,
             "events_count": len(kept), "watch_count": len(watch_kept)},
            json.dumps(serialize_digest(digest)),
        )

        # 8. Deliver (unless asked to stay silent on an empty digest), then record
        # what we reported. History is already saved above either way.
        nothing_found = not kept and not watch_kept
        if deliver_output and skip_if_empty and nothing_found:
            deliver_output = False
        if deliver_output:
            if delivery_override:
                settings.delivery = delivery_override
            digest.delivery_report = deliver(digest, settings)
            for ev in kept + watch_kept:
                store.mark_reported(ev.dedup_key, ev.ticker, ev.kind, scope)

        return digest


def serialize_digest(digest) -> dict:
    """JSON-able dict of a digest — shared by the API and the history store."""
    def ev(e):
        return {"ticker": e.ticker, "kind": e.kind, "severity": e.severity, "urgency": e.urgency,
                "headline": e.headline, "explanation": e.explanation, "url": e.url}
    return {
        "generated_at": digest.generated_at.isoformat(),
        "portfolio_total_eur": digest.portfolio_total_eur,
        "amounts_provided": digest.amounts_provided,
        "data_freshness": digest.data_freshness,
        "narrative": digest.narrative,
        "events": [ev(e) for e in digest.events],
        "watchlist": [ev(e) for e in digest.watchlist],
        "structure": [{"kind": f.kind, "title": f.title, "detail": f.detail, "severity": f.severity}
                      for f in digest.structure],
        "delivery_report": digest.delivery_report,
    }


def _filter(events, min_urgency, per_subject, total, store, scope):
    """Apply a min-urgency threshold + per-tier dedup, sort, then per-subject/total caps."""
    candidates = [
        ev for ev in events
        if ev.urgency >= min_urgency and not store.already_reported(ev.dedup_key, scope)
    ]
    candidates.sort(key=lambda e: e.urgency, reverse=True)
    return _cap_items(candidates, per_ticker=per_subject, total=total)


def _freshness_label(source_notes, n_prices, n_stale, n_news, focus, complexity_label) -> str:
    parts = [
        f"focus: {focus} · {complexity_label}",
        "holdings[" + "; ".join(source_notes) + "]",
        f"prices: {n_prices} ({n_stale} cached/stale)",
        f"new news items: {n_news}",
    ]
    return " · ".join(parts)
