/** Runtime settings — port of the settings half of config.py.
 *
 * Precedence in Python is defaults -> .env -> app_settings.json. `.env` is a
 * developer convenience for the Python CLI; the packaged app (and therefore this
 * port) is configured entirely through app_settings.json via the settings UI, so
 * here it's just defaults overlaid with app_settings.json — the exact same overlay
 * step config.load_settings() applies last.
 */

import type { FileSystem, Paths } from "./platform.ts";
import { dataDir } from "./platform.ts";
import { loadAppSettings } from "./store/files.ts";

export interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  from: string;
  to: string;
}

export interface Settings {
  llm_provider: string;
  ollama_host: string;
  ollama_model: string;
  anthropic_api_key: string;
  anthropic_model: string;
  delivery: string[];
  discord_webhook_url: string;
  smtp: SmtpConfig;
}

export function defaultSettings(): Settings {
  return {
    llm_provider: "template",
    ollama_host: "http://localhost:11434",
    ollama_model: "llama3.1",
    anthropic_api_key: "",
    anthropic_model: "claude-haiku-4-5-20251001",
    delivery: ["console"],
    discord_webhook_url: "",
    smtp: { host: "", port: 587, user: "", password: "", from: "", to: "" },
  };
}

/** Defaults overlaid with the GUI-managed app_settings.json (config.load_settings). */
export async function loadSettings(fs: FileSystem, p: Paths): Promise<Settings> {
  const s = defaultSettings();
  const o = await loadAppSettings(fs, p);
  if (o && Object.keys(o).length) {
    if (o.llm_provider != null) s.llm_provider = String(o.llm_provider).trim().toLowerCase();
    if (o.ollama_host != null) s.ollama_host = o.ollama_host;
    if (o.ollama_model != null) s.ollama_model = o.ollama_model;
    if (o.anthropic_api_key != null) s.anthropic_api_key = o.anthropic_api_key;
    if (o.anthropic_model != null) s.anthropic_model = o.anthropic_model;
    if (o.delivery && o.delivery.length) s.delivery = o.delivery;
    if (o.discord_webhook_url != null) s.discord_webhook_url = o.discord_webhook_url;
    if (o.smtp && typeof o.smtp === "object") s.smtp = { ...s.smtp, ...o.smtp };
  }
  return s;
}

export const dbPath = (p: Paths, fs: FileSystem): string =>
  fs.join(dataDir(p, fs), "investraton.db");
export const holdingsCsvPath = (p: Paths, fs: FileSystem): string =>
  fs.join(dataDir(p, fs), "holdings.csv");
