/** Stage 5 parity: app/service.ts vs api.py, endpoint by endpoint, on one shared
 * on-disk HOME (holdings, plan, settings-with-secrets, schedules, a populated DB,
 * a fresh ETF cache). This is the contract-level proof that service.ts can replace
 * api.py before Python retires.
 *
 * Everything is local/deterministic — prices come from the seeded DB, the ETF
 * composition from a fresh cache file — so neither engine touches the network.
 *
 * Run:  python engine/test/make_service_fixtures.py
 *       npm run service-parity
 */

import { cpSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { NodeDatabase, nodeFs, nodeHttp } from "../src/adapters/node.ts";
import type { DeliverContext } from "../src/deliver.ts";
import type { AppContext } from "../src/app/service.ts";
import {
  getHistory, getHistoryItem, getHoldings, getPlan, getSchedules, getSettings,
  getSources, getStatus, getStructure, putSettings,
} from "../src/app/service.ts";
import { handle } from "../src/app/router.ts";
import type { Paths } from "../src/platform.ts";
import { Store } from "../src/store/db.ts";
import { loadAppSettings } from "../src/store/files.ts";

const FIX = join(import.meta.dirname, "fixtures", "service");
const HOME = join(FIX, "home");
const EXPECTED = join(FIX, "expected");

const read = (p: string) => readFileSync(p, "utf-8").replace(/^﻿/, "");
const readJson = (p: string) => JSON.parse(read(p));
const expect = (name: string) => readJson(join(EXPECTED, `${name}.json`));
const meta = readJson(join(EXPECTED, "meta.json"));

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
    if (ga.length !== wa.length) fails.push(`${path}.length: got ${ga.length} want ${wa.length}`);
    for (let i = 0; i < Math.min(ga.length, wa.length); i++) compare(`${path}[${i}]`, ga[i], wa[i]);
    return;
  }
  if (want && typeof want === "object") {
    const wo = want as Record<string, unknown>, go = (got ?? {}) as Record<string, unknown>;
    for (const k of new Set([...Object.keys(wo), ...Object.keys(go)])) {
      compare(`${path}.${k}`, go[k], wo[k]);
    }
    return;
  }
  if (got !== want) fails.push(`${path}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
}

/** Compare only the listed keys (for responses with a non-deterministic field). */
function compareKeys(name: string, got: Record<string, unknown>, keys: string[]): void {
  const want = expect(name) as Record<string, unknown>;
  for (const k of keys) compare(`${name}.${k}`, got[k], want[k]);
}

// ------------------------------------------------------------------ run
async function main(): Promise<void> {
  const paths: Paths = { home: HOME, resource: HOME };
  const db = new NodeDatabase(join(HOME, "data", "investraton.db"), { readOnly: true });
  const store = new Store(db); // no init(): Python already created every table
  const noDeliver: DeliverContext = { http: nodeHttp, consoleSink: () => {} };
  const ctx: AppContext = {
    fs: nodeFs, http: nodeHttp, paths, store, deliver: noDeliver,
    now: () => new Date(meta.now_ms),
  };

  // status: 'now' is a timestamp, and 'deps' differs by design (Python libs vs the
  // TS fetch stack), so compare the stable, meaningful fields only.
  compareKeys("status", await getStatus(ctx),
    ["version", "llm_provider", "delivery", "holdings_count", "sources"]);

  compare("holdings", await getHoldings(ctx), expect("holdings"));
  compare("plan", await getPlan(ctx), expect("plan"));
  compare("settings", await getSettings(ctx), expect("settings"));
  compare("sources", await getSources(ctx), expect("sources"));
  compare("schedules", await getSchedules(ctx), expect("schedules"));
  compare("structure", await getStructure(ctx), expect("structure"));
  compare("history", await getHistory(ctx), expect("history"));
  compare("history_item", await getHistoryItem(ctx, meta.history_first_id), expect("history_item"));

  // The router must dispatch the same result the service returns directly, and map
  // errors to the FastAPI status codes the UI expects.
  const rHoldings = await handle(ctx, "GET", "/api/holdings");
  compare("router.holdings.status", rHoldings.status, 200);
  compare("router.holdings.body", rHoldings.body, expect("holdings"));
  const rItem = await handle(ctx, "GET", `/api/history/${meta.history_first_id}`);
  compare("router.history_item.body", rItem.body, expect("history_item"));
  const rStruct = await handle(ctx, "GET", "/api/structure");
  compare("router.structure.body", rStruct.body, expect("structure"));
  compare("router.unknown.status", (await handle(ctx, "GET", "/api/nope")).status, 404);
  compare("router.badurl.status", (await handle(ctx, "GET", "/api/open?url=ftp://x")).status, 400);
  compare("router.openok.status", (await handle(ctx, "GET", "/api/open?url=https%3A%2F%2Fx.com")).status, 200);

  await db.close();

  // putSettings merge/mask — run on a throwaway copy so the shared HOME stays
  // pristine, then compare the resulting app_settings.json to Python's.
  const putHome = join(FIX, "home_put_ts");
  rmSync(putHome, { recursive: true, force: true });
  cpSync(HOME, putHome, { recursive: true });
  const putDb = new NodeDatabase(join(putHome, "data", "investraton.db"));
  const putCtx: AppContext = {
    ...ctx, paths: { home: putHome, resource: putHome }, store: new Store(putDb),
  };
  await putSettings(putCtx, {
    llm_provider: "claude",
    anthropic_api_key: "********",
    smtp: { host: "smtp.gmail.com", port: 587, user: "me@gmail.com",
            password: "", from: "me@gmail.com", to: "me@gmail.com" },
  });
  await putDb.close();
  compare("after_put_settings",
    await loadAppSettings(nodeFs, { home: putHome, resource: putHome }),
    expect("after_put_settings"));
  rmSync(putHome, { recursive: true, force: true });

  // ------------------------------------------------------------------ report
  console.log(`${checks} comparisons, ${fails.length} mismatches`);
  if (fails.length) {
    for (const f of fails.slice(0, 40)) console.log("  FAIL " + f);
    if (fails.length > 40) console.log(`  ... and ${fails.length - 40} more`);
    process.exit(1);
  }
  console.log("Stage 5 service parity: OK — service.ts matches api.py on identical data.");
}

main().catch((e) => { console.error(e); process.exit(1); });
