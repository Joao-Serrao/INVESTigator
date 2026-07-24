"""Generate parity fixtures + expected outputs from the Python engine.

Uses the REAL holdings/plan/ETF compositions (read-only) so the look-through maths
is exercised against thousands of genuine constituents, and synthesises the
price/news inputs so the fixture is deterministic and reproducible.

Run:  python engine/test/make_fixtures.py
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from dataclasses import asdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

from investraton.config import load_plan, load_settings  # noqa: E402
from investraton.engine.concentration import analyse_concentration  # noqa: E402
from investraton.engine.lookthrough import compute_lookthrough  # noqa: E402
from investraton.engine.plan_align import analyse_plan  # noqa: E402
from investraton.engine.scoping import build_subjects, get_complexity  # noqa: E402
from investraton.engine.urgency import news_event, price_event, watchlist_event  # noqa: E402
from investraton.engine.valuation import apply_current_values  # noqa: E402
from investraton.engine.weights import compute_weights  # noqa: E402
from investraton.ingest.etf_holdings import get_composition  # noqa: E402
from investraton.ingest.holdings import load_all_holdings  # noqa: E402
from investraton.models import NewsItem, PriceSnapshot  # noqa: E402
from investraton.store import Store  # noqa: E402

OUT = Path(__file__).parent / "fixtures"
OUT.mkdir(exist_ok=True)

# Deterministic price inputs: above/below threshold, up/down, stale, and no-change.
SYNTH_PRICES = [
    ("__P1", 100.0, 6.4, False),
    ("__P2", 250.0, -8.75, False),
    ("__P3", 40.0, 1.2, False),      # below the 3% threshold -> no event
    ("__P4", 33.3, 12.5, True),      # stale
    ("__P5", 77.7, -3.0, False),     # exactly at threshold
]

# Deterministic news titles covering each severity tier.
SYNTH_NEWS = [
    "Company faces lawsuit over data breach",          # high
    "Q3 earnings beat expectations, dividend raised",  # medium
    "A quiet day for the sector",                      # low (gated for owned)
    "Analyst downgrade sparks selloff",                # high
    "New product launch announced",                    # medium
]


def price_json(p: PriceSnapshot) -> dict:
    return {"ticker": p.ticker, "price": p.price, "currency": p.currency,
            "change_pct_1d": p.change_pct_1d, "stale": p.stale}


def news_json(n: NewsItem) -> dict:
    return {"ticker": n.ticker, "title": n.title, "url": n.url,
            "source": n.source, "summary": n.summary}


def holding_json(h) -> dict:
    return {"ticker": h.ticker, "name": h.name, "type": h.type,
            "amount_invested_eur": h.amount_invested_eur, "avg_cost": h.avg_cost,
            "strategy_tag": h.strategy_tag, "isin": h.isin, "source": h.source,
            "portfolio_weight": h.portfolio_weight, "current_value": h.current_value}


def exposure_json(e) -> dict:
    return {"key": e.key, "label": e.label, "weight": e.weight,
            "direct": e.direct, "via_etf": e.via_etf, "detail": e.detail}


def finding_json(f) -> dict:
    return {"kind": f.kind, "title": f.title, "detail": f.detail, "severity": f.severity}


def event_json(e) -> dict:
    if e is None:
        return None
    return {"ticker": e.ticker, "kind": e.kind, "severity": e.severity,
            "urgency": e.urgency, "headline": e.headline,
            "explanation": e.explanation, "url": e.url}


def main() -> None:
    settings = load_settings()
    plan = load_plan()
    holdings, _ = load_all_holdings(settings, plan)
    if not holdings:
        raise SystemExit("No holdings found — add positions before generating fixtures.")

    # --- compositions for each ETF holding (real data) ---
    compositions: dict[str, dict] = {}
    for h in holdings:
        if h.type.lower() != "etf":
            continue
        c = get_composition(h.ticker, h.isin)
        if c is None:
            continue
        compositions[h.key] = {
            "ticker": c.ticker, "name": c.name, "as_of": c.as_of, "source": c.source,
            "stale": c.stale,
            "constituents": [
                {"ticker": x.ticker, "name": x.name, "weight": x.weight,
                 "sector": x.sector, "country": x.country, "asset_class": x.asset_class}
                for x in c.constituents
            ],
        }

    # --- valuation: seed a temp store with a known basis so the result is deterministic ---
    tmp_db = Path(tempfile.gettempdir()) / "parity_basis.db"
    tmp_db.unlink(missing_ok=True)
    prices: dict[str, PriceSnapshot] = {}
    basis_in: dict[str, dict] = {}
    with Store(tmp_db) as store:
        for i, h in enumerate(holdings):
            price = 100.0 + i * 10.0
            prices[h.key] = PriceSnapshot(ticker=h.key, price=price, currency="EUR",
                                          change_pct_1d=None, stale=False)
            if i % 2 == 0:  # half get a pre-existing basis 10% lower -> +11.1% drift
                bp = price * 0.9
                store.set_value_basis(h.key, bp, h.amount_invested_eur)
                basis_in[h.key] = {"basis_price": bp, "basis_amount": h.amount_invested_eur}
        apply_current_values(holdings, prices, store)
    tmp_db.unlink(missing_ok=True)

    total_eur, amounts_given = compute_weights(holdings)
    lt = compute_lookthrough(holdings, get_composition)
    findings = analyse_concentration(lt) + analyse_plan(holdings, plan)

    # --- scoping ---
    focuses = ["all", "invested", "watchlist", f"group:{holdings[0].type}"]
    subjects = {
        f: [{"name": s.name, "ticker": s.ticker, "owned": s.owned, "weight": s.weight,
             "strategy_tag": s.strategy_tag, "type": s.type} for s in
            build_subjects(holdings, plan.watchlist, f)]
        for f in focuses
    }
    complexities = {
        name: asdict(get_complexity(name, plan.thresholds.min_urgency_to_report))
        for name in ["simple", "standard", "complex", "urgent", "none", "bogus"]
    }

    # --- events (deterministic synthetic inputs against the first holdings) ---
    price_events, price_inputs = [], []
    for i, (_tag, price, chg, stale) in enumerate(SYNTH_PRICES):
        h = holdings[i % len(holdings)]
        snap = PriceSnapshot(ticker=h.key, price=price, currency="EUR",
                             change_pct_1d=chg, stale=stale)
        price_inputs.append({"holding": h.key, "snap": price_json(snap)})
        price_events.append(event_json(price_event(h, snap, plan)))

    news_events, news_inputs = [], []
    for i, title in enumerate(SYNTH_NEWS):
        h = holdings[i % len(holdings)]
        item = NewsItem(ticker=h.key, title=title, url=f"https://example.com/{i}",
                        source="Test", summary="")
        news_inputs.append({"holding": h.key, "item": news_json(item)})
        news_events.append(event_json(news_event(h, item, plan)))

    watch_subjects = build_subjects(holdings, plan.watchlist, "watchlist")
    watch_events, watch_inputs = [], []
    for i, title in enumerate(SYNTH_NEWS):
        if not watch_subjects:
            break
        s = watch_subjects[i % len(watch_subjects)]
        item = NewsItem(ticker=s.key, title=title, url=f"https://example.com/w{i}",
                        source="Test", summary="")
        watch_inputs.append({"subject": {"name": s.name, "ticker": s.ticker, "owned": s.owned,
                                         "weight": s.weight, "strategy_tag": s.strategy_tag,
                                         "type": s.type},
                             "item": news_json(item)})
        watch_events.append(event_json(watchlist_event(s, item, plan)))

    fixtures = {
        "holdings": [holding_json(h) for h in holdings],
        "plan": {
            "profile": plan.profile,
            "monthly_contribution_eur": plan.monthly_contribution_eur,
            "allocation_targets": plan.allocation_targets,
            "watchlist": plan.watchlist,
            "thresholds": asdict(plan.thresholds),
        },
        "compositions": compositions,
        "valuation": {"prices": {k: price_json(v) for k, v in prices.items()},
                      "basis": basis_in},
        "price_inputs": price_inputs,
        "news_inputs": news_inputs,
        "watchlist_inputs": watch_inputs,
        "focuses": focuses,
    }

    expected = {
        "weights": {"total_eur": total_eur, "amounts_given": amounts_given,
                    "holdings": [holding_json(h) for h in holdings]},
        "lookthrough": {
            "by_name": [exposure_json(e) for e in lt.by_name],
            "by_sector": [exposure_json(e) for e in lt.by_sector],
            "by_country": [exposure_json(e) for e in lt.by_country],
            "by_region": [exposure_json(e) for e in lt.by_region],
            "coverage": lt.coverage,
            "opaque": [list(o) for o in lt.opaque],
            "as_of": lt.as_of,
        },
        "findings": [finding_json(f) for f in findings],
        "subjects": subjects,
        "complexities": complexities,
        "price_events": price_events,
        "news_events": news_events,
        "watchlist_events": watch_events,
    }

    (OUT / "fixtures.json").write_text(json.dumps(fixtures, indent=1), encoding="utf-8")
    (OUT / "expected.json").write_text(json.dumps(expected, indent=1), encoding="utf-8")
    print(f"holdings={len(holdings)} compositions={len(compositions)} "
          f"constituents={sum(len(c['constituents']) for c in compositions.values())}")
    print(f"by_name={len(lt.by_name)} findings={len(findings)} "
          f"coverage={lt.coverage:.4f}")
    print(f"wrote {OUT/'fixtures.json'} and {OUT/'expected.json'}")


if __name__ == "__main__":
    main()
