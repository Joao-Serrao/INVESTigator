"""Holdings sources. Holdings are entered by hand via CSV (and an app form later);
the merge logic keeps the door open for additional manual sources without the rest
of the system caring where a position came from.
"""

from __future__ import annotations

import csv
import logging
from pathlib import Path
from typing import Protocol

from ..models import Holding

log = logging.getLogger(__name__)


class HoldingSource(Protocol):
    name: str

    def fetch(self) -> list[Holding]:
        """Return current holdings, or [] if unavailable (never raise to caller)."""
        ...


class CsvSource:
    """Reliable fallback: read holdings from a CSV export/edit.

    Expected columns: ticker, name, type, amount_invested_eur, avg_cost, strategy_tag
    Extra columns are ignored; missing optional ones default sensibly.
    """

    name = "csv"

    def __init__(self, path: Path):
        self.path = path

    def fetch(self) -> list[Holding]:
        if not self.path.exists():
            log.warning("CSV holdings file not found: %s", self.path)
            return []
        out: list[Holding] = []
        with self.path.open(newline="", encoding="utf-8-sig") as fh:
            for row in csv.DictReader(fh):
                ticker = (row.get("ticker") or "").strip()
                if not ticker:
                    continue
                out.append(
                    Holding(
                        ticker=ticker,
                        name=(row.get("name") or "").strip(),
                        type=(row.get("type") or "equity").strip(),
                        amount_invested_eur=_f(row.get("amount_invested_eur")),
                        avg_cost=_f(row.get("avg_cost")),
                        strategy_tag=(row.get("strategy_tag") or "").strip(),
                        isin=(row.get("isin") or "").strip(),
                        source="csv",
                    )
                )
        return out


def _f(v) -> float:
    try:
        return float(str(v).replace(",", "").strip())
    except (TypeError, ValueError):
        return 0.0


CSV_COLUMNS = ["ticker", "name", "type", "amount_invested_eur", "avg_cost", "strategy_tag", "isin"]


def save_holdings_csv(path: Path, rows: list[dict]) -> None:
    """Write holdings to CSV (used by the app's holdings editor)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=CSV_COLUMNS)
        writer.writeheader()
        for r in rows:
            ticker = str(r.get("ticker", "")).strip()
            if not ticker:
                continue
            writer.writerow({
                "ticker": ticker,
                "name": str(r.get("name", "")).strip(),
                "type": str(r.get("type", "equity")).strip() or "equity",
                "amount_invested_eur": r.get("amount_invested_eur", "") or "",
                "avg_cost": r.get("avg_cost", "") or "",
                "strategy_tag": str(r.get("strategy_tag", "")).strip(),
                "isin": str(r.get("isin", "")).strip(),
            })


def merge_holdings(*lists: list[Holding]) -> list[Holding]:
    """Merge sources, summing invested amounts for the same ticker.

    Broker sources take precedence for metadata (name/type) when present.
    """
    by_key: dict[str, Holding] = {}
    for lst in lists:
        for h in lst:
            existing = by_key.get(h.key)
            if existing is None:
                by_key[h.key] = Holding(**vars(h))
            else:
                existing.amount_invested_eur += h.amount_invested_eur
                # Prefer non-empty metadata from a later source.
                existing.name = existing.name or h.name
                existing.strategy_tag = existing.strategy_tag or h.strategy_tag
                if h.source != "csv":
                    existing.source = h.source
    return list(by_key.values())


def load_all_holdings(settings, plan) -> tuple[list[Holding], list[str]]:
    """Load holdings from manual entry (the CSV you maintain, or the app form later).

    No broker APIs: XTB discontinued theirs (2025-03), and Degiro never had an
    official one — so holdings are entered by hand and enriched with public price
    + news data. Returns (holdings, notes) so the digest can label provenance.
    """
    notes: list[str] = []
    csv_holdings = CsvSource(settings.holdings_csv).fetch()
    notes.append(f"manual entry: {len(csv_holdings)} positions" if csv_holdings else "manual entry: none")
    return merge_holdings(csv_holdings), notes
