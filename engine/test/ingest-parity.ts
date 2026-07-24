/** Stage 3 parity: the TS ingestion parsers vs the Python ones, on identical
 * captured payloads.
 *
 * Live data moves, so this compares PARSE output on real responses snapshotted by
 * make_ingest_fixtures.py rather than comparing live fetches.
 *
 * Run:  python engine/test/make_ingest_fixtures.py   (once, captures fixtures)
 *       npm run ingest-parity
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  dedupKey, parseDate, parseFeed, queryFor, type RssEntry,
} from "../src/ingest/news.ts";
import { parseIsharesCsv } from "../src/ingest/etfHoldings.ts";
import { parseChart } from "../src/ingest/prices.ts";
import type { Subject } from "../src/models.ts";

const FIX = join(import.meta.dirname, "fixtures", "ingest");
const RAW = join(FIX, "raw");

let checks = 0;
const fails: string[] = [];

function eq(path: string, got: unknown, want: unknown): void {
  checks++;
  if (typeof got === "number" && typeof want === "number") {
    const scale = Math.max(Math.abs(got), Math.abs(want), 1);
    if (Math.abs(got - want) <= 1e-9 * scale) return;
  } else if (got === want) {
    return;
  } else if (got === null && want === null) {
    return;
  }
  fails.push(`${path}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
}

const read = (p: string) => readFileSync(p, "utf-8").replace(/^﻿/, "");
const expected = JSON.parse(read(join(FIX, "expected.json")));

// ------------------------------------------------------------------ prices
console.log("prices...");
for (const [ticker, want] of Object.entries<any>(expected.prices ?? {})) {
  const json = JSON.parse(read(join(RAW, `chart_${ticker}.json`)));
  const got = parseChart(ticker, json);
  if (got === null || want === null) {
    eq(`prices.${ticker}`, got, want);
    continue;
  }
  for (const k of ["ticker", "price", "currency", "change_pct_1d", "stale"] as const) {
    eq(`prices.${ticker}.${k}`, got[k], want[k]);
  }
}

// ------------------------------------------------------------------ news queries
console.log("news queries...");
const SUBJECTS: Record<string, Subject> = {
  AAPL: {
    name: "Apple Inc.", ticker: "AAPL", owned: true, weight: 0.1,
    strategy_tag: "", type: "equity",
  },
  "ARTIFICIAL INTELLIGENCE": {
    name: "artificial intelligence", ticker: "", owned: false, weight: 0,
    strategy_tag: "", type: "theme",
  },
};
for (const [key, want] of Object.entries<any>(expected.news?.queries ?? {})) {
  const subj = SUBJECTS[key];
  if (!subj) { fails.push(`news.queries.${key}: no TS subject defined`); continue; }
  eq(`news.queries.${key}.plain`, queryFor(subj, null), want.plain);
  eq(`news.queries.${key}.site`, queryFor(subj, "ft.com"), want.site);
}

// ------------------------------------------------------------------ RSS parsing
console.log("rss entries...");

/** feedparser sanitises HTML in `summary`; fast-xml-parser returns it raw. The
 * stored summary is never rendered as markup by either engine, so compare the
 * visible text: tags stripped, entities normalised, whitespace collapsed. */
const plainText = (s: string) =>
  s.replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

for (const [fname, wantEntries] of Object.entries<any[]>(expected.news?.feeds ?? {})) {
  const got: RssEntry[] = parseFeed(read(join(RAW, fname)));
  eq(`news.feeds.${fname}.count`, got.length, wantEntries.length);
  const n = Math.min(got.length, wantEntries.length);
  for (let i = 0; i < n; i++) {
    const g = got[i], w = wantEntries[i];
    eq(`news.feeds.${fname}[${i}].title`, g.title, w.title);
    eq(`news.feeds.${fname}[${i}].link`, g.link, w.link);
    eq(`news.feeds.${fname}[${i}].source`, g.source, w.source);
    // Compare the instant, not the string: RFC-822 vs ISO are both exact here.
    eq(
      `news.feeds.${fname}[${i}].published`,
      parseDate(g.published),
      w.published === null ? null : Date.parse(w.published),
    );
    eq(
      `news.feeds.${fname}[${i}].summary`,
      plainText(g.summary).slice(0, 300),
      plainText(w.summary).slice(0, 300),
    );
    // dedup_key drives the whole "have we shown this?" contract — it must match
    // Python's exactly or the Android app would re-report everything once.
    eq(
      `news.feeds.${fname}[${i}].dedup_key`,
      dedupKey({ url: g.link, title: g.title }),
      (w.link || w.title).trim().toLowerCase(),
    );
  }
}

// ------------------------------------------------------------------ etf holdings
console.log("etf holdings...");
for (const [pid, want] of Object.entries<any>(expected.etf ?? {})) {
  const got = parseIsharesCsv(pid, read(join(RAW, `ishares_${pid}.csv`)));
  if (got === null) { fails.push(`etf.${pid}: TS parse returned null`); checks++; continue; }
  for (const k of ["ticker", "name", "as_of", "source"] as const) {
    eq(`etf.${pid}.${k}`, got[k], want[k]);
  }
  eq(`etf.${pid}.count`, got.constituents.length, want.constituents.length);
  const n = Math.min(got.constituents.length, want.constituents.length);
  for (let i = 0; i < n; i++) {
    const g = got.constituents[i], w = want.constituents[i];
    for (const k of ["ticker", "name", "weight", "sector", "country", "asset_class"] as const) {
      eq(`etf.${pid}.constituents[${i}].${k}`, g[k], w[k]);
    }
  }
  // Weights must still sum the same, or look-through percentages would drift.
  const sum = got.constituents.reduce((a, c) => a + c.weight, 0);
  const wantSum = want.constituents.reduce((a: number, c: any) => a + c.weight, 0);
  eq(`etf.${pid}.weight_sum`, sum, wantSum);
}

// ------------------------------------------------------------------ report
console.log(`\n${checks} comparisons, ${fails.length} mismatches`);
if (fails.length) {
  for (const f of fails.slice(0, 40)) console.log("  FAIL " + f);
  if (fails.length > 40) console.log(`  ... and ${fails.length - 40} more`);
  process.exit(1);
}
console.log("Stage 3 ingestion parity: OK");
