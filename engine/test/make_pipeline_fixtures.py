"""End-to-end pipeline fixtures: run the Python run_digest on fixed inputs with
stubbed ingestion, and capture serialize_digest for every scenario.

The TS harness reads the SAME input fixtures, injects the SAME stubbed data, and
asserts serialize_digest matches byte-for-byte (numbers compared with epsilon).
This exercises the whole loop at once: scoping -> scoring -> threshold/dedup ->
caps -> look-through/concentration/plan -> narrative -> serialize.

Ingestion is stubbed (no network) so the run is deterministic; the store starts
empty for each scenario so dedup/value-basis state never leaks between them.

Run:  python engine/test/make_pipeline_fixtures.py
"""

from __future__ import annotations

import json
import os
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
OUT = Path(__file__).resolve().parent / "fixtures" / "pipeline"
INPUT = OUT / "input"
EXPECTED = OUT / "expected"
PYHOME = OUT / "pyhome"  # Python's temp HOME (gitignored)

# config.py reads INVESTRATON_HOME at import time, so set it BEFORE importing.
PYHOME.mkdir(parents=True, exist_ok=True)
os.environ["INVESTRATON_HOME"] = str(PYHOME)
sys.path.insert(0, str(REPO / "src"))

import investraton.pipeline as pipe  # noqa: E402
from investraton.config import provision_home  # noqa: E402
from investraton.models import (  # noqa: E402
    Constituent, ETFComposition, NewsItem, PriceSnapshot,
)

# ------------------------------------------------------------------ fixed inputs
GENERATED_AT = datetime(2026, 7, 20, 8, 30, 0, 123000, tzinfo=timezone.utc)

HOLDINGS_CSV = (
    "ticker,name,type,amount_invested_eur,avg_cost,strategy_tag,isin\r\n"
    "SXR8,iShares Core S&P 500,etf,5000,,core,IE00B5BMR087\r\n"
    "AAPL,Apple Inc.,growth_stock,3000,,growth,\r\n"
    "NVDA,NVIDIA Corp,growth_stock,1000,,growth,\r\n"
)

PLAN_YAML = """profile:
  risk: balanced
plan:
  monthly_contribution_eur: 500
  allocation_targets:
    etf: 0.5
    growth_stock: 0.3
  watchlist:
    - TSLA
    - artificial_intelligence
thresholds:
  price_move_pct: 3.0
  min_urgency_to_report: 2.0
  news_lookback_days: 7
  watchlist_min_urgency: 0.0
  watchlist_max_per_item: 8
"""

PRICES = {
    "SXR8": {"price": 704.6, "currency": "EUR", "change_pct_1d": 4.0, "stale": False},
    "AAPL": {"price": 210.0, "currency": "USD", "change_pct_1d": 1.0, "stale": False},
    "NVDA": {"price": 120.0, "currency": "USD", "change_pct_1d": -5.0, "stale": True},
    "TSLA": {"price": 250.0, "currency": "USD", "change_pct_1d": 2.0, "stale": False},
}

NEWS = {
    "AAPL": [
        {"title": "Apple faces lawsuit over App Store fees", "url": "https://ex.com/a1",
         "source": "Reuters", "summary": "A new legal challenge."},
        {"title": "Apple earnings beat expectations", "url": "https://ex.com/a2",
         "source": "Bloomberg", "summary": "Quarterly results."},
        {"title": "Apple issues guidance cut for next quarter", "url": "https://ex.com/a3",
         "source": "FT", "summary": "Lowered outlook."},
        {"title": "Apple announces acquisition of an AI startup", "url": "https://ex.com/a4",
         "source": "CNBC", "summary": "Deal news."},
        {"title": "Apple releases a new wallpaper pack", "url": "https://ex.com/a5",
         "source": "Blog", "summary": "Nothing material."},
    ],
    "NVDA": [
        {"title": "NVIDIA announces buyback programme", "url": "https://ex.com/n1",
         "source": "Reuters", "summary": "Capital return."},
    ],
    "TSLA": [
        {"title": "Tesla recall announced for some models", "url": "https://ex.com/t1",
         "source": "Reuters", "summary": "Safety recall."},
    ],
    "ARTIFICIAL INTELLIGENCE": [
        {"title": "AI breakthrough reshapes the sector", "url": "https://ex.com/ai1",
         "source": "Wired", "summary": "New model."},
    ],
}

