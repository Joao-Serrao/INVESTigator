/** The orchestrator — port of pipeline.py.
 *
 * ingest -> store -> score -> dedup -> narrate -> deliver, in one readable pass.
 * Each stage degrades gracefully and contributes to an honest freshness label.
 *
 * Ingestion (prices / news / ETF compositions) is injected so it can be stubbed
 * for deterministic parity tests; the defaults bind the real Stage-3 fetchers.
 */

import { buildNarrative } from "./brain/narrative.ts";
import type { Llm } from "./brain/llm.ts";
import type { Settings } from "./config.ts";
import { analyseConcentration } from "./concentration.ts";
import { deliver, type DeliverContext } from "./deliver.ts";
import { getComposition } from "./ingest/etfHoldings.ts";
import { fetchNewsForSubjects, type NewsSource } from "./ingest/news.ts";
import { fetchPrices } from "./ingest/prices.ts";
import {
  computeLookthrough, isEtf, type GetComposition, type LookThrough,
} from "./lookthrough.ts";
import type {
  Digest, DigestEvent, ETFComposition, Finding, Holding, NewsItem, Plan, PriceSnapshot, Subject,
} from "./models.ts";
import { aggregateHoldings, eventDedupKey, holdingKey, subjectKey } from "./models.ts";
import { analysePlan } from "./planAlign.ts";
import type { FileSystem, HttpClient, Paths } from "./platform.ts";
import { pyFormat } from "./round.ts";
import { buildSubjects, getComplexity } from "./scoping.ts";
import { loadAppSettings, loadHoldings, loadPlan } from "./store/files.ts";
import type { Store } from "./store/db.ts";
import { priceEvent, newsEvent, watchlistEvent } from "./urgency.ts";
import { applyCurrentValues } from "./valuation.ts";
import { computeWeights } from "./weights.ts";

/** Ingestion the pipeline depends on. Overridable for tests. */
export interface IngestFns {
  fetchPrices(tickers: string[]): Promise<Record<string, PriceSnapshot>>;
  fetchNews(
    subjects: Subject[], lookbackDays: number, sources: NewsSource[], persist?: boolean,
  ): Promise<Record<string, NewsItem[]>>;
  getComposition(ticker: string, isin: string): Promise<ETFComposition | null>;
}

export interface PipelineDeps {
  store: Store;
  fs: FileSystem;
  http: HttpClient;
  paths: Paths;
  settings: Settings;
  llm: Llm;
  deliver: DeliverContext;
  /** clock, injectable for deterministic tests (defaults to real now) */
  now?: () => Date;
  /** override ingestion (defaults to the real Stage-3 fetchers) */
  ingest?: Partial<IngestFns>;
}

export interface RunDigestOptions {
  period?: string;
  deliverOutput?: boolean;
  focus?: string;
  complexity?: string;
  deliveryOverride?: string[] | null;
  skipIfEmpty?: boolean;
}

function defaultIngest(deps: PipelineDeps): IngestFns {
  const { http, store, fs, paths } = deps;
  return {
    fetchPrices: (tickers) => fetchPrices(tickers, http, store),
    fetchNews: (subjects, lookbackDays, sources, persist) =>
      fetchNewsForSubjects(subjects, lookbackDays, http, store, sources, persist),
    getComposition: (ticker, isin) => getComposition(ticker, isin, { paths, fs, http }),
  };
}

/** Keep at most `perTicker` items per ticker (highest urgency first, already
 * sorted), then truncate to `total`. Faithful port of _cap_items. */
function capItems(events: DigestEvent[], perTicker: number, total: number): DigestEvent[] {
  const seen: Record<string, number> = {};
  const kept: DigestEvent[] = [];
  for (const ev of events) {
    const key = ev.ticker.toUpperCase();
    if ((seen[key] ?? 0) >= perTicker) continue;
    seen[key] = (seen[key] ?? 0) + 1;
    kept.push(ev);
    if (kept.length >= total) break;
  }
  return kept;
}

/** min-urgency threshold + per-tier dedup, stable sort by urgency desc, then caps. */
async function filterEvents(
  events: DigestEvent[], minUrgency: number, perSubject: number, total: number,
  store: Store, scope: string,
): Promise<DigestEvent[]> {
  const candidates: DigestEvent[] = [];
  for (const ev of events) {
    if (ev.urgency < minUrgency) continue;
    if (await store.alreadyReported(eventDedupKey(ev), scope)) continue;
    candidates.push(ev);
  }
  // Stable sort (JS Array.sort is stable) — matches Python's stable list.sort.
  candidates.sort((a, b) => b.urgency - a.urgency);
  return capItems(candidates, perSubject, total);
}

/** Structural picture: ETF look-through, concentration, overlap, plan drift.
 * `getComp` is a SYNC lookup into pre-fetched compositions (Python's get_composition
 * is synchronous; here fetching is async and done ahead of time). */
