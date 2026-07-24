/** Platform abstraction so the engine runs unchanged on Node (for the parity
 * harness) and inside Tauri (desktop + Android).
 *
 * Node uses node:fs / node:sqlite; Tauri will use tauri-plugin-fs /
 * tauri-plugin-sql. Nothing above this layer knows the difference.
 */

export interface FileSystem {
  readText(path: string): Promise<string | null>;
  writeText(path: string, content: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  mkdirp(path: string): Promise<void>;
  join(...parts: string[]): string;
}

/**
 * HTTP is abstracted because a plain webview cannot fetch Yahoo / Google News /
 * iShares directly — CORS blocks it. Tauri's HTTP plugin performs requests
 * natively (no CORS), and Node uses global fetch for the parity harness.
 */
export interface HttpResponse {
  ok: boolean;
  status: number;
  text: string;
}

export interface HttpClient {
  getText(url: string, headers?: Record<string, string>): Promise<string | null>;
  getJson<T = unknown>(url: string, headers?: Record<string, string>): Promise<T | null>;
  /** POST a JSON body, returning the parsed JSON response or null on failure.
   * Used by the LLM providers, which just want the payload back (or nothing). */
  postJson<T = unknown>(
    url: string, body: unknown, headers?: Record<string, string>,
  ): Promise<T | null>;
  /** POST a JSON body, returning the raw outcome. Never throws — delivery uses
   * `ok`/`status` to build its per-channel report (a webhook 204 is success with
   * an empty body, which postJson can't distinguish from failure). */
  post(url: string, body: unknown, headers?: Record<string, string>): Promise<HttpResponse>;
}

export const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";

export type Row = Record<string, any>;

export interface Database {
  select<T = Row>(sql: string, params?: unknown[]): Promise<T[]>;
  execute(sql: string, params?: unknown[]): Promise<void>;
  close(): Promise<void>;
}

/**
 * Where things live. Mirrors config.py:
 *   home     -> writable user data (%APPDATA%/Investraton on Windows)
 *   resource -> bundled read-only resources (etf_sources.yaml, examples)
 */
export interface Paths {
  home: string;
  resource: string;
}

export const dataDir = (p: Paths, fs: FileSystem) => fs.join(p.home, "data");
export const configDir = (p: Paths, fs: FileSystem) => fs.join(p.home, "config");
export const resourceConfigDir = (p: Paths, fs: FileSystem) => fs.join(p.resource, "config");