COMPOSITION = {
    "SXR8": {
        "name": "iShares Core S&P 500", "as_of": "2026-07-19",
        "constituents": [
            {"ticker": "AAPL", "name": "APPLE INC", "weight": 0.07,
             "sector": "Information Technology", "country": "United States", "asset_class": "Equity"},
            {"ticker": "NVDA", "name": "NVIDIA CORP", "weight": 0.06,
             "sector": "Information Technology", "country": "United States", "asset_class": "Equity"},
            {"ticker": "MSFT", "name": "MICROSOFT CORP", "weight": 0.05,
             "sector": "Information Technology", "country": "United States", "asset_class": "Equity"},
            {"ticker": "TSM", "name": "TAIWAN SEMICONDUCTOR", "weight": 0.04,
             "sector": "Information Technology", "country": "Taiwan", "asset_class": "Equity"},
            {"ticker": "AMZN", "name": "AMAZON COM INC", "weight": 0.03,
             "sector": "Consumer Discretionary", "country": "United States", "asset_class": "Equity"},
        ],
    },
}

SCENARIOS = [
    {"name": "standard_full", "focus": "all", "complexity": "standard", "period": "weekly"},
    {"name": "simple", "focus": "all", "complexity": "simple", "period": "daily"},
    {"name": "none_filter", "focus": "all", "complexity": "none", "period": "monthly"},
    {"name": "invested_only", "focus": "invested", "complexity": "standard", "period": "weekly"},
    {"name": "group_empty", "focus": "group:doesnotexist", "complexity": "standard", "period": "weekly"},
]


# ------------------------------------------------------------------ stubs
def stub_fetch_prices(tickers, store):  # noqa: ARG001
    out = {}
    for t in tickers:
        d = PRICES.get(t.upper())
        if d:
            out[t.upper()] = PriceSnapshot(
                ticker=t.upper(), price=d["price"], currency=d.get("currency", ""),
                change_pct_1d=d.get("change_pct_1d"), as_of=GENERATED_AT, stale=d.get("stale", False),
            )
    return out


def stub_fetch_news(subjects, lookback_days, store, news_sources=None):  # noqa: ARG001
    out = {}
    for s in subjects:
        items = NEWS.get(s.key, [])
        out[s.key] = [
            NewsItem(ticker=s.key, title=i["title"], url=i.get("url", ""),
                     source=i.get("source", ""), summary=i.get("summary", ""))
            for i in items
        ]
    return out


def stub_get_composition(ticker, isin=""):  # noqa: ARG001
    base = ticker.upper().split(".")[0]
    d = COMPOSITION.get(base)
    if not d:
        return None
    return ETFComposition(
        ticker=base, name=d["name"], as_of=d["as_of"], source="ishares",
        constituents=[Constituent(**c) for c in d["constituents"]],
    )


def write_inputs() -> None:
    INPUT.mkdir(parents=True, exist_ok=True)
    (INPUT / "holdings.csv").write_text(HOLDINGS_CSV, encoding="utf-8", newline="")
    (INPUT / "portfolio_plan.yaml").write_text(PLAN_YAML, encoding="utf-8", newline="")
    (INPUT / "prices.json").write_text(json.dumps(PRICES, indent=1), encoding="utf-8")
    (INPUT / "news.json").write_text(json.dumps(NEWS, indent=1), encoding="utf-8")
    (INPUT / "composition.json").write_text(json.dumps(COMPOSITION, indent=1), encoding="utf-8")
    (INPUT / "scenarios.json").write_text(
        json.dumps({"generated_at_ms": int(GENERATED_AT.timestamp() * 1000), "scenarios": SCENARIOS},
                   indent=1),
        encoding="utf-8",
    )


def reset_home() -> None:
    """Fresh HOME per scenario: holdings + plan in place, no db/state carried over."""
    if PYHOME.exists():
        shutil.rmtree(PYHOME)
    (PYHOME / "data").mkdir(parents=True, exist_ok=True)
    (PYHOME / "config").mkdir(parents=True, exist_ok=True)
    (PYHOME / "data" / "holdings.csv").write_text(HOLDINGS_CSV, encoding="utf-8", newline="")
    (PYHOME / "config" / "portfolio_plan.yaml").write_text(PLAN_YAML, encoding="utf-8", newline="")
    provision_home()


def main() -> None:
    write_inputs()
    EXPECTED.mkdir(parents=True, exist_ok=True)

    pipe.fetch_prices = stub_fetch_prices
    pipe.fetch_news_for_subjects = stub_fetch_news
    pipe.get_composition = stub_get_composition
    pipe.utcnow = lambda: GENERATED_AT

    for sc in SCENARIOS:
        reset_home()
        digest = pipe.run_digest(
            period=sc["period"], deliver_output=False,
            focus=sc["focus"], complexity=sc["complexity"],
        )
        payload = pipe.serialize_digest(digest)
        (EXPECTED / f"{sc['name']}.json").write_text(
            json.dumps(payload, indent=1, ensure_ascii=False), encoding="utf-8",
        )
        print(f"  {sc['name']:16} events={len(payload['events'])} "
              f"watch={len(payload['watchlist'])} structure={len(payload['structure'])}")

    # Clean the throwaway home so only fixtures/ inputs+expected remain.
    if PYHOME.exists():
        shutil.rmtree(PYHOME)
    print(f"\nwrote {EXPECTED}")


if __name__ == "__main__":
    main()
