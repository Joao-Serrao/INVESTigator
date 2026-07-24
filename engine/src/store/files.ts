/** File-backed stores. Formats are IDENTICAL to the Python engine so the same
 * files work unchanged — the whole point of the port's compatibility contract.
 */

import { dump as yamlDump, load as yamlLoad } from "js-yaml";

import type { ETFComposition, Holding, Plan, Thresholds } from "../models.ts";
import { makeHolding } from "../models.ts";
import type { FileSystem, Paths } from "../platform.ts";
import { configDir, dataDir, resourceConfigDir } from "../platform.ts";

// ------------------------------------------------------------------ holdings
export const CSV_COLUMNS = [
  "ticker", "name", "type", "amount_invested_eur", "avg_cost", "strategy_tag", "isin",
] as const;

/** Mirrors ingest/holdings.py _f(): tolerate thousands separators and blanks. */
function num(v: string | undefined): number {
  if (v === undefined || v === null) return 0;
  const n = Number(String(v).replaceAll(",", "").trim());
  return Number.isFinite(n) ? n : 0;
}

/** Minimal RFC4180-ish CSV reader (quoted fields, embedded commas/quotes). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === ",") { row.push(field); field = ""; continue; }
    if (c === "\r") continue;
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
    field += c;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length > 1 || (r[0] ?? "").trim() !== "");
}

/** csv.DictReader equivalent: first row is the header, missing fields become "". */
export function parseCsvDicts(text: string): Record<string, string>[] {
  const rows = parseCsv(text);
  if (rows.length === 0) return [];
  const header = rows[0];
  return rows.slice(1).map((r) => {
    const rec: Record<string, string> = {};
    header.forEach((h, i) => { rec[h] = r[i] ?? ""; });
    return rec;
  });
}

export function parseHoldingsCsv(text: string): Holding[] {
  const rows = parseCsv(text);
  if (rows.length === 0) return [];
  const header = rows[0].map((h) => h.trim());
  const out: Holding[] = [];
  for (const r of rows.slice(1)) {
    const rec: Record<string, string> = {};
    header.forEach((h, i) => { rec[h] = r[i] ?? ""; });
    const ticker = (rec["ticker"] ?? "").trim();
    if (!ticker) continue;
    out.push(makeHolding({
      ticker,
      name: (rec["name"] ?? "").trim(),
      type: (rec["type"] ?? "equity").trim() || "equity",
      amount_invested_eur: num(rec["amount_invested_eur"]),
      avg_cost: num(rec["avg_cost"]),
      strategy_tag: (rec["strategy_tag"] ?? "").trim(),
      isin: (rec["isin"] ?? "").trim(),
      source: "csv",
    }));
  }
  return out;
}

