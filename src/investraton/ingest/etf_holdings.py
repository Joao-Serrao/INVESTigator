"""ETF composition ingestion for look-through exposure.

Primary free source: iShares (BlackRock) daily holdings CSV — predictable URLs,
full constituent list with weight + sector + country. Compositions are cached as
JSON under data/etf_holdings/ so we don't refetch constantly and degrade
gracefully offline. Non-iShares ETFs can be supplied via a manual JSON file of
the same shape.
"""

from __future__ import annotations

import csv
import io
import json
import logging
from datetime import datetime, timezone
from pathlib import Path

import requests
import yaml

from ..config import DATA_DIR, RESOURCE_CONFIG_DIR
from ..models import Constituent, ETFComposition

log = logging.getLogger(__name__)

CACHE_DIR = DATA_DIR / "etf_holdings"
_HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}


def base_ticker(ticker: str) -> str:
    """Strip an exchange suffix: IWDA.AS -> IWDA, CSPX.L -> CSPX."""
    return ticker.upper().split(".", 1)[0]


def _load_registry() -> dict:
    path = RESOURCE_CONFIG_DIR / "etf_sources.yaml"
    if not path.exists():
        return {}
    return yaml.safe_load(path.read_text(encoding="utf-8")) or {}


def _resolve_ishares(base: str, isin: str, registry: dict) -> dict | None:
    """Resolve a ticker/ISIN to a fetchable product: a direct iShares fund, or a
    non-iShares fund mapped to a same-index iShares fund (index proxy).

    Returns {"product_id", "name", "isin"} or None.
    """
    isin = (isin or "").upper().strip()
    for entry in registry.get("ishares", []) or []:
        aliases = {str(a).upper() for a in entry.get("aliases", [])}
        aliases.add(str(entry.get("product_id", "")).upper())
        if base in aliases or (isin and isin == str(entry.get("isin", "")).upper()):
            return {"product_id": entry["product_id"], "name": entry.get("name", base),
                    "isin": entry.get("isin", "")}
    for entry in registry.get("index_proxies", []) or []:
        aliases = {str(a).upper() for a in entry.get("aliases", [])}
        if base in aliases or (isin and isin == str(entry.get("isin", "")).upper()):
            return {"product_id": entry["proxy_product_id"], "name": entry.get("name", base),
                    "isin": entry.get("isin", "")}
    return None


def get_composition(ticker: str, isin: str = "") -> ETFComposition | None:
    """Return the composition for an ETF, or None if we have no source.

    Resolves by ticker alias or ISIN -> iShares product id -> holdings CSV.
    Order: fresh cache -> iShares fetch -> stale cache -> manual file.
    """
    base = base_ticker(ticker)
    registry = _load_registry()
    settings = registry.get("settings", {}) or {}
    max_age = settings.get("max_age_days", 7)
    entry = _resolve_ishares(base, isin, registry)
    cache_key = entry["product_id"] if entry else base

    cached = _read_cache(cache_key)
    if cached is not None and _cache_age_days(cache_key) <= max_age:
        return cached

    if entry:
        url = settings.get("url_template", "").format(pid=entry["product_id"])
        fetched = _fetch_ishares(cache_key, url)
        if fetched is not None:
            fetched.name = entry.get("name", base)
            _write_cache(fetched)
            return fetched

    if cached is not None:
        cached.stale = True
        return cached  # better stale than nothing

    manual = _read_manual(base)
    if manual is not None:
        return manual

    log.info("No ETF composition source for %s/%s (not in registry, no cache/manual).", base, isin)
    return None


# ---- iShares CSV ----
def _fetch_ishares(base: str, url: str) -> ETFComposition | None:
    try:
        r = requests.get(url, headers=_HEADERS, timeout=30)
        r.raise_for_status()
        text = r.content.decode("utf-8-sig")
    except Exception as e:  # noqa: BLE001 - external
        log.warning("iShares fetch failed for %s: %s", base, e)
        return None
    return _parse_ishares_csv(base, text)


def _parse_ishares_csv(base: str, text: str) -> ETFComposition | None:
    lines = text.splitlines()
    as_of = ""
    if lines and lines[0].lower().startswith("fund holdings as of"):
        parts = lines[0].split(",", 1)
        as_of = parts[1].strip().strip('"') if len(parts) > 1 else ""
    hdr_idx = next((i for i, l in enumerate(lines) if l.replace('"', "").startswith("Ticker,")), None)
    if hdr_idx is None:
        log.warning("iShares CSV for %s had no recognizable header.", base)
        return None

    reader = csv.DictReader(io.StringIO("\n".join(lines[hdr_idx:])))
    constituents: list[Constituent] = []
    for row in reader:
        tkr = (row.get("Ticker") or "").strip()
        weight = _pct(row.get("Weight (%)"))
        if not tkr or weight <= 0:
            continue
        constituents.append(
            Constituent(
                ticker=tkr,
                name=(row.get("Name") or "").strip(),
                weight=weight / 100.0,
                sector=(row.get("Sector") or "").strip(),
                country=(row.get("Location") or "").strip(),
                asset_class=(row.get("Asset Class") or "Equity").strip(),
            )
        )
    if not constituents:
        return None
    return ETFComposition(
        ticker=base, name=base, as_of=as_of or "unknown", source="ishares", constituents=constituents
    )


def _pct(v) -> float:
    try:
        return float(str(v).replace(",", "").replace("%", "").strip())
    except (TypeError, ValueError):
        return 0.0


# ---- cache + manual ----
def _cache_path(base: str) -> Path:
    return CACHE_DIR / f"{base}.json"


def _read_cache(base: str) -> ETFComposition | None:
    return _read_json(_cache_path(base), default_source="cache")


def _read_manual(base: str) -> ETFComposition | None:
    return _read_json(_cache_path(base), default_source="manual")


def _read_json(path: Path, default_source: str) -> ETFComposition | None:
    if not path.exists():
        return None
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        return ETFComposition(
            ticker=raw["ticker"],
            name=raw.get("name", raw["ticker"]),
            as_of=raw.get("as_of", "unknown"),
            source=raw.get("source", default_source),
            constituents=[
                Constituent(
                    ticker=c["ticker"], name=c.get("name", c["ticker"]), weight=float(c["weight"]),
                    sector=c.get("sector", ""), country=c.get("country", ""),
                    asset_class=c.get("asset_class", "Equity"),
                )
                for c in raw.get("constituents", [])
            ],
        )
    except Exception as e:  # noqa: BLE001
        log.warning("Could not read composition file %s: %s", path, e)
        return None


def _write_cache(comp: ETFComposition) -> None:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    payload = {
        "ticker": comp.ticker,
        "name": comp.name,
        "as_of": comp.as_of,
        "source": comp.source,
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "constituents": [
            {"ticker": c.ticker, "name": c.name, "weight": c.weight,
             "sector": c.sector, "country": c.country, "asset_class": c.asset_class}
            for c in comp.constituents
        ],
    }
    _cache_path(comp.ticker).write_text(json.dumps(payload), encoding="utf-8")


def _cache_age_days(base: str) -> float:
    path = _cache_path(base)
    if not path.exists():
        return 1e9
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        fetched = datetime.fromisoformat(raw["fetched_at"])
        return (datetime.now(timezone.utc) - fetched).total_seconds() / 86400.0
    except Exception:  # noqa: BLE001
        return 1e9
