"""Free price data via yfinance, with graceful degradation to cached values.

If a fetch fails (network down, rate limited, bad ticker) we fall back to the
last stored price and mark it stale, so the digest can say so honestly rather
than silently using old numbers.
"""

from __future__ import annotations

import logging

from ..models import PriceSnapshot, utcnow
from ..store import Store

log = logging.getLogger(__name__)


def fetch_prices(tickers: list[str], store: Store) -> dict[str, PriceSnapshot]:
    out: dict[str, PriceSnapshot] = {}
    try:
        import yfinance as yf
    except ImportError:
        log.warning("yfinance not installed; using cached prices only.")
        return _all_cached(tickers, store)

    for ticker in tickers:
        snap = _fetch_one(yf, ticker)
        if snap is None:
            cached = store.latest_price(ticker)
            if cached is not None:
                out[ticker.upper()] = cached
            continue
        store.save_price(snap)
        out[ticker.upper()] = snap
    return out


def _fetch_one(yf, ticker: str) -> PriceSnapshot | None:
    try:
        t = yf.Ticker(ticker)
        hist = t.history(period="5d")
        if hist is None or hist.empty:
            return None
        closes = hist["Close"].dropna()
        if closes.empty:
            return None
        price = float(closes.iloc[-1])
        change = None
        if len(closes) >= 2:
            prev = float(closes.iloc[-2])
            if prev:
                change = round((price - prev) / prev * 100.0, 2)
        currency = ""
        try:
            currency = (t.fast_info.get("currency") or "") if hasattr(t, "fast_info") else ""
        except Exception:  # noqa: BLE001
            currency = ""
        return PriceSnapshot(
            ticker=ticker.upper(),
            price=round(price, 4),
            currency=currency,
            change_pct_1d=change,
            as_of=utcnow(),
            stale=False,
        )
    except Exception as e:  # noqa: BLE001 - external
        log.warning("price fetch failed for %s: %s", ticker, e)
        return None


def cached_prices(tickers: list[str], store: Store) -> dict[str, PriceSnapshot]:
    """Read last-known prices from the store only (no network). Fast path for the UI."""
    return _all_cached(tickers, store)


def _all_cached(tickers: list[str], store: Store) -> dict[str, PriceSnapshot]:
    out: dict[str, PriceSnapshot] = {}
    for ticker in tickers:
        cached = store.latest_price(ticker)
        if cached is not None:
            out[ticker.upper()] = cached
    return out
