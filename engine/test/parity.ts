/** Parity harness: run the TypeScript engine over the same fixtures the Python
 * engine produced, and assert the outputs match.
 *
 * Strings (findings/events) are compared EXACTLY — they embed formatted numbers,
 * so this also validates the number formatting. Floats use a tight relative
 * epsilon to tolerate summation-order noise over thousands of constituents.
 *
 * Run:  npm run parity     (from engine/)
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ETFComposition, Holding, NewsItem, Plan, PriceSnapshot, Subject } from "../src/models.ts";
import { computeLookthrough } from "../src/lookthrough.ts";
import { analyseConcentration } from "../src/concentration.ts";
import { analysePlan } from "../src/planAlign.ts";
import { buildSubjects, getComplexity } from "../src/scoping.ts";
import { newsEvent, priceEvent, watchlistEvent } from "../src/urgency.ts";
import { applyCurrentValues, type BasisMap } from "../src/valuation.ts";
import { computeWeights } from "../src/weights.ts";

const here = dirname(fileURLToPath(import.meta.url));
const load = (n: string) => JSON.parse(readFileSync(join(here, "fixtures", n), "utf-8"));

const fx = load("fixtures.json");
const exp = load("expected.json");

const EPS = 1e-9;
let failures: string[] = [];
let checks = 0;

function near(a: number, b: number): boolean {
  if (Number.isNaN(a) && Number.isNaN(b)) return true;
  const diff = Math.abs(a - b);
  return diff <= EPS || diff <= EPS * Math.max(Math.abs(a), Math.abs(b));
}

function cmp(path: string, got: unknown, want: unknown): void {
  checks++;
  if (typeof want === "number" && typeof got === "number") {
    if (!near(got, want)) failures.push(`${path}: got ${got} want ${want}`);
    return;
  }
  if (Array.isArray(want)) {
    if (!Array.isArray(got)) { failures.push(`${path}: got non-array`); return; }
    if (got.length !== want.length) {
      failures.push(`${path}: length ${got.length} != ${want.length}`); return;
    }
    for (let i = 0; i < want.length; i++) cmp(`${path}[${i}]`, got[i], want[i]);
    return;
  }
  if (want && typeof want === "object") {
    if (!got || typeof got !== "object") { failures.push(`${path}: got non-object`); return; }
    for (const k of Object.keys(want as object)) {
      cmp(`${path}.${k}`, (got as any)[k], (want as any)[k]);
    }
    return;
  }
  if (got !== want) failures.push(`${path}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
}

// ---------------------------------------------------------------- inputs
const plan: Plan = fx.plan;
const compositions: Record<string, ETFComposition> = fx.compositions;
const getComp = (ticker: string, _isin: string): ETFComposition | null =>
  compositions[ticker.toUpperCase()] ?? null;

// Fresh holdings (derived fields cleared) so we recompute rather than trust the fixture.
const holdings: Holding[] = (fx.holdings as Holding[]).map((h) => ({
  ...h, portfolio_weight: 0, current_value: 0,
}));

// ---------------------------------------------------------------- valuation + weights
const prices: Record<string, PriceSnapshot> = fx.valuation.prices;
const basis: BasisMap = fx.valuation.basis;
applyCurrentValues(holdings, prices, basis);
const w = computeWeights(holdings);

cmp("weights.total_eur", w.total_eur, exp.weights.total_eur);
cmp("weights.amounts_given", w.amounts_given, exp.weights.amounts_given);
for (let i = 0; i < holdings.length; i++) {
  cmp(`weights.holdings[${i}].current_value`, holdings[i].current_value,
      exp.weights.holdings[i].current_value);
  cmp(`weights.holdings[${i}].portfolio_weight`, holdings[i].portfolio_weight,
      exp.weights.holdings[i].portfolio_weight);
}

// ---------------------------------------------------------------- look-through
const lt = computeLookthrough(holdings, getComp);
cmp("lookthrough.coverage", lt.coverage, exp.lookthrough.coverage);
cmp("lookthrough.by_name", lt.by_name, exp.lookthrough.by_name);
cmp("lookthrough.by_sector", lt.by_sector, exp.lookthrough.by_sector);
cmp("lookthrough.by_country", lt.by_country, exp.lookthrough.by_country);
cmp("lookthrough.by_region", lt.by_region, exp.lookthrough.by_region);
cmp("lookthrough.opaque", lt.opaque, exp.lookthrough.opaque);
cmp("lookthrough.as_of", lt.as_of, exp.lookthrough.as_of);

// ---------------------------------------------------------------- findings
const findings = [...analyseConcentration(lt), ...analysePlan(holdings, plan)];
cmp("findings", findings, exp.findings);

// ---------------------------------------------------------------- scoping
for (const f of fx.focuses as string[]) {
  cmp(`subjects[${f}]`, buildSubjects(holdings, plan.watchlist, f), exp.subjects[f]);
}
for (const name of Object.keys(exp.complexities)) {
  cmp(`complexity[${name}]`, getComplexity(name, plan.thresholds.min_urgency_to_report),
      exp.complexities[name]);
}

// ---------------------------------------------------------------- events
const byKey: Record<string, Holding> = {};
for (const h of holdings) byKey[h.ticker.toUpperCase()] = h;

const gotPrice = (fx.price_inputs as any[]).map((p) =>
  priceEvent(byKey[p.holding], p.snap as PriceSnapshot, plan));
cmp("price_events", gotPrice, exp.price_events);

const gotNews = (fx.news_inputs as any[]).map((n) =>
  newsEvent(byKey[n.holding], n.item as NewsItem, plan));
cmp("news_events", gotNews, exp.news_events);

const gotWatch = (fx.watchlist_inputs as any[]).map((wi) =>
  watchlistEvent(wi.subject as Subject, wi.item as NewsItem, plan));
cmp("watchlist_events", gotWatch, exp.watchlist_events);

// ---------------------------------------------------------------- report
const constituents = Object.values(compositions)
  .reduce((a, c) => a + c.constituents.length, 0);
console.log(`fixtures: ${holdings.length} holdings, ${Object.keys(compositions).length} ETFs, ` +
  `${constituents} constituents, ${lt.by_name.length} name exposures`);
console.log(`comparisons: ${checks}`);

if (failures.length) {
  console.error(`\n❌ PARITY FAILED — ${failures.length} mismatch(es):`);
  for (const f of failures.slice(0, 25)) console.error("  " + f);
  if (failures.length > 25) console.error(`  ... and ${failures.length - 25} more`);
  process.exit(1);
}
console.log("\n✅ PARITY OK — TypeScript engine matches Python exactly.");
