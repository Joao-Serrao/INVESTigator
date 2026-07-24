"""Look-through exposure.

Turns "I hold 25% IWDA + 16% AAPL" into "I actually have 3.x% effective AAPL once
the ETF is decomposed". Combines direct positions with ETF constituents to produce
effective exposure by name, sector, and country.

All deterministic. The ETF compositions used here come from the (cached, free)
iShares feed; this module does the arithmetic so the LLM never has to.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from typing import Callable

from ..ingest.etf_holdings import base_ticker
from ..models import ETFComposition, Exposure, Holding


@dataclass
class LookThrough:
    by_name: list[Exposure] = field(default_factory=list)
    by_sector: list[Exposure] = field(default_factory=list)
    by_country: list[Exposure] = field(default_factory=list)
    by_region: list[Exposure] = field(default_factory=list)
    coverage: float = 0.0  # fraction of portfolio successfully decomposed
    opaque: list[tuple[str, float]] = field(default_factory=list)  # (label, weight)
    etf_constituents: dict[str, dict[str, float]] = field(default_factory=dict)  # base -> {name: weight}
    as_of: dict[str, str] = field(default_factory=dict)  # etf base -> data date


def _is_etf(h: Holding) -> bool:
    return h.type.lower() == "etf"


def _name_key(ticker: str, country: str) -> str:
    """Disambiguate same-ticker-different-market collisions (e.g. '2330')."""
    return f"{ticker.upper()}|{(country or '').upper()}"


# Country -> region/continent, so the digest can flag "Europe" or "Emerging Asia"
# concentration (a regional event hits every country in that bloc), not just per-country.
_REGION = {
    "united states": "North America", "canada": "North America",
    "united kingdom": "Europe", "france": "Europe", "germany": "Europe", "switzerland": "Europe",
    "netherlands": "Europe", "sweden": "Europe", "italy": "Europe", "spain": "Europe",
    "denmark": "Europe", "finland": "Europe", "belgium": "Europe", "norway": "Europe",
    "ireland": "Europe", "austria": "Europe", "portugal": "Europe", "luxembourg": "Europe",
    "poland": "Europe", "greece": "Europe",
    "japan": "Developed Asia-Pacific", "australia": "Developed Asia-Pacific",
    "hong kong": "Developed Asia-Pacific", "singapore": "Developed Asia-Pacific",
    "new zealand": "Developed Asia-Pacific",
    "china": "Emerging Asia", "taiwan": "Emerging Asia", "korea (south)": "Emerging Asia",
    "south korea": "Emerging Asia", "india": "Emerging Asia", "indonesia": "Emerging Asia",
    "thailand": "Emerging Asia", "malaysia": "Emerging Asia", "philippines": "Emerging Asia",
    "vietnam": "Emerging Asia", "pakistan": "Emerging Asia",
    "brazil": "Latin America", "mexico": "Latin America", "chile": "Latin America",
    "colombia": "Latin America", "peru": "Latin America", "argentina": "Latin America",
    "saudi arabia": "Middle East & Africa", "united arab emirates": "Middle East & Africa",
    "qatar": "Middle East & Africa", "kuwait": "Middle East & Africa", "israel": "Middle East & Africa",
    "south africa": "Middle East & Africa", "egypt": "Middle East & Africa", "turkey": "Middle East & Africa",
    "nigeria": "Middle East & Africa", "bahrain": "Middle East & Africa", "oman": "Middle East & Africa",
}


def region_of(country: str) -> str:
    return _REGION.get((country or "").strip().lower(), "Other")


def compute_lookthrough(
    holdings: list[Holding], get_comp: Callable[[str, str], ETFComposition | None]
) -> LookThrough:
    by_name: dict[str, list[float]] = defaultdict(lambda: [0.0, 0.0])  # ticker -> [direct, via_etf]
    label: dict[str, str] = {}
    by_sector: dict[str, float] = defaultdict(float)
    by_country: dict[str, float] = defaultdict(float)
    by_region: dict[str, float] = defaultdict(float)
    sec_master: dict[str, tuple[str, str, str]] = {}  # ticker -> (sector, country, name)
    opaque: list[tuple[str, float]] = []
    etf_constituents: dict[str, dict[str, float]] = {}
    as_of: dict[str, str] = {}

    # Resolve compositions once, and build a security master so DIRECT stocks can
    # borrow sector/country from any ETF that contains them (no extra API calls).
    comps: dict[str, ETFComposition] = {}
    for h in holdings:
        if _is_etf(h):
            comp = get_comp(h.ticker, getattr(h, "isin", ""))
            if comp:
                comps[h.key] = comp
                as_of[base_ticker(h.ticker)] = comp.as_of
                for c in comp.constituents:
                    sec_master.setdefault(c.ticker.upper(), (c.sector, c.country, c.name))

    covered = 0.0
    for h in holdings:
        w = h.portfolio_weight
        comp = comps.get(h.key)
        if comp:
            covered += w
            etf_constituents[base_ticker(h.ticker)] = {c.ticker.upper(): c.weight for c in comp.constituents}
            for c in comp.constituents:
                # Key by ticker+country: local exchange tickers collide across markets
                # (e.g. "2330" is TSMC in Taiwan AND Advanced Petrochemical in Saudi).
                k = _name_key(c.ticker, c.country)
                by_name[k][1] += w * c.weight
                label[k] = c.name or c.ticker
                sector = c.asset_class if c.asset_class and c.asset_class != "Equity" else (c.sector or "Unknown")
                by_sector[sector] += w * c.weight
                by_country[c.country or "Unknown"] += w * c.weight
                by_region[region_of(c.country)] += w * c.weight
        elif _is_etf(h):
            opaque.append((h.name or h.ticker, w))
            by_sector["Unmapped ETF"] += w
            by_country["Unmapped ETF"] += w
            by_region["Unmapped ETF"] += w
        else:
            covered += w
            t = base_ticker(h.ticker)
            sector, country, nm = sec_master.get(t, ("Unknown", "Unknown", ""))
            k = _name_key(t, country)  # share the country key so direct+ETF of one name merge
            by_name[k][0] += w
            label[k] = h.name or nm or t
            by_sector[sector or "Unknown"] += w
            by_country[country or "Unknown"] += w
            by_region[region_of(country)] += w

    name_exposures = [
        Exposure(
            key=t, label=label.get(t, t), weight=direct + via, direct=direct, via_etf=via,
            detail=_split_detail(direct, via),
        )
        for t, (direct, via) in by_name.items()
    ]
    name_exposures.sort(key=lambda e: e.weight, reverse=True)

    return LookThrough(
        by_name=name_exposures,
        by_sector=_decoded_exposures(by_sector),
        by_country=_decoded_exposures(by_country),
        by_region=_decoded_exposures(by_region),
        coverage=covered,
        opaque=sorted(opaque, key=lambda x: x[1], reverse=True),
        etf_constituents=etf_constituents,
        as_of=as_of,
    )


def _decoded_exposures(d: dict[str, float]) -> list[Exposure]:
    """Region/sector breakdown as a share of the DECODED portion: drop the opaque
    bucket and renormalise to 100%. This keeps the bars consistent with the
    'of decoded exposure' findings (no more 24.9%-bar vs 33%-finding mismatch)."""
    items = {k: v for k, v in d.items() if k != "Unmapped ETF"}
    total = sum(items.values())
    if total > 0:
        items = {k: v / total for k, v in items.items()}
    out = [Exposure(key=k, label=k, weight=v) for k, v in items.items()]
    out.sort(key=lambda e: e.weight, reverse=True)
    return out


def _split_detail(direct: float, via: float) -> str:
    if direct > 0 and via > 0:
        return f"{direct*100:.1f}% direct + {via*100:.1f}% via ETFs"
    if direct > 0:
        return "held directly"
    return "via ETFs"
