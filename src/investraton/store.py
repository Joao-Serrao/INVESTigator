"""SQLite persistence: holdings snapshots, prices, news, and the 'already-told-you'
dedup state that stops the digest repeating itself and keeps LLM cost down.

One file, no server. Easy to migrate to Postgres later if this becomes multi-user.
"""

from __future__ import annotations

import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from .models import NewsItem, PriceSnapshot

SCHEMA = """
CREATE TABLE IF NOT EXISTS prices (
    ticker TEXT NOT NULL,
    price REAL NOT NULL,
    currency TEXT,
    change_pct_1d REAL,
    as_of TEXT NOT NULL,
    PRIMARY KEY (ticker, as_of)
);

CREATE TABLE IF NOT EXISTS news (
    dedup_key TEXT PRIMARY KEY,
    ticker TEXT NOT NULL,
    title TEXT NOT NULL,
    url TEXT,
    source TEXT,
    published TEXT,
    summary TEXT,
    first_seen TEXT NOT NULL
);

-- What we've already surfaced, scoped by tier (daily/weekly/...) so a weekly digest
-- can still include items already shown in the dailies. Dedup is per-tier, not global.
CREATE TABLE IF NOT EXISTS reported_events (
    dedup_key TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT 'all',
    ticker TEXT,
    kind TEXT,
    reported_at TEXT NOT NULL,
    PRIMARY KEY (dedup_key, scope)
);

-- Per-holding value tracking: remembers the price + amount when you last set a
-- position, so current value can be estimated as amount * (price_now / price_then).
CREATE TABLE IF NOT EXISTS value_tracking (
    ticker TEXT PRIMARY KEY,
    basis_price REAL NOT NULL,
    basis_amount REAL NOT NULL,
    updated_at TEXT NOT NULL
);

-- Saved digests, for the History view.
CREATE TABLE IF NOT EXISTS digests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    period TEXT,
    focus TEXT,
    complexity TEXT,
    events_count INTEGER,
    watch_count INTEGER,
    payload TEXT NOT NULL
);
"""


def _iso(dt: datetime | None) -> str | None:
    return dt.astimezone(timezone.utc).isoformat() if dt else None


class Store:
    def __init__(self, db_path: Path):
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(str(db_path))
        self.conn.row_factory = sqlite3.Row
        self._migrate()
        self.conn.executescript(SCHEMA)
        self.conn.commit()

    def _migrate(self) -> None:
        # Old reported_events had no 'scope' column. Recreate it (dedup state is
        # regenerable, so dropping is safe — items just become eligible once more).
        cols = [r[1] for r in self.conn.execute("PRAGMA table_info(reported_events)")]
        if cols and "scope" not in cols:
            self.conn.execute("DROP TABLE reported_events")
            self.conn.commit()

    def close(self) -> None:
        self.conn.close()

    def __enter__(self) -> "Store":
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    # ---- prices ----
    def save_price(self, p: PriceSnapshot) -> None:
        self.conn.execute(
            "INSERT OR REPLACE INTO prices(ticker, price, currency, change_pct_1d, as_of)"
            " VALUES (?,?,?,?,?)",
            (p.ticker.upper(), p.price, p.currency, p.change_pct_1d, _iso(p.as_of)),
        )
        self.conn.commit()

    def latest_price(self, ticker: str) -> PriceSnapshot | None:
        row = self.conn.execute(
            "SELECT * FROM prices WHERE ticker=? ORDER BY as_of DESC LIMIT 1",
            (ticker.upper(),),
        ).fetchone()
        if not row:
            return None
        return PriceSnapshot(
            ticker=row["ticker"],
            price=row["price"],
            currency=row["currency"] or "",
            change_pct_1d=row["change_pct_1d"],
            as_of=datetime.fromisoformat(row["as_of"]),
            stale=True,  # came from cache
        )

    # ---- news ----
    def save_news(self, item: NewsItem) -> bool:
        """Returns True if this was a newly seen item."""
        cur = self.conn.execute(
            "INSERT OR IGNORE INTO news(dedup_key, ticker, title, url, source, published, summary, first_seen)"
            " VALUES (?,?,?,?,?,?,?,?)",
            (
                item.dedup_key,
                item.ticker.upper(),
                item.title,
                item.url,
                item.source,
                _iso(item.published),
                item.summary,
                _iso(datetime.now(timezone.utc)),
            ),
        )
        self.conn.commit()
        return cur.rowcount > 0

    # ---- dedup state (per tier/scope) ----
    def already_reported(self, dedup_key: str, scope: str = "all") -> bool:
        row = self.conn.execute(
            "SELECT 1 FROM reported_events WHERE dedup_key=? AND scope=?", (dedup_key, scope)
        ).fetchone()
        return row is not None

    def mark_reported(self, dedup_key: str, ticker: str, kind: str, scope: str = "all") -> None:
        self.conn.execute(
            "INSERT OR REPLACE INTO reported_events(dedup_key, scope, ticker, kind, reported_at)"
            " VALUES (?,?,?,?,?)",
            (dedup_key, scope, ticker.upper(), kind, _iso(datetime.now(timezone.utc))),
        )
        self.conn.commit()

    # ---- value tracking ----
    def get_value_basis(self, ticker: str) -> tuple[float, float] | None:
        row = self.conn.execute(
            "SELECT basis_price, basis_amount FROM value_tracking WHERE ticker=?", (ticker.upper(),)
        ).fetchone()
        return (row["basis_price"], row["basis_amount"]) if row else None

    def set_value_basis(self, ticker: str, price: float, amount: float) -> None:
        self.conn.execute(
            "INSERT OR REPLACE INTO value_tracking(ticker, basis_price, basis_amount, updated_at)"
            " VALUES (?,?,?,?)",
            (ticker.upper(), price, amount, _iso(datetime.now(timezone.utc))),
        )
        self.conn.commit()

    # ---- digest history ----
    def save_digest(self, meta: dict, payload_json: str) -> int:
        cur = self.conn.execute(
            "INSERT INTO digests(created_at, period, focus, complexity, events_count, watch_count, payload)"
            " VALUES (?,?,?,?,?,?,?)",
            (_iso(datetime.now(timezone.utc)), meta.get("period"), meta.get("focus"),
             meta.get("complexity"), meta.get("events_count", 0), meta.get("watch_count", 0), payload_json),
        )
        self.conn.commit()
        # Keep history bounded.
        self.conn.execute(
            "DELETE FROM digests WHERE id NOT IN (SELECT id FROM digests ORDER BY id DESC LIMIT 200)"
        )
        self.conn.commit()
        return cur.lastrowid

    def list_digests(self, limit: int = 50) -> list[dict]:
        rows = self.conn.execute(
            "SELECT id, created_at, period, focus, complexity, events_count, watch_count"
            " FROM digests ORDER BY id DESC LIMIT ?", (limit,)
        ).fetchall()
        return [dict(r) for r in rows]

    def get_digest(self, digest_id: int) -> str | None:
        row = self.conn.execute("SELECT payload FROM digests WHERE id=?", (digest_id,)).fetchone()
        return row["payload"] if row else None
