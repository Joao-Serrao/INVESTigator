"""Core data structures shared across layers.

These are plain dataclasses so the deterministic engine, the store, and the LLM
brain all speak the same vocabulary. The LLM receives these as already-computed
facts; it never recomputes the numbers.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


@dataclass
class Holding:
    """A single weighted position. Weight is filled in by the engine."""

    ticker: str
    name: str = ""
    type: str = "equity"  # etf | growth_stock | experimental | equity | ...
    amount_invested_eur: float = 0.0
    avg_cost: float = 0.0
    strategy_tag: str = ""  # core | growth | speculative | ...
    isin: str = ""  # optional; improves ETF look-through resolution across listings
    source: str = "csv"  # where the position was entered (csv / app form)

    # Derived (engine-filled, not from source):
    portfolio_weight: float = 0.0  # fraction of total portfolio value
    current_value: float = 0.0  # price-adjusted estimate of today's value (0 = unknown)

    @property
    def key(self) -> str:
        return self.ticker.upper()


@dataclass
class PriceSnapshot:
    ticker: str
    price: float
    currency: str = ""
    change_pct_1d: float | None = None  # daily % change, if available
    as_of: datetime = field(default_factory=utcnow)
    stale: bool = False  # True if we couldn't refresh and reused cached data


@dataclass
class NewsItem:
    ticker: str  # the holding this news was fetched for ("" = macro/general)
    title: str
    url: str
    source: str = ""
    published: datetime | None = None
    summary: str = ""

    @property
    def dedup_key(self) -> str:
        # URL is the natural identity; fall back to title.
        return (self.url or self.title).strip().lower()


@dataclass
class Event:
    """A scored, deduplicated thing-that-happened, ready for the digest.

    `urgency` is a SORT KEY, not truth. It is additive + clamped (see engine),
    so a single zero factor never silently nukes an otherwise important event.
    """

    ticker: str
    kind: str  # price_move | news | ...
    severity: str  # low | medium | high
    urgency: float
    headline: str
    explanation: str  # *why it matters to YOU* — required, never empty
    url: str = ""
    created_at: datetime = field(default_factory=utcnow)

    @property
    def dedup_key(self) -> str:
        return f"{self.ticker.upper()}|{self.kind}|{(self.url or self.headline).strip().lower()}"


@dataclass
class Constituent:
    """One underlying line inside an ETF composition."""

    ticker: str
    name: str
    weight: float  # fraction of the ETF (0..1)
    sector: str = ""
    country: str = ""
    asset_class: str = "Equity"


@dataclass
class ETFComposition:
    ticker: str  # base ticker (no exchange suffix)
    name: str
    as_of: str  # date string from the source
    source: str  # e.g. "ishares" | "manual" | "cache"
    constituents: list[Constituent] = field(default_factory=list)
    stale: bool = False


@dataclass
class Exposure:
    """An effective exposure line after ETF look-through."""

    key: str  # ticker / sector name / country name
    label: str
    weight: float  # effective fraction of total portfolio (0..1)
    direct: float = 0.0  # portion held directly
    via_etf: float = 0.0  # portion held through ETFs
    detail: str = ""


@dataclass
class Finding:
    """A structural insight (look-through / concentration / plan drift).

    Unlike Events (things that happened), Findings describe the *current shape* of
    the portfolio. They carry their own why-it-matters context and never advise.
    """

    kind: str  # concentration | overlap | region | sector | plan_drift | lookthrough
    title: str
    detail: str
    severity: str = "info"  # info | note | watch


@dataclass
class Subject:
    """A thing we track news/prices for — a holding or a watchlist entry.

    Watchlist entries can be tickers (NVDA) or themes ("clean energy"). Themes have
    no ticker, so they get news only, no price.
    """

    name: str
    ticker: str = ""  # empty for pure themes
    owned: bool = False  # True = a current holding; False = watchlist/discovery
    weight: float = 0.0  # portfolio weight if owned
    strategy_tag: str = ""
    type: str = "equity"

    @property
    def key(self) -> str:
        return (self.ticker or self.name).upper()

    @property
    def is_theme(self) -> bool:
        return not self.ticker


@dataclass
class Digest:
    generated_at: datetime
    period: str  # e.g. "weekly"
    events: list[Event]
    portfolio_total_eur: float
    data_freshness: str  # human-readable freshness label
    amounts_provided: bool = True  # False when holdings have no invested amounts
    structure: list[Finding] = field(default_factory=list)  # look-through / concentration / plan
    watchlist: list[Event] = field(default_factory=list)  # events about things you DON'T own yet
    delivery_report: list = field(default_factory=list)  # per-channel send results
    narrative: str = ""  # filled by the brain