export function serializeHoldingsCsv(holdings: Holding[]): string {
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);
  const lines = [CSV_COLUMNS.join(",")];
  for (const h of holdings) {
    const t = h.ticker.trim();
    if (!t) continue;
    lines.push([
      t, h.name?.trim() ?? "", (h.type?.trim() || "equity"),
      h.amount_invested_eur ? String(h.amount_invested_eur) : "",
      h.avg_cost ? String(h.avg_cost) : "",
      h.strategy_tag?.trim() ?? "", h.isin?.trim() ?? "",
    ].map((x) => esc(String(x))).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

export async function loadHoldings(fs: FileSystem, p: Paths): Promise<Holding[]> {
  const text = await fs.readText(fs.join(dataDir(p, fs), "holdings.csv"));
  return text ? parseHoldingsCsv(text) : [];
}

export async function saveHoldings(fs: FileSystem, p: Paths, holdings: Holding[]): Promise<void> {
  await fs.mkdirp(dataDir(p, fs));
  await fs.writeText(fs.join(dataDir(p, fs), "holdings.csv"), serializeHoldingsCsv(holdings));
}

// ---------------------------------------------------------------------- plan
const DEFAULT_THRESHOLDS: Thresholds = {
  price_move_pct: 3.0,
  min_urgency_to_report: 2.0,
  news_lookback_days: 7,
  watchlist_min_urgency: 0.0,
  watchlist_max_per_item: 8,
};

export function parsePlan(text: string): Plan {
  const raw = (yamlLoad(text) ?? {}) as any;
  const planRaw = raw.plan ?? {};
  const th = raw.thresholds ?? {};
  return {
    profile: raw.profile ?? {},
    monthly_contribution_eur: planRaw.monthly_contribution_eur ?? 0,
    allocation_targets: planRaw.allocation_targets ?? {},
    watchlist: planRaw.watchlist ?? [],
    thresholds: {
      price_move_pct: th.price_move_pct ?? DEFAULT_THRESHOLDS.price_move_pct,
      min_urgency_to_report: th.min_urgency_to_report ?? DEFAULT_THRESHOLDS.min_urgency_to_report,
      news_lookback_days: th.news_lookback_days ?? DEFAULT_THRESHOLDS.news_lookback_days,
      watchlist_min_urgency: th.watchlist_min_urgency ?? DEFAULT_THRESHOLDS.watchlist_min_urgency,
      watchlist_max_per_item: th.watchlist_max_per_item ?? DEFAULT_THRESHOLDS.watchlist_max_per_item,
    },
  };
}

export function serializePlan(plan: Plan): string {
  return yamlDump({
    profile: plan.profile,
    plan: {
      monthly_contribution_eur: plan.monthly_contribution_eur,
      allocation_targets: plan.allocation_targets,
      watchlist: plan.watchlist,
    },
    thresholds: plan.thresholds,
  }, { sortKeys: false, lineWidth: -1 });
}

/** User plan, falling back to the bundled example — matches config.load_plan(). */
export async function loadPlan(fs: FileSystem, p: Paths): Promise<Plan> {
  let text = await fs.readText(fs.join(configDir(p, fs), "portfolio_plan.yaml"));
  if (text === null) {
    text = await fs.readText(fs.join(resourceConfigDir(p, fs), "portfolio_plan.example.yaml"));
  }
  return parsePlan(text ?? "");
}

// ------------------------------------------------------------ settings & schedules
export async function loadAppSettings(fs: FileSystem, p: Paths): Promise<Record<string, any>> {
  const text = await fs.readText(fs.join(configDir(p, fs), "app_settings.json"));
  if (!text) return {};
  try { return JSON.parse(text) ?? {}; } catch { return {}; }
}

export async function saveAppSettings(
  fs: FileSystem, p: Paths, data: Record<string, any>,
): Promise<void> {
  await fs.mkdirp(configDir(p, fs));
  await fs.writeText(fs.join(configDir(p, fs), "app_settings.json"), JSON.stringify(data, null, 2));
}

export interface Schedule {
  id: string;
  name: string;
  frequency: string;
  time: string;
  complexity: string;
  focus: string;
  delivery: string[];
  skip_if_empty: boolean;
  enabled: boolean;
}

export const FREQUENCIES = ["daily", "every_3_days", "weekly", "monthly"];
export const COMPLEXITIES = ["simple", "standard", "complex", "urgent", "none"];

/** Mirrors scheduler._normalise(). */
export function normaliseSchedule(s: any): Schedule {
  const freq = s.frequency ?? "weekly";
  return {
    id: s.id ?? "",
    name: s.name ?? "Digest",
    frequency: FREQUENCIES.includes(freq) ? freq : "weekly",
    time: s.time ?? "08:00",
    complexity: COMPLEXITIES.includes(s.complexity) ? s.complexity : "standard",
    focus: s.focus ?? "all",
    delivery: s.delivery && s.delivery.length ? s.delivery : [],
    skip_if_empty: Boolean(s.skip_if_empty ?? false),
    enabled: Boolean(s.enabled ?? true),
  };
}

export async function loadSchedules(fs: FileSystem, p: Paths): Promise<Schedule[]> {
  const text = await fs.readText(fs.join(configDir(p, fs), "schedules.json"));
  if (!text) return [];
  try {
    const arr = JSON.parse(text);
    return Array.isArray(arr) ? arr.map(normaliseSchedule) : [];
  } catch { return []; }
}

export async function saveSchedules(fs: FileSystem, p: Paths, items: Schedule[]): Promise<void> {
  await fs.mkdirp(configDir(p, fs));
  await fs.writeText(fs.join(configDir(p, fs), "schedules.json"), JSON.stringify(items, null, 2));
}

// ----------------------------------------------------------------- ETF cache
/** Cached composition written by ingest/etf_holdings.py — same JSON shape. */
export async function loadCachedComposition(
  fs: FileSystem, p: Paths, cacheKey: string,
): Promise<ETFComposition | null> {
  const text = await fs.readText(fs.join(dataDir(p, fs), "etf_holdings", `${cacheKey}.json`));
  if (!text) return null;
  try {
    const raw = JSON.parse(text);
    return {
      ticker: raw.ticker,
      name: raw.name ?? raw.ticker,
      as_of: raw.as_of ?? "unknown",
      source: raw.source ?? "cache",
      stale: false,
      constituents: (raw.constituents ?? []).map((c: any) => ({
        ticker: c.ticker,
        name: c.name ?? c.ticker,
        weight: Number(c.weight),
        sector: c.sector ?? "",
        country: c.country ?? "",
        asset_class: c.asset_class ?? "Equity",
      })),
    };
  } catch { return null; }
}

