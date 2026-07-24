/** Application service — the API surface as local TypeScript calls.
 *
 * This is the port of api.py's endpoints. On desktop/Android the UI calls these
 * functions directly (via the Tauri bridge) instead of `fetch('/api/...')`, so the
 * request/response SHAPES here match the Python API exactly — the UI is unchanged.
 *
 * Everything platform-specific is injected through AppContext: file/db/http access,
 * the delivery transports, and the schedule-sync hook (Windows tasks / Android
 * alarms). Nothing here knows which platform it runs on.
 */

import { VERSION } from "./version.ts";
import { getComposition } from "../ingest/etfHoldings.ts";
import { cachedPrices } from "../ingest/prices.ts";
import { loadSettings } from "../config.ts";
import { getLlm } from "../brain/llm.ts";
import type { DeliverContext } from "../deliver.ts";
import { sendTestEmail } from "../deliver.ts";
import { analyseStructure, prefetchCompositions, runDigest, serializeDigest } from "../pipeline.ts";
import type { Exposure, Holding, Plan } from "../models.ts";
import { makeHolding } from "../models.ts";
import type { FileSystem, HttpClient, Paths } from "../platform.ts";
import { pyRound } from "../round.ts";
import { applyCurrentValues } from "../valuation.ts";
import { computeWeights } from "../weights.ts";
import {
  COMPLEXITIES, FREQUENCIES, loadAppSettings, loadHoldings, loadPlan,
  normaliseSchedule, saveAppSettings, saveHoldings, savePlan, loadSchedules,
  saveSchedules, type Schedule,
} from "../store/files.ts";
import type { Store } from "../store/db.ts";

export interface AppContext {
  fs: FileSystem;
  http: HttpClient;
  paths: Paths;
  store: Store;
  deliver: DeliverContext;
  /** injectable clock for tests */
  now?: () => Date;
  /** platform hook run after schedules change (Windows tasks / Android alarms).
   * Defaults to a no-op reporting "not supported on this platform". */
  syncTasks?: () => Promise<{ ok: boolean; error?: string; results: unknown[] }>;
}

const SECRET_KEYS = ["anthropic_api_key"];

// ---------------------------------------------------------------- status
export async function getStatus(ctx: AppContext) {
  const s = await loadSettings(ctx.fs, ctx.paths);
  const holdings = await loadHoldings(ctx.fs, ctx.paths);
  const note = holdings.length ? `manual entry: ${holdings.length} positions` : "manual entry: none";
  return {
    version: VERSION,
    now: (ctx.now ?? (() => new Date()))().toISOString(),
    llm_provider: s.llm_provider,
    delivery: s.delivery,
    holdings_count: holdings.length,
    sources: [note],
    // Python reports optional-library presence; the TS engine's fetch stack is
    // always available, so we report the capabilities that actually gate features.
    deps: { http: true },
  };
}

// ---------------------------------------------------------------- holdings
export async function getHoldings(ctx: AppContext) {
  const holdings = await loadHoldings(ctx.fs, ctx.paths);
  const tickers = holdings.filter((h) => h.ticker).map((h) => h.ticker);
  applyCurrentValues(holdings, await cachedPrices(tickers, ctx.store), await ctx.store.allValueBasis());
  computeWeights(holdings);
  return {
    holdings: [...holdings]
      .sort((a, b) => b.portfolio_weight - a.portfolio_weight)
      .map((h) => ({
        ticker: h.ticker, name: h.name, type: h.type,
        amount_invested_eur: h.amount_invested_eur || null,
        avg_cost: h.avg_cost || null, strategy_tag: h.strategy_tag, isin: h.isin,
        weight: pyRound(h.portfolio_weight, 4),
        current_value: h.current_value ? pyRound(h.current_value, 2) : null,
      })),
  };
}

export interface HoldingIn {
  ticker: string; name?: string; type?: string;
  amount_invested_eur?: number | string | null; avg_cost?: number | string | null;
  strategy_tag?: string; isin?: string;
}

export async function putHoldings(ctx: AppContext, rows: HoldingIn[]) {
  const holdings: Holding[] = rows
    .filter((r) => String(r.ticker ?? "").trim())
    .map((r) => makeHolding({
      ticker: String(r.ticker).trim(),
      name: (r.name ?? "").trim(),
      type: (r.type ?? "equity").trim() || "equity",
      amount_invested_eur: numOf(r.amount_invested_eur),
      avg_cost: numOf(r.avg_cost),
      strategy_tag: (r.strategy_tag ?? "").trim(),
      isin: (r.isin ?? "").trim(),
    }));
  await saveHoldings(ctx.fs, ctx.paths, holdings);
  return { saved: rows.length };
}

