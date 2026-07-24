/** SQLite store — the SAME schema and file as the Python engine (store.py).
 *
 * Nothing here creates a new database or renames a column: the TS engine opens
 * the user's existing investraton.db so history, dedup state and the value-tracking
 * basis all carry over with no migration.
 */

import type { Database } from "../platform.ts";

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS prices (
    ticker TEXT NOT NULL,
    price REAL NOT NULL,
    currency TEXT,
    change_pct_1d REAL,
    as_of TEXT NOT NULL,
    PRIMARY KEY (ticker, as_of)
);

CREATE TABLE IF NOT EXISTS news (
    dedup_key TEXT PRIMARY KEY,
    ticker TEXT NOT NULL,
    title TEXT NOT NULL,
    url TEXT,
    source TEXT,
    published TEXT,
    summary TEXT,
    first_seen TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reported_events (
    dedup_key TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT 'all',
    ticker TEXT,
    kind TEXT,
    reported_at TEXT NOT NULL,
    PRIMARY KEY (dedup_key, scope)
);

CREATE TABLE IF NOT EXISTS value_tracking (
    ticker TEXT PRIMARY KEY,
    basis_price REAL NOT NULL,
    basis_amount REAL NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS digests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    period TEXT,
    focus TEXT,
    complexity TEXT,
    events_count INTEGER,
    watch_count INTEGER,
    payload TEXT NOT NULL
);
`;

const nowIso = () => new Date().toISOString();

export interface ValueBasisRow { basis_price: number; basis_amount: number }
export interface DigestRow {
  id: number; created_at: string; period: string; focus: string;
  complexity: string; events_count: number; watch_count: number;
}
export interface PriceRow {
  ticker: string; price: number; currency: string;
  change_pct_1d: number | null; as_of: string;
}

export class Store {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /** Create tables if missing, and migrate a pre-`scope` reported_events table. */
  async init(): Promise<void> {
    const cols = await this.db.select<{ name: string }>("PRAGMA table_info(reported_events)");
    if (cols.length && !cols.some((c) => c.name === "scope")) {
      // Dedup state is regenerable, so dropping is safe (matches Store._migrate).
      await this.db.execute("DROP TABLE reported_events");
    }
    for (const stmt of SCHEMA.split(";").map((s) => s.trim()).filter(Boolean)) {
      await this.db.execute(stmt);
    }
  }

  // ---- prices ----
  async savePrice(p: PriceRow): Promise<void> {
    await this.db.execute(
      "INSERT OR REPLACE INTO prices(ticker, price, currency, change_pct_1d, as_of) VALUES (?,?,?,?,?)",
      [p.ticker.toUpperCase(), p.price, p.currency, p.change_pct_1d, p.as_of],
    );
  }

  async latestPrice(ticker: string): Promise<PriceRow | null> {
    const rows = await this.db.select<PriceRow>(
      "SELECT * FROM prices WHERE ticker=? ORDER BY as_of DESC LIMIT 1", [ticker.toUpperCase()],
    );
    return rows[0] ?? null;
  }

  // ---- news (dedup) ----
  /** Returns true only the first time this item is seen. */
  async saveNews(item: {
    dedup_key: string; ticker: string; title: string; url: string;
    source: string; published: string | null; summary: string;
  }): Promise<boolean> {
    const before = await this.db.select<{ c: number }>(
      "SELECT COUNT(*) c FROM news WHERE dedup_key=?", [item.dedup_key],
    );
    if ((before[0]?.c ?? 0) > 0) return false;
    await this.db.execute(
      "INSERT OR IGNORE INTO news(dedup_key, ticker, title, url, source, published, summary, first_seen)" +
      " VALUES (?,?,?,?,?,?,?,?)",
      [item.dedup_key, item.ticker.toUpperCase(), item.title, item.url,
       item.source, item.published, item.summary, nowIso()],
    );
    return true;
  }

  async hasNews(dedupKey: string): Promise<boolean> {
    const r = await this.db.select("SELECT 1 FROM news WHERE dedup_key=?", [dedupKey]);
    return r.length > 0;
  }

  // ---- dedup state (per tier/scope) ----
  async alreadyReported(dedupKey: string, scope = "all"): Promise<boolean> {
    const r = await this.db.select(
      "SELECT 1 FROM reported_events WHERE dedup_key=? AND scope=?", [dedupKey, scope],
    );
    return r.length > 0;
  }

  async markReported(dedupKey: string, ticker: string, kind: string, scope = "all"): Promise<void> {
    await this.db.execute(
      "INSERT OR REPLACE INTO reported_events(dedup_key, scope, ticker, kind, reported_at)" +
      " VALUES (?,?,?,?,?)",
      [dedupKey, scope, ticker.toUpperCase(), kind, nowIso()],
    );
  }

  // ---- value tracking ----
  async getValueBasis(ticker: string): Promise<ValueBasisRow | null> {
    const rows = await this.db.select<ValueBasisRow>(
      "SELECT basis_price, basis_amount FROM value_tracking WHERE ticker=?", [ticker.toUpperCase()],
    );
    return rows[0] ?? null;
  }

  async allValueBasis(): Promise<Record<string, ValueBasisRow>> {
    const rows = await this.db.select<{ ticker: string } & ValueBasisRow>(
      "SELECT ticker, basis_price, basis_amount FROM value_tracking",
    );
    const out: Record<string, ValueBasisRow> = {};
    for (const r of rows) out[r.ticker] = { basis_price: r.basis_price, basis_amount: r.basis_amount };
    return out;
  }

  async setValueBasis(ticker: string, price: number, amount: number): Promise<void> {
    await this.db.execute(
      "INSERT OR REPLACE INTO value_tracking(ticker, basis_price, basis_amount, updated_at)" +
      " VALUES (?,?,?,?)",
      [ticker.toUpperCase(), price, amount, nowIso()],
    );
  }

  // ---- digest history ----
  async saveDigest(meta: {
    period: string; focus: string; complexity: string;
    events_count: number; watch_count: number;
  }, payloadJson: string): Promise<void> {
    await this.db.execute(
      "INSERT INTO digests(created_at, period, focus, complexity, events_count, watch_count, payload)" +
      " VALUES (?,?,?,?,?,?,?)",
      [nowIso(), meta.period, meta.focus, meta.complexity,
       meta.events_count, meta.watch_count, payloadJson],
    );
    await this.db.execute(
      "DELETE FROM digests WHERE id NOT IN (SELECT id FROM digests ORDER BY id DESC LIMIT 200)",
    );
  }

  async listDigests(limit = 50): Promise<DigestRow[]> {
    return this.db.select<DigestRow>(
      "SELECT id, created_at, period, focus, complexity, events_count, watch_count" +
      " FROM digests ORDER BY id DESC LIMIT ?", [limit],
    );
  }

  async getDigest(id: number): Promise<string | null> {
    const rows = await this.db.select<{ payload: string }>(
      "SELECT payload FROM digests WHERE id=?", [id],
    );
    return rows[0]?.payload ?? null;
  }
}
