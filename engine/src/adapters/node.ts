/** Node adapter — used by the parity harness and any CLI use.
 *
 * The Tauri adapter (tauri-plugin-fs / tauri-plugin-sql) implements the same
 * interfaces, so nothing above this file changes between platforms.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { Database, FileSystem, HttpClient, Paths, Row } from "../platform.ts";
import { UA } from "../platform.ts";

/** Node HTTP via global fetch. The Tauri adapter will use tauri-plugin-http,
 * which issues requests natively and therefore bypasses CORS. */
export const nodeHttp: HttpClient = {
  async getText(url, headers = {}) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA, ...headers } });
      if (!r.ok) return null;
      return await r.text();
    } catch {
      return null;
    }
  },
  async getJson<T = unknown>(url: string, headers: Record<string, string> = {}) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA, ...headers } });
      if (!r.ok) return null;
      return (await r.json()) as T;
    } catch {
      return null;
    }
  },
  async postJson<T = unknown>(
    url: string, body: unknown, headers: Record<string, string> = {},
  ) {
    try {
      const r = await fetch(url, {
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
  async post(url: string, body: unknown, headers: Record<string, string> = {}) {
    try {
      const r = await fetch(url, {
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

export const nodeFs: FileSystem = {
  async readText(path) {
    try {
      const buf = await readFile(path, "utf-8");
      return buf.replace(/^﻿/, ""); // strip BOM, matching utf-8-sig
    } catch {
      return null;
    }
  },
  async writeText(path, content) {
    await writeFile(path, content, "utf-8");
  },
  async exists(path) {
    return existsSync(path);
  },
  async mkdirp(path) {
    await mkdir(path, { recursive: true });
  },
  join(...parts) {
    return join(...parts);
  },
};

export class NodeDatabase implements Database {
  private db: DatabaseSync;

  constructor(path: string, opts: { readOnly?: boolean } = {}) {
    this.db = new DatabaseSync(path, { readOnly: opts.readOnly ?? false });
  }

  async select<T = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.db.prepare(sql).all(...(params as any[])) as T[];
  }

  async execute(sql: string, params: unknown[] = []): Promise<void> {
    this.db.prepare(sql).run(...(params as any[]));
  }

  /** Multi-statement DDL (the schema script). */
  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

/** Mirrors config.py: %APPDATA%/Investraton for user data. */
export function nodePaths(repoRoot: string, home?: string): Paths {
  const appData = process.env.APPDATA ?? process.env.HOME ?? ".";
  return {
    home: home ?? process.env.INVESTRATON_HOME ?? join(appData, "Investraton"),
    resource: repoRoot,
  };
}
