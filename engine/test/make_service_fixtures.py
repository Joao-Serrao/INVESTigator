"""Service-layer fixtures: seed a realistic HOME (holdings, plan, settings with
secrets, schedules, a populated DB, a fresh ETF cache), then capture every Python
api.py endpoint's output.

The TS harness (service-parity.ts) points app/service.ts at the SAME on-disk HOME
and asserts identical responses — the contract-level proof that service.ts can
stand in for api.py before Python retires. Everything is local/deterministic:
prices come from the seeded DB (not the network) and the ETF composition from a
fresh cache file, so no fetching happens on either side.

Run:  python engine/test/make_service_fixtures.py
"""

from __future__ import annotations

import json
import os
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
OUT = Path(__file__).resolve().parent / "fixtures" / "service"
HOME = OUT / "home"          # the shared HOME both engines read (gitignored)
EXPECTED = OUT / "expected"

# config.py reads INVESTRATON_HOME at import time — set it BEFORE importing.
os.environ["INVESTRATON_HOME"] = str(HOME)
sys.path.insert(0, str(REPO / "src"))

NOW = datetime(2026, 7, 21, 9, 0, 0, tzinfo=timezone.utc)

HOLDINGS_CSV = (
    "ticker,name,type,amount_invested_eur,avg_cost,strategy_tag,isin\r\n"
    "TESTETF,Test World ETF,etf,5000,,core,\r\n"
    "AAPL,Apple Inc.,growth_stock,3000,180,growth,\r\n"
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

APP_SETTINGS = {
    "llm_provider": "claude",
    "anthropic_api_key": "sk-ant-secret-should-be-masked",
    "anthropic_model": "claude-haiku-4-5-20251001",
    "delivery": ["email", "console"],
    "discord_webhook_url": "https://discord.com/api/webhooks/123/abc",
    "smtp": {"host": "smtp.gmail.com", "port": 587, "user": "me@gmail.com",
             "password": "app-pass-secret", "from": "me@gmail.com", "to": "me@gmail.com"},
    "news_sources": [
        {"type": "domain", "value": "ft.com", "name": "Financial Times"},
        {"type": "rss", "value": "https://example.com/feed.xml", "name": "Example Feed"},
    ],
}

SCHEDULES = [
    {"id": "aaaa1111bbbb", "name": "Morning brief", "frequency": "daily", "time": "08:00",
     "complexity": "simple", "focus": "all", "delivery": ["email"], "skip_if_empty": True,
     "enabled": True},
    {"id": "cccc2222dddd", "name": "Weekly deep-dive", "frequency": "weekly", "time": "18:30",
     "complexity": "complex", "focus": "invested", "delivery": [], "skip_if_empty": False,
     "enabled": False},
]

COMPOSITION_CACHE = {
    "ticker": "TESTETF", "name": "Test World ETF", "as_of": "2026-07-20", "source": "ishares",
    "fetched_at": NOW.isoformat(),  # fresh -> read from cache, never fetched
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
}

# Seeded prices so cached_prices() yields current values (no network).
PRICES = [
    ("AAPL", 210.0, "USD", 1.5),
    ("NVDA", 120.0, "USD", -2.0),
    ("TESTETF", 90.0, "EUR", 0.5),
]
# A value basis so AAPL shows a price-adjusted current value (drifted from amount).
VALUE_BASIS = [("AAPL", 175.0, 3000.0)]


def seed_home() -> None:
    if HOME.exists():
        shutil.rmtree(HOME)
    (HOME / "data" / "etf_holdings").mkdir(parents=True, exist_ok=True)
    (HOME / "config").mkdir(parents=True, exist_ok=True)
    (HOME / "data" / "holdings.csv").write_text(HOLDINGS_CSV, encoding="utf-8", newline="")
    (HOME / "config" / "portfolio_plan.yaml").write_text(PLAN_YAML, encoding="utf-8", newline="")
    (HOME / "config" / "app_settings.json").write_text(json.dumps(APP_SETTINGS, indent=2), encoding="utf-8")
    (HOME / "config" / "schedules.json").write_text(json.dumps(SCHEDULES, indent=2), encoding="utf-8")
    (HOME / "data" / "etf_holdings" / "TESTETF.json").write_text(
        json.dumps(COMPOSITION_CACHE), encoding="utf-8")

    from investraton.config import provision_home
    from investraton.models import PriceSnapshot
    from investraton.store import Store

    provision_home()
    with Store(HOME / "data" / "investraton.db") as store:
        for t, price, cur, chg in PRICES:
            store.save_price(PriceSnapshot(ticker=t, price=price, currency=cur,
                                           change_pct_1d=chg, as_of=NOW))
        for t, bp, ba in VALUE_BASIS:
            store.set_value_basis(t, bp, ba)
        store.save_digest({"period": "weekly", "focus": "all", "complexity": "Standard",
                           "events_count": 3, "watch_count": 1}, json.dumps({"narrative": "older"}))
        store.save_digest({"period": "daily", "focus": "all", "complexity": "Simple",
                           "events_count": 1, "watch_count": 0}, json.dumps({"narrative": "newer"}))


def capture() -> None:
    EXPECTED.mkdir(parents=True, exist_ok=True)
    import investraton.api as api

    def dump(name: str, obj) -> None:
        (EXPECTED / f"{name}.json").write_text(
            json.dumps(obj, indent=1, ensure_ascii=False, default=str), encoding="utf-8")

    dump("status", api.status())
    dump("holdings", api.get_holdings())
    dump("plan", api.get_plan())
    dump("settings", api.get_settings())
    dump("sources", api.get_sources())
    dump("schedules", api.get_schedules())
    dump("structure", api.get_structure())
    hist = api.get_history()
    dump("history", hist)
    first_id = hist["history"][0]["id"]
    dump("history_item", api.get_history_item(first_id))

    # putSettings merge/mask: a partial save that must NOT wipe the stored password
    # (blank) or overwrite the key (masked). Capture the resulting app_settings.json.
    api.put_settings(api.SettingsIn(
        llm_provider="claude",
        anthropic_api_key="********",                    # masked -> keep stored key
        smtp={"host": "smtp.gmail.com", "port": 587, "user": "me@gmail.com",
              "password": "", "from": "me@gmail.com", "to": "me@gmail.com"},  # blank pw -> keep
    ))
    dump("after_put_settings", json.loads(
        (HOME / "config" / "app_settings.json").read_text(encoding="utf-8")))
    # Restore the pristine app_settings so the shared HOME the TS harness reads is
    # exactly what we captured the GET responses from (put_settings mutated it).
    (HOME / "config" / "app_settings.json").write_text(json.dumps(APP_SETTINGS, indent=2), encoding="utf-8")

    with open(EXPECTED / "meta.json", "w", encoding="utf-8") as fh:
        json.dump({"now_ms": int(NOW.timestamp() * 1000), "history_first_id": first_id}, fh)


def main() -> None:
    seed_home()
    capture()
    print("captured:", ", ".join(sorted(p.stem for p in EXPECTED.glob("*.json"))))
    print(f"HOME seeded at {HOME}")


if __name__ == "__main__":
    main()
