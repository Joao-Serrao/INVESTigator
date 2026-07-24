/** ETF composition ingestion — port of ingest/etf_holdings.py.
 *
 * Primary free source: iShares (BlackRock) daily holdings CSV — predictable
 * product-id URLs, full constituent list with weight + sector + country.
 * Non-iShares funds tracking the same index are resolved through
 * `index_proxies` in etf_sources.yaml (this is how EXUS, an Xtrackers fund,
 * gets look-through from an iShares fund on the same index).
 *
 * Compositions are cached as JSON so we don't refetch constantly and degrade
 * gracefully offline. Order: fresh cache -> fetch -> stale cache -> manual file.
 */

import { load as yamlLoad } from "js-yaml";

import type { Constituent, ETFComposition } from "../models.ts";
import type { FileSystem, HttpClient, Paths } from "../platform.ts";
import { dataDir, resourceConfigDir } from "../platform.ts";
import { parseCsvDicts } from "../store/files.ts";

export interface RegistryEntry {
  product_id?: string | number;
  proxy_product_id?: string | number;
  isin?: string;
  name?: string;
  aliases?: (string | number)[];
}

export interface Registry {
  ishares?: RegistryEntry[];
  index_proxies?: RegistryEntry[];
  settings?: { max_age_days?: number; url_template?: string };
}

export interface ResolvedProduct { product_id: string; name: string; isin: string }

/** Strip an exchange suffix: IWDA.AS -> IWDA, CSPX.L -> CSPX. */
export const baseTicker = (ticker: string): string => ticker.toUpperCase().split(".", 1)[0];

const cacheDir = (p: Paths, fs: FileSystem) => fs.join(dataDir(p, fs), "etf_holdings");
const cachePath = (p: Paths, fs: FileSystem, base: string) =>
  fs.join(cacheDir(p, fs), `${base}.json`);

export async function loadRegistry(p: Paths, fs: FileSystem): Promise<Registry> {
  const path = fs.join(resourceConfigDir(p, fs), "etf_sources.yaml");
  const text = await fs.readText(path);
  if (text === null) return {};
  return (yamlLoad(text) as Registry) ?? {};
}

/** Resolve a ticker/ISIN to a fetchable iShares product, directly or via an
 * index proxy. Mirrors _resolve_ishares(). */
export function resolveIshares(
  base: string, isin: string, registry: Registry,
): ResolvedProduct | null {
  const want = (isin || "").toUpperCase().trim();
  const aliasesOf = (e: RegistryEntry, extra?: unknown) => {
    const s = new Set((e.aliases ?? []).map((a) => String(a).toUpperCase()));
    if (extra !== undefined) s.add(String(extra ?? "").toUpperCase());
    return s;
  };
  for (const e of registry.ishares ?? []) {
    const aliases = aliasesOf(e, e.product_id);
    if (aliases.has(base) || (want && want === String(e.isin ?? "").toUpperCase())) {
      return { product_id: String(e.product_id), name: e.name ?? base, isin: e.isin ?? "" };
    }
  }
  for (const e of registry.index_proxies ?? []) {
    const aliases = aliasesOf(e);
    if (aliases.has(base) || (want && want === String(e.isin ?? "").toUpperCase())) {
      return { product_id: String(e.proxy_product_id), name: e.name ?? base, isin: e.isin ?? "" };
    }
  }
  return null;
}

/** float(str(v).replace(",","").replace("%","").strip()) with 0.0 on failure. */
export function pct(v: unknown): number {
  if (v === null || v === undefined) return 0;
  const n = Number(String(v).replace(/,/g, "").replace(/%/g, "").trim());
  return Number.isFinite(n) ? n : 0;
}