export function analyseStructure(
  holdings: Holding[], plan: Plan, getComp: GetComposition,
): [Finding[], LookThrough] {
  const lt = computeLookthrough(holdings, getComp);
  const findings = [...analyseConcentration(lt), ...analysePlan(holdings, plan)];
  return [findings, lt];
}

/** Pre-fetch ETF compositions once, returning a sync accessor keyed by ticker. */
export async function prefetchCompositions(
  holdings: Holding[], get: IngestFns["getComposition"],
): Promise<GetComposition> {
  const byKey: Record<string, ETFComposition> = {};
  for (const h of holdings) {
    if (!isEtf(h)) continue;
    const comp = await get(h.ticker, h.isin ?? "");
    if (comp) byKey[holdingKey(h)] = comp;
  }
  return (ticker: string) => byKey[ticker.toUpperCase()] ?? null;
}

export async function runDigest(deps: PipelineDeps, opts: RunDigestOptions = {}): Promise<Digest> {
  const period = opts.period ?? "weekly";
  let deliverOutput = opts.deliverOutput ?? true;
  const focus = opts.focus ?? "all";
  const complexity = opts.complexity ?? "standard";
  const now = deps.now ?? (() => new Date());
  const ingest = { ...defaultIngest(deps), ...(deps.ingest ?? {}) };
  const { store, fs, paths } = deps;

  const plan = await loadPlan(fs, paths);
  const cx = getComplexity(complexity, plan.thresholds.min_urgency_to_report);
  const appSettings = await loadAppSettings(fs, paths);
  const newsSources = (appSettings.news_sources ?? []) as NewsSource[];
  const scope = period; // dedup is scoped to this digest's tier

  // 1. Ingest holdings; price + value them, then weight by current value.
  const [holdings, sourceNotes] = await loadHoldingsFor(deps);
  const heldPrices = await ingest.fetchPrices(holdings.filter((h) => h.ticker).map((h) => h.ticker));
  const basis = await store.allValueBasis();
  const updates = applyCurrentValues(holdings, heldPrices, basis);
  for (const [ticker, b] of Object.entries(updates)) {
    await store.setValueBasis(ticker, b.basis_price, b.basis_amount);
  }
  const { total_eur, amounts_given } = computeWeights(holdings);
  const subjects = buildSubjects(holdings, plan.watchlist, focus);
  const ownedSubjects = subjects.filter((s) => s.owned);
  const watchSubjects = subjects.filter((s) => !s.owned);
  const holdingByKey: Record<string, Holding> = {};
  for (const h of holdings) holdingByKey[holdingKey(h)] = h;

  // 2. Prices for watchlist-only tickers (held already fetched) + news.
  const ownedKeys = new Set(holdings.map(holdingKey));
  const watchTickers = watchSubjects
    .filter((s) => s.ticker && !ownedKeys.has(subjectKey(s)))
    .map((s) => s.ticker);
  const prices: Record<string, PriceSnapshot> = {
    ...heldPrices,
    ...(watchTickers.length ? await ingest.fetchPrices(watchTickers) : {}),
  };
  // Only a delivering run consumes news from the dedup store; a preview reads it
  // read-only so it can't starve the later scheduled/delivered digest.
  const newsBySubject = await ingest.fetchNews(
    subjects, plan.thresholds.news_lookback_days, newsSources, deliverOutput,
  );
  const nNews = Object.values(newsBySubject).reduce((a, v) => a + v.length, 0);

  // 3. Score into events (deterministic).
  const events: DigestEvent[] = [];
  const watchEvents: DigestEvent[] = [];
  for (const s of ownedSubjects) {
    const h = holdingByKey[subjectKey(s)];
    if (!h) continue;
    const snap = prices[subjectKey(s)];
    if (snap) {
      const ev = priceEvent(h, snap, plan);
      if (ev) events.push(ev);
    }
    for (const item of newsBySubject[subjectKey(s)] ?? []) {
      const ev = newsEvent(h, item, plan);
      if (ev) events.push(ev);
    }
  }
  for (const s of watchSubjects) {
    for (const item of newsBySubject[subjectKey(s)] ?? []) {
      const ev = watchlistEvent(s, item, plan);
      if (ev) watchEvents.push(ev);
    }
  }

  // 4. Threshold (per complexity) + per-tier dedup, then anti-flood caps.
  const kept = await filterEvents(events, cx.min_urgency, cx.max_per_subject, cx.max_total, store, scope);
  const th = plan.thresholds;
  const watchKept = cx.include_watchlist
    ? await filterEvents(watchEvents, th.watchlist_min_urgency, th.watchlist_max_per_item, 60, store, scope)
    : [];

  // 5. Structural analysis (only when the preset asks for it and we hold things).
  let structure: Finding[] = [];
  let lt: LookThrough | null = null;
  if (cx.include_structure && holdings.length) {
    const getComp = await prefetchCompositions(holdings, ingest.getComposition);
    [structure, lt] = analyseStructure(holdings, plan, getComp);
  }

  // 6. Build the digest + narrative.
  const staleCount = Object.values(prices).filter((s) => s.stale).length;
  let freshness = freshnessLabel(sourceNotes, Object.keys(prices).length, staleCount, nNews, focus, cx.label);
  if (!amounts_given && holdings.length) freshness += " · amounts not set (equal-weighted)";
  if (lt !== null) freshness += ` · look-through covers ${pyFormat(lt.coverage * 100, 0)}% of portfolio`;

  const digest: Digest = {
    generated_at: now(),
    period,
    events: kept,
    portfolio_total_eur: total_eur,
    data_freshness: freshness,
    amounts_provided: amounts_given,
    structure,
    watchlist: watchKept,
    delivery_report: [],
    narrative: "",
  };
  digest.narrative = await buildNarrative(digest, deps.llm);

  // 7. Save to history (every run), BEFORE delivery — so the payload matches Python
  //    (delivery_report is empty in stored history).
  await store.saveDigest(
    { period, focus, complexity: cx.label, events_count: kept.length, watch_count: watchKept.length },
    JSON.stringify(serializeDigest(digest)),
  );

  // 8. Deliver (unless asked to stay silent on an empty digest), then record what
  //    we reported.
  const nothingFound = !kept.length && !watchKept.length;
  if (deliverOutput && opts.skipIfEmpty && nothingFound) deliverOutput = false;
  if (deliverOutput) {
    const settings = opts.deliveryOverride
      ? { ...deps.settings, delivery: opts.deliveryOverride }
      : deps.settings;
    digest.delivery_report = await deliver(digest, settings, deps.deliver);
    for (const ev of [...kept, ...watchKept]) {
      await store.markReported(eventDedupKey(ev), ev.ticker, ev.kind, scope);
    }
  }

  return digest;
}

