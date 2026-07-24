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
