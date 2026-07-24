"""Free company/theme news.

Default source: Google News RSS (per-subject, quoted-name query) + yfinance `.news`
for tickers. Users can extend coverage with custom sources:
  - type "domain": a site like "ft.com" -> we run `"<name>" site:ft.com` Google News
    queries, so anything that site publishes about your names is pulled in.
  - type "rss": a full RSS/Atom feed URL -> we parse it once and keyword-match entries
    to your subjects (holdings + watchlist).

Everything is deduplicated through the store, so only genuinely new items surface.
"""

from __future__ import annotations

import logging
import urllib.parse
from collections import defaultdict
from datetime import datetime, timedelta, timezone

from ..models import NewsItem, Subject
from ..store import Store

log = logging.getLogger(__name__)

GOOGLE_NEWS_RSS = "https://news.google.com/rss/search?q={query}&hl=en-US&gl=US&ceid=US:en"


def fetch_news_for_subjects(
    subjects: list[Subject],
    lookback_days: int,
    store: Store,
    news_sources: list[dict] | None = None,
) -> dict[str, list[NewsItem]]:
    """Return {subject.key: [newly-seen NewsItem, ...]} within the lookback window."""
    cutoff = datetime.now(timezone.utc) - timedelta(days=lookback_days)
    sources = news_sources or []
    domains = [s["value"] for s in sources if s.get("type") == "domain" and s.get("value")]
    rss_feeds = [s for s in sources if s.get("type") == "rss" and s.get("value")]

    results: dict[str, list[NewsItem]] = defaultdict(list)

    for subj in subjects:
        items: list[NewsItem] = []
        items += _google_news(subj, cutoff, site=None)
        for dom in domains:
            items += _google_news(subj, cutoff, site=dom)
        if subj.ticker:
            items += _yfinance_news(subj, cutoff)
        for it in items:
            if store.save_news(it):  # True only the first time we see this URL
                results[subj.key].append(it)

    # Custom RSS feeds are general; fetch each once and attribute by keyword match.
    for feed in rss_feeds:
        for subj_key, item in _rss_feed_matches(feed, subjects, cutoff):
            if store.save_news(item):
                results[subj_key].append(item)

    return results


# Back-compat helper used by older call sites / tests.
def fetch_news(holdings, lookback_days, store):
    subjects = [
        Subject(name=h.name or h.ticker, ticker=h.ticker, owned=True,
                weight=getattr(h, "portfolio_weight", 0.0), strategy_tag=h.strategy_tag, type=h.type)
        for h in holdings
    ]
    by_key = fetch_news_for_subjects(subjects, lookback_days, store)
    out = []
    for items in by_key.values():
        out.extend(items)
    return out


def _query_for(subj: Subject, site: str | None) -> str:
    base = subj.name or subj.ticker
    # Quote a company name for precision; leave themes unquoted for broader matching.
    q = f'"{base}"' if not subj.is_theme else base
    if site:
        q += f" site:{site}"
    return urllib.parse.quote_plus(q)


def _google_news(subj: Subject, cutoff: datetime, site: str | None) -> list[NewsItem]:
    try:
        import feedparser
    except ImportError:
        log.warning("feedparser not installed; skipping Google News.")
        return []
    url = GOOGLE_NEWS_RSS.format(query=_query_for(subj, site))
    out: list[NewsItem] = []
    try:
        feed = feedparser.parse(url)
        for e in feed.entries[:10]:
            published = _parse_struct_time(getattr(e, "published_parsed", None))
            if published and published < cutoff:
                continue
            out.append(NewsItem(
                ticker=subj.key,
                title=getattr(e, "title", "").strip(),
                url=getattr(e, "link", "").strip(),
                source=getattr(getattr(e, "source", None), "title", site or "Google News"),
                published=published,
                summary=getattr(e, "summary", "")[:500],
            ))
    except Exception as ex:  # noqa: BLE001 - external
        log.warning("Google News fetch failed for %s (%s): %s", subj.key, site, ex)
    return out


def _yfinance_news(subj: Subject, cutoff: datetime) -> list[NewsItem]:
    try:
        import yfinance as yf
    except ImportError:
        return []
    out: list[NewsItem] = []
    try:
        for n in (yf.Ticker(subj.ticker).news or [])[:10]:
            content = n.get("content", n)  # yfinance schema varies by version
            title = (content.get("title") or "").strip()
            link = ""
            if isinstance(content.get("clickThroughUrl"), dict):
                link = content["clickThroughUrl"].get("url", "")
            link = link or content.get("link", "") or n.get("link", "")
            ts = n.get("providerPublishTime")
            published = datetime.fromtimestamp(ts, tz=timezone.utc) if isinstance(ts, (int, float)) else None
            if published and published < cutoff:
                continue
            if not title:
                continue
            out.append(NewsItem(
                ticker=subj.key, title=title, url=link,
                source=(content.get("provider", {}) or {}).get("displayName", "Yahoo Finance")
                if isinstance(content.get("provider"), dict) else "Yahoo Finance",
                published=published, summary=(content.get("summary") or "")[:500],
            ))
    except Exception as ex:  # noqa: BLE001 - external
        log.warning("yfinance news fetch failed for %s: %s", subj.key, ex)
    return out


def _rss_feed_matches(feed_cfg: dict, subjects: list[Subject], cutoff: datetime):
    """Yield (subject_key, NewsItem) for entries in a custom feed that mention a subject."""
    try:
        import feedparser
    except ImportError:
        return
    url = feed_cfg["value"]
    name = feed_cfg.get("name") or url
    try:
        feed = feedparser.parse(url)
    except Exception as ex:  # noqa: BLE001
        log.warning("Custom RSS fetch failed (%s): %s", url, ex)
        return
    # Build match terms per subject (name words + ticker).
    terms = []
    for s in subjects:
        keys = {t for t in [s.ticker, s.name] if t}
        terms.append((s.key, [k.lower() for k in keys]))
    for e in feed.entries[:60]:
        published = _parse_struct_time(getattr(e, "published_parsed", None))
        if published and published < cutoff:
            continue
        text = (getattr(e, "title", "") + " " + getattr(e, "summary", "")).lower()
        for subj_key, keys in terms:
            if any(k in text for k in keys if len(k) >= 3):
                yield subj_key, NewsItem(
                    ticker=subj_key, title=getattr(e, "title", "").strip(),
                    url=getattr(e, "link", "").strip(), source=name,
                    published=published, summary=getattr(e, "summary", "")[:500],
                )
                break


def _parse_struct_time(st) -> datetime | None:
    if not st:
        return None
    try:
        return datetime(*st[:6], tzinfo=timezone.utc)
    except Exception:  # noqa: BLE001
        return None
