/** Price ingestion — port of ingest/prices.py.
 *
 * Python leans on `yfinance`; here we call the endpoint yfinance itself wraps
 * (Yahoo's chart API) and reproduce the same derivation: last close, previous
 * close for the 1-day change, and the quote currency. Verified against
 * yfinance output — identical closes, price and change for the same symbol.
 *
 * On failure we fall back to the last stored price and mark it stale, so the
 * digest can say so honestly rather than silently using old numbers.
 */

import type { PriceSnapshot } from "../models.ts";
import type { HttpClient } from "../platform.ts";
import { pyRound } from "../round.ts";
import type { Store } from "../store/db.ts";

const CHART = "https://query1.finance.yahoo.com/v8/finance/chart/";

interface ChartResponse {
  chart?: {
    result?: Array<{
      meta?: { currency?: string; symbol?: string };
      indicators?: { quote?: Array<{ close?: Array<number | null> }> };
    }>;
  };
}

/** Parse a Yahoo chart payload the same way ingest/prices.py derives its values. */
export function parseChart(ticker: string, json: unknown): PriceSnapshot | null {
  const res = (json as ChartResponse)?.chart?.result?.[0];
  if (!res) return null;
  const raw = res.indicators?.quote?.[0]?.close ?? [];
  const closes = raw.filter((v): v is number => v !== null && v !== undefined && Number.isFinite(v));
  if (closes.length === 0) return null;
  const price = closes[closes.length - 1];
  let change: number | null = null;
  if (closes.length >= 2) {
    const prev = closes[closes.length - 2];
    if (prev) change = pyRound(((price - prev) / prev) * 100, 2);
  }
  return {
    ticker: ticker.toUpperCase(),
    price: pyRound(price, 4),
    currency: res.meta?.currency ?? "",
    change_pct_1d: change,
    stale: false,
  };
}

async function fetchOne(http: HttpClient, ticker: string): Promise<PriceSnapshot | null> {
  const url = `${CHART}${encodeURIComponent(ticker)}?range=5d&interval=1d`;
  const json = await http.getJson(url);
  if (!json) return null;
  return parseChart(ticker, json);
}

/** Live fetch with per-ticker fallback to the cached price (marked stale). */
export async function fetchPrices(
  tickers: string[], http: HttpClient, store: Store,
): Promise<Record<string, PriceSnapshot>> {
  const out: Record<string, PriceSnapshot> = {};
  for (const ticker of tickers) {
    const snap = await fetchOne(http, ticker);
    if (snap === null) {
      const cached = await cachedPrice(ticker, store);
      if (cached) out[ticker.toUpperCase()] = cached;
      continue;
    }
    await store.savePrice({
      ticker: snap.ticker, price: snap.price, currency: snap.currency,
      change_pct_1d: snap.change_pct_1d, as_of: new Date().toISOString(),
    });
    out[ticker.toUpperCase()] = snap;
  }
  return out;
}

async function cachedPrice(ticker: string, store: Store): Promise<PriceSnapshot | null> {
  const row = await store.latestPrice(ticker);
  if (!row) return null;
  return {
    ticker: row.ticker, price: row.price, currency: row.currency ?? "",
    change_pct_1d: row.change_pct_1d, stale: true, // came from cache
  };
}

/** Last-known prices only, no network — the fast path for the UI. */
export async function cachedPrices(
  tickers: string[], store: Store,
): Promise<Record<string, PriceSnapshot>> {
  const out: Record<string, PriceSnapshot> = {};
  for (const t of tickers) {
    const c = await cachedPrice(t, store);
    if (c) out[t.toUpperCase()] = c;
  }
  return out;
}
