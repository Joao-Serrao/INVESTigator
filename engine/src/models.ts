/** Core data structures, mirroring src/investraton/models.py exactly.
 *
 * These are shared by the deterministic engine so the TypeScript port speaks the
 * same vocabulary as the Python original — a prerequisite for output parity.
 */

export interface Holding {
  ticker: string;
  name: string;
  type: string; // etf | growth_stock | experimental | equity | ...
  amount_invested_eur: number;
  avg_cost: number;
  strategy_tag: string;
  isin: string;
  source: string;
  /** Derived (engine-filled) */
  portfolio_weight: number;
  /** Price-adjusted estimate of today's value (0 = unknown) */
  current_value: number;
}

export interface PriceSnapshot {
  ticker: string;
  price: number;
  currency: string;
  change_pct_1d: number | null;
  stale: boolean;
}

export interface NewsItem {
  ticker: string;
  title: string;
  url: string;
  source: string;
  summary: string;
}

export interface Constituent {
  ticker: string;
  name: string;
  /** fraction of the ETF (0..1) */
  weight: number;
  sector: string;
  country: string;
  asset_class: string;
}

export interface ETFComposition {
  ticker: string;
  name: string;
  as_of: string;
  source: string;
  constituents: Constituent[];
  stale: boolean;
}

export interface Exposure {
  key: string;
  label: string;
  /** effective fraction of the portfolio (0..1) */
  weight: number;
  direct: number;
  via_etf: number;
  detail: string;
}

export interface Finding {
  kind: string; // concentration | overlap | region | sector | plan_drift
  title: string;
  detail: string;
  severity: string; // info | note | watch
}

export interface DigestEvent {
  ticker: string;
  kind: string; // price_move | news | watchlist
  severity: string; // low | medium | high
  urgency: number;
  headline: string;
  explanation: string;
  url: string;
}

export interface Subject {
  name: string;
  /** empty for pure themes */
  ticker: string;
  owned: boolean;
  weight: number;
  strategy_tag: string;
  type: string;
}

/** Per-channel delivery outcome (mirrors deliver.deliver()'s report entries). */
export interface DeliveryResult {
  channel: string;
  ok: boolean;
  error?: string;
}

export interface Digest {
  /** the run's timestamp; serialised via .isoformat() on the Python side */
  generated_at: Date;
  period: string;
  events: DigestEvent[];
  portfolio_total_eur: number;
  data_freshness: string;
  amounts_provided: boolean;
  structure: Finding[];
  watchlist: DigestEvent[];
  delivery_report: DeliveryResult[];
  narrative: string;
}

/** Event.dedup_key — `TICKER|kind|(url or headline lowercased)`. */
export const eventDedupKey = (e: DigestEvent): string =>
  `${e.ticker.toUpperCase()}|${e.kind}|${(e.url || e.headline).trim().toLowerCase()}`;

export interface Thresholds {
  price_move_pct: number;
  min_urgency_to_report: number;
  news_lookback_days: number;
  watchlist_min_urgency: number;
  watchlist_max_per_item: number;
}

export interface Plan {
  profile: Record<string, unknown>;
  monthly_contribution_eur: number;
  allocation_targets: Record<string, number>;
  watchlist: string[];
  thresholds: Thresholds;
}

/** Holding.key — ticker upper-cased. */
export const holdingKey = (h: Holding): string => h.ticker.toUpperCase();

/** Subject.key — ticker if present, else the name; upper-cased. */
export const subjectKey = (s: Subject): string => (s.ticker || s.name).toUpperCase();

export const isTheme = (s: Subject): boolean => !s.ticker;

export function makeHolding(p: Partial<Holding> & { ticker: string }): Holding {
  return {
    name: "", type: "equity", amount_invested_eur: 0, avg_cost: 0,
    strategy_tag: "", isin: "", source: "csv", portfolio_weight: 0, current_value: 0,
    ...p,
  };
}