/** Parse an iShares daily holdings CSV. Mirrors _parse_ishares_csv(). */
export function parseIsharesCsv(base: string, text: string): ETFComposition | null {
  const lines = text.split(/\r\n|\r|\n/);
  let asOf = "";
  if (lines.length && lines[0].toLowerCase().startsWith("fund holdings as of")) {
    const idx = lines[0].indexOf(",");
    if (idx !== -1) asOf = lines[0].slice(idx + 1).trim().replace(/^"|"$/g, "");
  }
  const hdrIdx = lines.findIndex((l) => l.replace(/"/g, "").startsWith("Ticker,"));
  if (hdrIdx === -1) return null; // no recognizable header

  const rows = parseCsvDicts(lines.slice(hdrIdx).join("\n"));
  const constituents: Constituent[] = [];
  for (const row of rows) {
    const tkr = (row["Ticker"] ?? "").trim();
    const weight = pct(row["Weight (%)"]);
    if (!tkr || weight <= 0) continue;
    constituents.push({
      ticker: tkr,
      name: (row["Name"] ?? "").trim(),
      weight: weight / 100,
      sector: (row["Sector"] ?? "").trim(),
      country: (row["Location"] ?? "").trim(),
      asset_class: (row["Asset Class"] ?? "Equity").trim() || "Equity",
    });
  }
  if (constituents.length === 0) return null;
  return {
    ticker: base, name: base, as_of: asOf || "unknown",
    source: "ishares", constituents, stale: false,
  };
}

// ---- cache + manual ----
interface CachedPayload {
  ticker: string; name?: string; as_of?: string; source?: string;
  fetched_at?: string;
  constituents?: Array<Partial<Constituent> & { ticker: string; weight: number | string }>;
}

async function readJsonComposition(
  p: Paths, fs: FileSystem, base: string, defaultSource: string,
): Promise<{ comp: ETFComposition; fetchedAt: string | null } | null> {
  const text = await fs.readText(cachePath(p, fs, base));
  if (text === null) return null;
  try {
    const raw = JSON.parse(text) as CachedPayload;
    const comp: ETFComposition = {
      ticker: raw.ticker,
      name: raw.name ?? raw.ticker,
      as_of: raw.as_of ?? "unknown",
      source: raw.source ?? defaultSource,
      constituents: (raw.constituents ?? []).map((c) => ({
        ticker: c.ticker,
        name: c.name ?? c.ticker,
        weight: Number(c.weight),
        sector: c.sector ?? "",
        country: c.country ?? "",
        asset_class: c.asset_class ?? "Equity",
      })),
      stale: false,
    };
    return { comp, fetchedAt: raw.fetched_at ?? null };
  } catch {
    return null; // unreadable composition file
  }
}

/** Age of a cached composition in days; 1e9 when missing/unreadable. */
export function cacheAgeDays(fetchedAt: string | null, now = Date.now()): number {
  if (!fetchedAt) return 1e9;
  const t = Date.parse(fetchedAt);
  if (!Number.isFinite(t)) return 1e9;
  return (now - t) / 86_400_000;
}

async function writeCache(
  p: Paths, fs: FileSystem, comp: ETFComposition,
): Promise<void> {
  await fs.mkdirp(cacheDir(p, fs));
  const payload = {
    ticker: comp.ticker, name: comp.name, as_of: comp.as_of, source: comp.source,
    fetched_at: new Date().toISOString(),
    constituents: comp.constituents.map((c) => ({
      ticker: c.ticker, name: c.name, weight: c.weight,
      sector: c.sector, country: c.country, asset_class: c.asset_class,
    })),
  };
  await fs.writeText(cachePath(p, fs, comp.ticker), JSON.stringify(payload));
}

/** Return the composition for an ETF, or null if we have no source at all. */
export async function getComposition(
  ticker: string,
  isin: string,
  ctx: { paths: Paths; fs: FileSystem; http: HttpClient },
): Promise<ETFComposition | null> {
  const { paths, fs, http } = ctx;
  const base = baseTicker(ticker);
  const registry = await loadRegistry(paths, fs);
  const settings = registry.settings ?? {};
  const maxAge = settings.max_age_days ?? 7;
  const entry = resolveIshares(base, isin, registry);
  const cacheKey = entry ? entry.product_id : base;

  const cached = await readJsonComposition(paths, fs, cacheKey, "cache");
  if (cached && cacheAgeDays(cached.fetchedAt) <= maxAge) return cached.comp;

  if (entry) {
    const url = (settings.url_template ?? "").replace("{pid}", entry.product_id);
    const text = url ? await http.getText(url) : null;
    const fetched = text ? parseIsharesCsv(cacheKey, text) : null;
    if (fetched) {
      fetched.name = entry.name ?? base;
      await writeCache(paths, fs, fetched);
      return fetched;
    }
  }

  if (cached) return { ...cached.comp, stale: true }; // better stale than nothing

  const manual = await readJsonComposition(paths, fs, base, "manual");
  return manual ? manual.comp : null;
}