// ---------------------------------------------------------------- plan
export async function getPlan(ctx: AppContext) {
  const p = await loadPlan(ctx.fs, ctx.paths);
  return {
    profile: p.profile,
    monthly_contribution_eur: p.monthly_contribution_eur,
    allocation_targets: p.allocation_targets,
    watchlist: p.watchlist,
    thresholds: p.thresholds,
  };
}

export interface PlanIn {
  profile?: Record<string, unknown>;
  monthly_contribution_eur?: number;
  allocation_targets?: Record<string, number>;
  watchlist?: string[];
  thresholds?: Partial<Plan["thresholds"]>;
}

export async function putPlan(ctx: AppContext, planIn: PlanIn) {
  const current = await loadPlan(ctx.fs, ctx.paths);
  const plan: Plan = {
    profile: planIn.profile ?? {},
    monthly_contribution_eur: planIn.monthly_contribution_eur ?? 0,
    allocation_targets: planIn.allocation_targets ?? {},
    watchlist: planIn.watchlist ?? [],
    thresholds: { ...current.thresholds, ...(planIn.thresholds ?? {}) },
  };
  await savePlan(ctx.fs, ctx.paths, plan);
  return { saved: true };
}

// ---------------------------------------------------------------- settings
export async function getSettings(ctx: AppContext) {
  const raw = await loadAppSettings(ctx.fs, ctx.paths);
  const s = await loadSettings(ctx.fs, ctx.paths);
  const smtp = { ...s.smtp };
  if (smtp.password) smtp.password = "********";
  return {
    llm_provider: s.llm_provider,
    ollama_host: s.ollama_host,
    ollama_model: s.ollama_model,
    anthropic_api_key: (raw.anthropic_api_key || s.anthropic_api_key) ? "********" : "",
    anthropic_model: s.anthropic_model,
    delivery: s.delivery,
    discord_webhook_url: s.discord_webhook_url,
    smtp,
  };
}

export async function putSettings(ctx: AppContext, incoming: Record<string, unknown>) {
  const current = await loadAppSettings(ctx.fs, ctx.paths);
  // exclude_none: drop keys whose value is null/undefined.
  const data: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(incoming)) if (v !== null && v !== undefined) data[k] = v;
  // Don't overwrite a stored secret with the masking placeholder.
  for (const k of SECRET_KEYS) if (data[k] === "********") delete data[k];
  // MERGE smtp rather than replace, so a partial save (password left blank) never
  // wipes the stored SMTP config.
  if (data.smtp && typeof data.smtp === "object") {
    const incomingSmtp = data.smtp as Record<string, unknown>;
    delete data.smtp;
    const kept: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(incomingSmtp)) {
      if (v !== null && v !== "" && v !== "********") kept[k] = v;
    }
    current.smtp = { ...(current.smtp ?? {}), ...kept };
  }
  Object.assign(current, data);
  await saveAppSettings(ctx.fs, ctx.paths, current);
  return { saved: true };
}

// ---------------------------------------------------------------- structure
export async function getStructure(ctx: AppContext) {
  const holdings = await loadHoldings(ctx.fs, ctx.paths);
  if (!holdings.length) throw new NotFound("No holdings. Add positions first.");
  const tickers = holdings.filter((h) => h.ticker).map((h) => h.ticker);
  applyCurrentValues(holdings, await cachedPrices(tickers, ctx.store), await ctx.store.allValueBasis());
  computeWeights(holdings);
  const plan = await loadPlan(ctx.fs, ctx.paths);
  const getComp = await prefetchCompositions(
    holdings, (t, isin) => getComposition(t, isin, { paths: ctx.paths, fs: ctx.fs, http: ctx.http }),
  );
  const [findings, lt] = analyseStructure(holdings, plan, getComp);
  return {
    coverage: pyRound(lt.coverage, 4),
    opaque: lt.opaque.map(([label, weight]) => ({ label, weight: pyRound(weight, 4) })),
    as_of: lt.as_of,
    by_name: lt.by_name.slice(0, 25).map(exp),
    by_region: lt.by_region.slice(0, 10).map(exp),
    by_country: lt.by_country.slice(0, 12).map(exp),
    by_sector: lt.by_sector.slice(0, 10).map(exp),
    findings: findings.map((f) => ({
      kind: f.kind, title: f.title, detail: f.detail, severity: f.severity,
    })),
  };
}

const exp = (e: Exposure) => ({
  label: e.label, weight: pyRound(e.weight, 4),
  direct: pyRound(e.direct, 4), via_etf: pyRound(e.via_etf, 4), detail: e.detail,
});