export interface SerializedDigest {
  generated_at: string;
  portfolio_total_eur: number;
  amounts_provided: boolean;
  data_freshness: string;
  narrative: string;
  events: SerializedEvent[];
  watchlist: SerializedEvent[];
  structure: Array<{ kind: string; title: string; detail: string; severity: string }>;
  delivery_report: Digest["delivery_report"];
}
interface SerializedEvent {
  ticker: string; kind: string; severity: string; urgency: number;
  headline: string; explanation: string; url: string;
}

/** JSON-able dict of a digest — shared by the API and the history store. */
export function serializeDigest(digest: Digest): SerializedDigest {
  const ev = (e: DigestEvent): SerializedEvent => ({
    ticker: e.ticker, kind: e.kind, severity: e.severity, urgency: e.urgency,
    headline: e.headline, explanation: e.explanation, url: e.url,
  });
  return {
    generated_at: pyIsoUtc(digest.generated_at),
    portfolio_total_eur: digest.portfolio_total_eur,
    amounts_provided: digest.amounts_provided,
    data_freshness: digest.data_freshness,
    narrative: digest.narrative,
    events: digest.events.map(ev),
    watchlist: digest.watchlist.map(ev),
    structure: digest.structure.map((f) => ({
      kind: f.kind, title: f.title, detail: f.detail, severity: f.severity,
    })),
    delivery_report: digest.delivery_report,
  };
}

function freshnessLabel(
  sourceNotes: string[], nPrices: number, nStale: number, nNews: number,
  focus: string, complexityLabel: string,
): string {
  return [
    `focus: ${focus} · ${complexityLabel}`,
    "holdings[" + sourceNotes.join("; ") + "]",
    `prices: ${nPrices} (${nStale} cached/stale)`,
    `new news items: ${nNews}`,
  ].join(" · ");
}

/** datetime.isoformat() for a UTC datetime: microsecond precision, +00:00 offset. */
export function pyIsoUtc(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const micro = String(d.getUTCMilliseconds()).padStart(3, "0") + "000";
  return (
    `${p(d.getUTCFullYear(), 4)}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.${micro}+00:00`
  );
}

/** Mirrors ingest/holdings.load_all_holdings — holdings + a provenance note. */
async function loadHoldingsFor(deps: PipelineDeps): Promise<[Holding[], string[]]> {
  // Merge duplicate-ticker rows up front so every downstream weight/look-through
  // computation keys on one row per ticker.
  const holdings = aggregateHoldings(await loadHoldings(deps.fs, deps.paths));
  const note = holdings.length ? `manual entry: ${holdings.length} positions` : "manual entry: none";
  return [holdings, [note]];
}
