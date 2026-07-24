/** Tauri adapter — implements the engine's platform interfaces using Tauri's
 * plugins, so the SAME engine that the Node parity harness exercises runs inside
 * the desktop (and later Android) WebView with no code changes above this file.
 *
 *   FileSystem -> @tauri-apps/plugin-fs
 *   Database   -> @tauri-apps/plugin-sql   (SQLite, native — same schema/file)
 *   HttpClient -> @tauri-apps/plugin-http  (native requests, so NO CORS wall)
 *
 * The one deliberate divergence from the interface: FileSystem.join is synchronous
 * (Node's is), but Tauri's path.join is async — so we join manually. Rust's path
 * handling normalises mixed separators on Windows, so "/" joins are safe.
 */

import { exists, mkdir, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { openUrl as openInBrowser } from "@tauri-apps/plugin-opener";
import { appDataDir, resourceDir } from "@tauri-apps/api/path";
import Database from "@tauri-apps/plugin-sql";

import type {
  Database as EngineDb, FileSystem, HttpClient, HttpResponse, Paths, Row,
} from "@investigator/engine/platform";
import { UA } from "@investigator/engine/platform";

export const tauriFs: FileSystem = {
  async readText(path) {
    try {
      return (await readTextFile(path)).replace(/^﻿/, ""); // strip BOM
    } catch {
      return null;
    }
  },
  async writeText(path, content) {
    await writeTextFile(path, content);
  },
  async exists(path) {
    return exists(path);
  },
  async mkdirp(path) {
    await mkdir(path, { recursive: true });
  },
  join(...parts) {
    return parts
      .filter(Boolean)
      .map((p, i) => (i === 0 ? p.replace(/[\\/]+$/, "") : p.replace(/^[\\/]+/, "").replace(/[\\/]+$/, "")))
      .join("/");
  },
};

export const tauriHttp: HttpClient = {
  async getText(url, headers = {}) {
    try {
      const r = await tauriFetch(url, { headers: { "User-Agent": UA, ...headers } });
      if (!r.ok) return null;
      return await r.text();
    } catch {
      return null;
    }
  },
  async getJson<T = unknown>(url: string, headers: Record<string, string> = {}) {
    try {
      const r = await tauriFetch(url, { headers: { "User-Agent": UA, ...headers } });
      if (!r.ok) return null;
      return (await r.json()) as T;
    } catch {
      return null;
    }
  },
  async postJson<T = unknown>(url: string, body: unknown, headers: Record<string, string> = {}) {
    try {
      const r = await tauriFetch(url, {
        method: "POST",
        headers: { "User-Agent": UA, "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
      if (!r.ok) return null;
      return (await r.json()) as T;
    } catch {
      return null;
    }
  },
  async post(url: string, body: unknown, headers: Record<string, string> = {}): Promise<HttpResponse> {
    try {
      const r = await tauriFetch(url, {
        method: "POST",
        headers: { "User-Agent": UA, "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
      return { ok: r.ok, status: r.status, text: await r.text() };
    } catch (e) {
      return { ok: false, status: 0, text: String(e) };
    }
  },
};

/** Wraps a Tauri SQL Database in the engine's minimal Database interface. */
class TauriDatabase implements EngineDb {
  private db: Database;
  constructor(db: Database) {
    this.db = db;
  }
  async select<T = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.db.select<T[]>(sql, params);
  }
  async execute(sql: string, params: unknown[] = []): Promise<void> {
    await this.db.execute(sql, params);
  }
  async close(): Promise<void> {
    await this.db.close();
  }
}

export interface TauriPlatform {
  fs: FileSystem;
  http: HttpClient;
  db: EngineDb;
  paths: Paths;
  openUrl: (url: string) => Promise<void>;
}

/** Resolve paths, open the SQLite database (creating the file if absent), and
 * return the platform bundle the engine's AppContext needs. */
export async function makeTauriPlatform(): Promise<TauriPlatform> {
  const home = tauriFs.join(await appDataDir(), "Investraton");
  const resource = await resourceDir();
  await tauriFs.mkdirp(tauriFs.join(home, "data"));
  await tauriFs.mkdirp(tauriFs.join(home, "config"));
  const dbFile = tauriFs.join(home, "data", "investraton.db");
  const db = await Database.load(`sqlite:${dbFile}`);
  return {
    fs: tauriFs,
    http: tauriHttp,
    db: new TauriDatabase(db),
    paths: { home, resource },
    openUrl: (url) => openInBrowser(url),
  };
}