// ---------------------------------------------------------------- digest
export async function getDigest(
  ctx: AppContext, opts: { deliver?: boolean; focus?: string; complexity?: string } = {},
) {
  const digest = await runDigest(await deps(ctx), {
    period: "weekly", deliverOutput: opts.deliver ?? false,
    focus: opts.focus ?? "all", complexity: opts.complexity ?? "standard",
  });
  return serializeDigest(digest);
}

// ---------------------------------------------------------------- history
export async function getHistory(ctx: AppContext) {
  return { history: await ctx.store.listDigests(60) };
}

export async function getHistoryItem(ctx: AppContext, id: number) {
  const payload = await ctx.store.getDigest(id);
  if (payload === null) throw new NotFound("No such digest");
  return JSON.parse(payload);
}

// ---------------------------------------------------------------- news sources
export async function getSources(ctx: AppContext) {
  return { sources: (await loadAppSettings(ctx.fs, ctx.paths)).news_sources ?? [] };
}

export interface SourceIn { type: string; value: string; name?: string }

export async function putSources(ctx: AppContext, sources: SourceIn[]) {
  const current = await loadAppSettings(ctx.fs, ctx.paths);
  current.news_sources = sources.map((s) => ({
    type: s.type, value: s.value, name: s.name ?? "",
  }));
  await saveAppSettings(ctx.fs, ctx.paths, current);
  return { saved: sources.length };
}

// ---------------------------------------------------------------- schedules
export async function getSchedules(ctx: AppContext) {
  return {
    schedules: await loadSchedules(ctx.fs, ctx.paths),
    frequencies: FREQUENCIES,
    complexities: COMPLEXITIES,
  };
}

export async function putSchedule(ctx: AppContext, sched: Partial<Schedule>) {
  let items = await loadSchedules(ctx.fs, ctx.paths);
  const norm = normaliseSchedule(sched);
  if (!norm.id) {
    norm.id = newId();
    items.push(norm);
  } else {
    items = items.map((s) => (s.id === norm.id ? norm : s));
    if (!items.some((s) => s.id === norm.id)) items.push(norm);
  }
  await saveSchedules(ctx.fs, ctx.paths, items);
  await (ctx.syncTasks ?? notSupportedSync)();
  return { schedule: norm };
}

export async function deleteSchedule(ctx: AppContext, id: string) {
  const items = (await loadSchedules(ctx.fs, ctx.paths)).filter((s) => s.id !== id);
  await saveSchedules(ctx.fs, ctx.paths, items);
  await (ctx.syncTasks ?? notSupportedSync)();
  return { deleted: id };
}

export async function runSchedule(ctx: AppContext, id: string) {
  const sched = (await loadSchedules(ctx.fs, ctx.paths)).find((s) => s.id === id);
  if (!sched) throw new NotFound(`No schedule with id ${id}`);
  const digest = await runDigest(await deps(ctx), {
    period: sched.frequency, deliverOutput: true, focus: sched.focus,
    complexity: sched.complexity,
    deliveryOverride: sched.delivery.length ? sched.delivery : null,
    skipIfEmpty: sched.skip_if_empty,
  });
  return serializeDigest(digest);
}

// ---------------------------------------------------------------- test email
export async function testEmail(ctx: AppContext) {
  try {
    await sendTestEmail(await loadSettings(ctx.fs, ctx.paths), ctx.deliver);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
  }
}

// ---------------------------------------------------------------- internals
/** Error carrying a 404 intent, so the host bridge can map it to an HTTP status. */
export class NotFound extends Error {
  readonly status = 404;
  constructor(message: string) {
    super(message);
    this.name = "NotFound";
  }
}

async function deps(ctx: AppContext) {
  const settings = await loadSettings(ctx.fs, ctx.paths);
  return {
    store: ctx.store, fs: ctx.fs, http: ctx.http, paths: ctx.paths,
    settings, llm: getLlm(settings, ctx.http), deliver: ctx.deliver, now: ctx.now,
  };
}

function numOf(v: unknown): number {
  if (v === null || v === undefined || v === "") return 0;
  const n = Number(String(v).replaceAll(",", "").trim());
  return Number.isFinite(n) ? n : 0;
}

function newId(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) return g.crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  let s = "";
  while (s.length < 12) s += Math.floor(Math.random() * 16).toString(16);
  return s.slice(0, 12);
}

async function notSupportedSync() {
  return { ok: false, error: "Task scheduling is not wired on this platform yet.", results: [] };
}
