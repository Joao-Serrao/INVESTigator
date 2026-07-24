/** Storage parity: the TypeScript stores must read the SAME files and database
 * as the Python engine, byte-for-byte in meaning.
 *
 * The database is opened READ-ONLY so this can never modify real data.
 * Paths deliberately mirror Python's dev mode (home = repo root) so both sides
 * read the same files — see PORTING.md's compatibility contract.
 *
 * Run:  npm run storage-parity     (after: python engine/test/make_storage_fixtures.py)
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { NodeDatabase, nodeFs } from "../src/adapters/node.ts";
import type { Paths } from "../src/platform.ts";
import { Store } from "../src/store/db.ts";
import {
  loadAppSettings, loadHoldings, loadPlan, loadSchedules,
} from "../src/store/files.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const exp = JSON.parse(readFileSync(join(here, "fixtures", "storage_expected.json"), "utf-8"));

// Python dev mode: HOME == repo root. Match it so we read identical files.
const paths: Paths = { home: repoRoot, resource: repoRoot };

const SECRET_KEYS = new Set(["anthropic_api_key", "password", "discord_webhook_url"]);
const REDACTED = "<redacted:present>";

function redact(o: any): any {
  if (Array.isArray(o)) return o.map(redact);
  if (o && typeof o === "object") {
    const out: any = {};
    for (const [k, v] of Object.entries(o)) {
      out[k] = SECRET_KEYS.has(k) && v ? REDACTED : redact(v);
    }
    return out;
  }
  return o;
}

const failures: string[] = [];
let checks = 0;
const EPS = 1e-9;

function cmp(path: string, got: unknown, want: unknown): void {
  checks++;
  if (typeof want === "number" && typeof got === "number") {
    const d = Math.abs(got - want);
    if (!(d <= EPS || d <= EPS * Math.max(Math.abs(got), Math.abs(want)))) {
      failures.push(`${path}: got ${got} want ${want}`);
    }
    return;
  }
  if (Array.isArray(want)) {
    if (!Array.isArray(got)) { failures.push(`${path}: not an array`); return; }
    if (got.length !== want.length) {
      failures.push(`${path}: length ${got.length} != ${want.length}`); return;
    }
    want.forEach((w, i) => cmp(`${path}[${i}]`, (got as any[])[i], w));
    return;
  }
  if (want && typeof want === "object") {
    if (!got || typeof got !== "object") { failures.push(`${path}: not an object`); return; }
    for (const k of Object.keys(want as object)) {
      cmp(`${path}.${k}`, (got as any)[k], (want as any)[k]);
    }
    return;
  }
  if (got !== want) {
    failures.push(`${path}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
  }
}

// ------------------------------------------------------------------ files
const holdings = await loadHoldings(nodeFs, paths);
cmp("holdings", holdings.map((h) => ({
  ticker: h.ticker, name: h.name, type: h.type,
  amount_invested_eur: h.amount_invested_eur, avg_cost: h.avg_cost,
  strategy_tag: h.strategy_tag, isin: h.isin, source: h.source,
})), exp.holdings);

const plan = await loadPlan(nodeFs, paths);
cmp("plan", plan, exp.plan);

cmp("app_settings", redact(await loadAppSettings(nodeFs, paths)), exp.app_settings);
cmp("schedules", await loadSchedules(nodeFs, paths), exp.schedules);

// ------------------------------------------------------------------ database
const dbPath = join(repoRoot, "data", "investraton.db");
if (existsSync(dbPath) && exp.db && exp.db.counts) {
  const raw = new NodeDatabase(dbPath, { readOnly: true }); // never mutate real data
  const store = new Store(raw);

  for (const [table, want] of Object.entries(exp.db.counts as Record<string, number>)) {
    const got = await raw.select<{ c: number }>(`SELECT COUNT(*) c FROM ${table}`);
    cmp(`db.counts.${table}`, got[0].c, want);
  }

  const basis = await store.allValueBasis();
  const gotBasis = Object.entries(basis)
    .map(([ticker, b]) => ({ ticker, basis_price: b.basis_price, basis_amount: b.basis_amount }))
    .sort((a, b) => a.ticker.localeCompare(b.ticker));
  cmp("db.value_tracking", gotBasis, exp.db.value_tracking);

  cmp("db.digests", await store.listDigests(50), exp.db.digests);

  // Row-level reads through the store's own methods.
  for (const r of exp.db.reported_sample as Array<{ dedup_key: string; scope: string }>) {
    cmp(`db.alreadyReported[${r.dedup_key.slice(0, 24)}]`,
        await store.alreadyReported(r.dedup_key, r.scope), true);
  }
  for (const k of exp.db.news_keys as string[]) {
    cmp(`db.hasNews[${k.slice(0, 24)}]`, await store.hasNews(k), true);
  }
  for (const [ticker, want] of Object.entries(exp.db.latest_price as Record<string, any>)) {
    const got = await store.latestPrice(ticker);
    if (want === null) cmp(`db.latestPrice.${ticker}`, got, null);
    else {
      cmp(`db.latestPrice.${ticker}.price`, got?.price, want.price);
      cmp(`db.latestPrice.${ticker}.as_of`, got?.as_of, want.as_of);
      cmp(`db.latestPrice.${ticker}.change_pct_1d`, got?.change_pct_1d ?? null,
          want.change_pct_1d ?? null);
    }
  }
  await raw.close();
} else {
  console.log("(no database at repo path — skipped DB checks)");
}

// ------------------------------------------------------------------ report
console.log(`holdings=${holdings.length} schedules=${(await loadSchedules(nodeFs, paths)).length} ` +
  `db=${exp.db?.counts ? JSON.stringify(exp.db.counts) : "n/a"}`);
console.log(`comparisons: ${checks}`);

if (failures.length) {
  console.error(`\n❌ STORAGE PARITY FAILED — ${failures.length} mismatch(es):`);
  for (const f of failures.slice(0, 25)) console.error("  " + f);
  if (failures.length > 25) console.error(`  ... and ${failures.length - 25} more`);
  process.exit(1);
}
console.log("\n✅ STORAGE PARITY OK — TypeScript reads the same files and database as Python.");
