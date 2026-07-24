"""Dump what the PYTHON engine reads from disk + SQLite, for storage parity.

Reads the real app data READ-ONLY. Secret values are redacted to a marker — we
verify keys and non-secret values match, and that secrets are present/absent
consistently, without copying credentials into another file.

Run:  python engine/test/make_storage_fixtures.py
"""

from __future__ import annotations

import json
import os
import sqlite3
import sys
from dataclasses import asdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

from investraton.config import (  # noqa: E402
    CONFIG_DIR, DATA_DIR, load_app_settings, load_plan, load_settings,
)
from investraton.ingest.holdings import load_all_holdings  # noqa: E402
from investraton.scheduler import load_schedules  # noqa: E402

OUT = Path(__file__).parent / "fixtures"
OUT.mkdir(exist_ok=True)

SECRET_KEYS = {"anthropic_api_key", "password", "discord_webhook_url"}
REDACTED = "<redacted:present>"


def redact(obj):
    if isinstance(obj, dict):
        return {k: (REDACTED if (k in SECRET_KEYS and obj[k]) else redact(v))
                for k, v in obj.items()}
    if isinstance(obj, list):
        return [redact(x) for x in obj]
    return obj


def main() -> None:
    settings = load_settings()
    plan = load_plan()
    holdings, _ = load_all_holdings(settings, plan)

    db_path = DATA_DIR / "investraton.db"
    db = {}
    if db_path.exists():
        con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        con.row_factory = sqlite3.Row
        counts = {}
        for (t,) in con.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
        ):
            counts[t] = con.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
        value_tracking = [dict(r) for r in con.execute(
            "SELECT ticker, basis_price, basis_amount FROM value_tracking ORDER BY ticker")]
        digests = [dict(r) for r in con.execute(
            "SELECT id, created_at, period, focus, complexity, events_count, watch_count"
            " FROM digests ORDER BY id DESC LIMIT 50")]
        # A deterministic sample to prove row-level reads agree.
        reported = [dict(r) for r in con.execute(
            "SELECT dedup_key, scope FROM reported_events ORDER BY dedup_key LIMIT 25")]
        news_keys = [r[0] for r in con.execute(
            "SELECT dedup_key FROM news ORDER BY dedup_key LIMIT 25")]
        prices = [dict(r) for r in con.execute(
            "SELECT ticker, price, currency, change_pct_1d, as_of FROM prices"
            " ORDER BY ticker, as_of LIMIT 25")]
        latest = {}
        for h in holdings:
            row = con.execute(
                "SELECT ticker, price, currency, change_pct_1d, as_of FROM prices"
                " WHERE ticker=? ORDER BY as_of DESC LIMIT 1", (h.key,)).fetchone()
            latest[h.key] = dict(row) if row else None
        con.close()
        db = {"counts": counts, "value_tracking": value_tracking, "digests": digests,
              "reported_sample": reported, "news_keys": news_keys,
              "prices_sample": prices, "latest_price": latest}

    payload = {
        "holdings": [
            {"ticker": h.ticker, "name": h.name, "type": h.type,
             "amount_invested_eur": h.amount_invested_eur, "avg_cost": h.avg_cost,
             "strategy_tag": h.strategy_tag, "isin": h.isin, "source": h.source}
            for h in holdings
        ],
        "plan": {
            "profile": plan.profile,
            "monthly_contribution_eur": plan.monthly_contribution_eur,
            "allocation_targets": plan.allocation_targets,
            "watchlist": plan.watchlist,
            "thresholds": asdict(plan.thresholds),
        },
        "app_settings": redact(load_app_settings()),
        "schedules": load_schedules(),
        "db": db,
        "paths": {"home": str(Path(DATA_DIR).parent), "config": str(CONFIG_DIR)},
    }

    (OUT / "storage_expected.json").write_text(json.dumps(payload, indent=1), encoding="utf-8")
    print(f"holdings={len(payload['holdings'])} schedules={len(payload['schedules'])} "
          f"db_tables={list(db.get('counts', {}).keys())}")
    print(f"counts={db.get('counts')}")
    print(f"wrote {OUT/'storage_expected.json'}")


if __name__ == "__main__":
    main()
