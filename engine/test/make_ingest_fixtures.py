"""Capture real ingestion responses + Python's parse of them, for the TS parity harness.

Live data moves, so unlike stages 1-2 we can't compare live fetches. Instead we
snapshot real payloads once (raw/), have the Python parsers produce their output
(expected/), and assert the TypeScript parsers produce byte-identical results.

Run:  python engine/test/make_ingest_fixtures.py
Fixtures are gitignored (they contain third-party content and are large).
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "src"))

import requests  # noqa: E402

from investraton.ingest.etf_holdings import _parse_ishares_csv  # noqa: E402
from investraton.ingest.news import _query_for  # noqa: E402
from investraton.models import Subject  # noqa: E402

OUT = Path(__file__).resolve().parent / "fixtures" / "ingest"
RAW = OUT / "raw"
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}

# Real, stable symbols/products. SXR8 = iShares Core S&P 500 (verified live earlier).
PRICE_TICKERS = ["SXR8.DE", "AAPL", "IWDA.AS"]
ISHARES = [("253743", "IVV")]  # product id -> label
NEWS_SUBJECTS = [
    Subject(name="Apple Inc.", ticker="AAPL", owned=True, weight=0.1, type="equity"),
    Subject(name="artificial intelligence", ticker="", owned=False, weight=0.0, type="theme"),
]


def get(url: str) -> str | None:
    try:
        r = requests.get(url, headers=UA, timeout=30)
        r.raise_for_status()
        return r.content.decode("utf-8-sig", errors="replace")
    except Exception as e:  # noqa: BLE001
        print(f"  ! fetch failed: {url} -> {e}")
        return None


def write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8", newline="")


# ---------------------------------------------------------------- prices
def parse_chart(ticker: str, payload: dict) -> dict | None:
    """The derivation ingest/prices.py performs via yfinance, applied to the raw
    chart payload yfinance itself wraps. Verified to match yfinance output."""
    results = (payload.get("chart") or {}).get("result") or []
    if not results:
        return None
    res = results[0]
    quotes = ((res.get("indicators") or {}).get("quote") or [{}])[0]
    closes = [c for c in (quotes.get("close") or []) if c is not None]
    if not closes:
        return None
    price = float(closes[-1])
    change = None
    if len(closes) >= 2:
        prev = float(closes[-2])
        if prev:
            change = round((price - prev) / prev * 100.0, 2)
    return {
        "ticker": ticker.upper(),
        "price": round(price, 4),
        "currency": (res.get("meta") or {}).get("currency") or "",
        "change_pct_1d": change,
        "stale": False,
    }


def do_prices() -> dict:
    expected = {}
    for t in PRICE_TICKERS:
        url = f"https://query1.finance.yahoo.com/v8/finance/chart/{t}?range=5d&interval=1d"
        text = get(url)
        if text is None:
            continue
        write(RAW / f"chart_{t}.json", text)
        expected[t] = parse_chart(t, json.loads(text))
        print(f"  prices {t}: {expected[t]}")
    return expected


# ---------------------------------------------------------------- news
def feed_entries(xml: str) -> list[dict]:
    """What feedparser extracts, in the shape news.py consumes."""
    import feedparser

    feed = feedparser.parse(xml)
    out = []
    for e in feed.entries:
        st = getattr(e, "published_parsed", None)
        published = datetime(*st[:6], tzinfo=timezone.utc).isoformat() if st else None
        src = getattr(e, "source", None)
        out.append({
            "title": getattr(e, "title", "").strip(),
            "link": getattr(e, "link", "").strip(),
            "source": (getattr(src, "title", "") if src else "") or "",
            "published": published,
            "summary": getattr(e, "summary", "")[:500],
        })
    return out


def do_news() -> dict:
    """Feed XML is captured raw, alongside feedparser's extraction of every entry
    so the TS RSS parser can be compared field by field."""
    queries, feeds = {}, {}
    for subj in NEWS_SUBJECTS:
        key = subj.key
        queries[key] = {
            "plain": _query_for(subj, None),
            "site": _query_for(subj, "ft.com"),
        }
        url = "https://news.google.com/rss/search?q={q}&hl=en-US&gl=US&ceid=US:en".format(
            q=queries[key]["plain"]
        )
        text = get(url)
        if text is not None:
            fname = f"gnews_{key.replace(':', '_')}.xml"
            write(RAW / fname, text)
            feeds[fname] = feed_entries(text)
            print(f"  news {key}: {len(text)} bytes, {len(feeds[fname])} entries")
    yahoo = get("https://feeds.finance.yahoo.com/rss/2.0/headline?s=AAPL&region=US&lang=en-US")
    if yahoo is not None:
        write(RAW / "yahoo_AAPL.xml", yahoo)
        feeds["yahoo_AAPL.xml"] = feed_entries(yahoo)
        print(f"  news yahoo AAPL: {len(yahoo)} bytes, {len(feeds['yahoo_AAPL.xml'])} entries")
    return {"queries": queries, "feeds": feeds}


# ---------------------------------------------------------------- etf holdings
def do_etf() -> dict:
    # Same template the registry uses (the URL slug is ignored; the product id addresses it).
    tmpl = (
        "https://www.ishares.com/uk/individual/en/products/{pid}/x/1506575576011.ajax"
        "?fileType=csv&fileName=holdings&dataType=fund"
    )
    expected = {}
    for pid, label in ISHARES:
        text = get(tmpl.format(pid=pid))
        if text is None:
            continue
        write(RAW / f"ishares_{pid}.csv", text)
        comp = _parse_ishares_csv(pid, text)
        if comp is None:
            print(f"  ! iShares {pid} ({label}) did not parse")
            continue
        expected[pid] = {
            "ticker": comp.ticker,
            "name": comp.name,
            "as_of": comp.as_of,
            "source": comp.source,
            "constituents": [
                {"ticker": c.ticker, "name": c.name, "weight": c.weight,
                 "sector": c.sector, "country": c.country, "asset_class": c.asset_class}
                for c in comp.constituents
            ],
        }
        print(f"  etf {pid} ({label}): {len(comp.constituents)} constituents as of {comp.as_of}")
    return expected


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    print("prices...")
    prices = do_prices()
    print("news...")
    news = do_news()
    print("etf holdings...")
    etf = do_etf()
    write(
        OUT / "expected.json",
        json.dumps(
            {
                "captured_at": datetime.now(timezone.utc).isoformat(),
                "prices": prices,
                "news": news,
                "etf": etf,
            },
            indent=1,
            sort_keys=True,
        ),
    )
    print(f"\nwrote {OUT / 'expected.json'}")


if __name__ == "__main__":
    main()
