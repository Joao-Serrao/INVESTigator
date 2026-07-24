/** Stage 4 parity: the TS runDigest vs Python run_digest, end to end.
 *
 * Reads the same input fixtures as make_pipeline_fixtures.py, injects the same
 * stubbed ingestion, runs runDigest for every scenario, and asserts serializeDigest
 * equals the captured Python output. Numbers compare with a relative epsilon;
 * everything else (including the whole narrative string) compares exactly.
 *
 * Run:  python engine/test/make_pipeline_fixtures.py   (once, captures expected)
 *       npm run pipeline-parity
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { NodeDatabase, nodeFs } from "../src/adapters/node.ts";
import { TemplateLlm } from "../src/brain/llm.ts";
import type { DeliverContext } from "../src/deliver.ts";
import type { ETFComposition, NewsItem, PriceSnapshot, Subject } from "../src/models.ts";
import { subjectKey } from "../src/models.ts";
import { runDigest, serializeDigest, type IngestFns } from "../src/pipeline.ts";
import type { HttpClient, Paths } from "../src/platform.ts";
import { Store } from "../src/store/db.ts";

const FIX = join(import.meta.dirname, "fixtures", "pipeline");
const INPUT = join(FIX, "input");
const EXPECTED = join(FIX, "expected");
const HOME = join(FIX, "tshome");

const read = (p: string) => readFileSync(p, "utf-8").replace(/^﻿/, "");
const readJson = (p: string) => JSON.parse(read(p));

const PRICES: Record<string, any> = readJson(join(INPUT, "prices.json"));
const NEWS: Record<string, any[]> = readJson(join(INPUT, "news.json"));
const COMP: Record<string, any> = readJson(join(INPUT, "composition.json"));
const SCEN = readJson(join(INPUT, "scenarios.json"));
const HOLDINGS_CSV = read(join(INPUT, "holdings.csv"));
const PLAN_YAML = read(join(INPUT, "portfolio_plan.yaml"));

// Same fixed instant the Python fixtures used (ms precision -> .123000 microseconds).
const GENERATED_AT = new Date(SCEN.generated_at_ms);

const ingest: IngestFns = {
  async fetchPrices(tickers) {
    const out: Record<string, PriceSnapshot> = {};
    for (const t of tickers) {
      const d = PRICES[t.toUpperCase()];
      if (d) {
        out[t.toUpperCase()] = {
          ticker: t.toUpperCase(), price: d.price, currency: d.currency ?? "",
          change_pct_1d: d.change_pct_1d ?? null, stale: d.stale ?? false,
        };
      }
    }
    return out;
  },
  async fetchNews(subjects: Subject[]) {
    const out: Record<string, NewsItem[]> = {};
    for (const s of subjects) {
      const key = subjectKey(s);
      out[key] = (NEWS[key] ?? []).map((i) => ({
        ticker: key, title: i.title, url: i.url ?? "", source: i.source ?? "", summary: i.summary ?? "",
      }));
    }
    return out;
  },
  async getComposition(ticker) {
    const base = ticker.toUpperCase().split(".")[0];
    const d = COMP[base];
    if (!d) return null;
    const comp: ETFComposition = {
      ticker: base, name: d.name, as_of: d.as_of, source: "ishares", stale: false,
      constituents: d.constituents.map((c: any) => ({
        ticker: c.ticker, name: c.name, weight: c.weight,
        sector: c.sector ?? "", country: c.country ?? "", asset_class: c.asset_class ?? "Equity",
      })),
    };
    return comp;
  },
};

// http/deliver are never exercised (ingestion stubbed, deliverOutput=false).
const noHttp: HttpClient = {
  async getText() { return null; },
  async getJson() { return null; },
  async postJson() { return null; },
  async post() { return { ok: false, status: 0, text: "" }; },
};
const noDeliver: DeliverContext = { http: noHttp, consoleSink: () => {} };

function resetHome(): Paths {
  rmSync(HOME, { recursive: true, force: true });
  mkdirSync(join(HOME, "data"), { recursive: true });
  mkdirSync(join(HOME, "config"), { recursive: true });
  writeFileSync(join(HOME, "data", "holdings.csv"), HOLDINGS_CSV);
  writeFileSync(join(HOME, "config", "portfolio_plan.yaml"), PLAN_YAML);
  return { home: HOME, resource: INPUT };
}

// ------------------------------------------------------------------ compare
let checks = 0;
const fails: string[] = [];

function compare(path: string, got: unknown, want: unknown): void {
  checks++;
  if (typeof want === "number" || typeof got === "number") {
    const g = Number(got), w = Number(want);
    const scale = Math.max(Math.abs(g), Math.abs(w), 1);
    if (!(Math.abs(g - w) <= 1e-9 * scale)) {
      fails.push(`${path}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
    }
    return;
  }
  if (Array.isArray(want) || Array.isArray(got)) {
    const ga = (got ?? []) as unknown[], wa = (want ?? []) as unknown[];
    if (ga.length !== wa.length) {
      fails.push(`${path}.length: got ${ga.length} want ${wa.length}`);
    }
    const n = Math.min(ga.length, wa.length);
    for (let i = 0; i < n; i++) compare(`${path}[${i}]`, ga[i], wa[i]);
    return;
  }
  if (want && typeof want === "object") {
    const wo = want as Record<string, unknown>, go = (got ?? {}) as Record<string, unknown>;
    const keys = new Set([...Object.keys(wo), ...Object.keys(go)]);
    for (const k of keys) compare(`${path}.${k}`, go[k], wo[k]);
    return;
  }
  if (got !== want) fails.push(`${path}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
}

// ------------------------------------------------------------------ run
async function main(): Promise<void> {
  for (const sc of SCEN.scenarios as any[]) {
    const paths = resetHome();
    const db = new NodeDatabase(join(HOME, "data", "investraton.db"));
    const store = new Store(db);
    await store.init();
    try {
      const digest = await runDigest(
        {
          store, fs: nodeFs, http: noHttp, paths,
          settings: {
            llm_provider: "template", ollama_host: "", ollama_model: "",
            anthropic_api_key: "", anthropic_model: "", delivery: ["console"],
            discord_webhook_url: "", smtp: { host: "", port: 587, user: "", password: "", from: "", to: "" },
          },
          llm: new TemplateLlm(), deliver: noDeliver,
          now: () => GENERATED_AT, ingest,
        },
        {
          period: sc.period, deliverOutput: false, focus: sc.focus, complexity: sc.complexity,
        },
      );
      const got = serializeDigest(digest);
      const want = readJson(join(EXPECTED, `${sc.name}.json`));
      compare(sc.name, got, want);
      console.log(
        `  ${sc.name.padEnd(16)} events=${got.events.length} ` +
        `watch=${got.watchlist.length} structure=${got.structure.length}`,
      );
    } finally {
      await db.close();
    }
  }
  rmSync(HOME, { recursive: true, force: true });

  console.log(`\n${checks} comparisons, ${fails.length} mismatches`);
  if (fails.length) {
    for (const f of fails.slice(0, 40)) console.log("  FAIL " + f);
    if (fails.length > 40) console.log(`  ... and ${fails.length - 40} more`);
    process.exit(1);
  }
  console.log("Stage 4 pipeline parity: OK");
}

main().catch((e) => { console.error(e); process.exit(1); });
