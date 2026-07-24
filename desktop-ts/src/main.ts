/** Desktop bootstrap: build the engine's AppContext from the Tauri platform and
 * expose it to the WebView as `window.__invest(method, path, body)`.
 *
 * The vanilla-JS UI (shared with the Python build) calls that bridge exactly where
 * it used to call `fetch('/api/...')`. This file is bundled to a classic script and
 * loaded BEFORE the UI, so `window.__invest` exists synchronously when the UI runs;
 * each call awaits one-time async init (DB open) internally.
 */

import { invoke } from "@tauri-apps/api/core";

import { handle } from "@investigator/engine/app/router";
import type { AppContext } from "@investigator/engine/app/service";
import type { DeliverContext, EmailSender } from "@investigator/engine/deliver";
import type { SmtpConfig } from "@investigator/engine/config";
import { Store } from "@investigator/engine/store/db";

import { makeTauriPlatform } from "./adapter.ts";

/** SMTP via a Rust command (lettre). Absent command -> throws, surfaced in the
 * per-channel delivery report rather than failing silently. */
const emailSender: EmailSender = {
  async send(cfg: SmtpConfig, subject: string, body: string) {
    await invoke("send_email", { cfg, subject, body });
  },
};

async function buildContext(): Promise<AppContext> {
  const platform = await makeTauriPlatform();
  const store = new Store(platform.db);
  await store.init(); // creates tables if missing + migrates pre-scope reported_events

  const deliver: DeliverContext = {
    http: platform.http,
    emailSender,
    consoleSink: (t) => console.log(t),
  };
  return {
    fs: platform.fs,
    http: platform.http,
    paths: platform.paths,
    store,
    deliver,
    openUrl: platform.openUrl,
    // Windows Task Scheduler / Android AlarmManager live in Rust; the WebView asks
    // for a re-sync after any schedule change.
    syncTasks: () => invoke("sync_schedules") as Promise<
      { ok: boolean; error?: string; results: unknown[] }
    >,
  };
}

// Kick off init once; every bridge call awaits the same promise.
const ready: Promise<AppContext> = buildContext();

declare global {
  interface Window {
    __invest?: (method: string, path: string, body?: unknown) => Promise<unknown>;
  }
}

window.__invest = async (method: string, path: string, body?: unknown): Promise<unknown> => {
  const ctx = await ready;
  const res = await handle(ctx, method, path, body);
  if (res.status >= 400) {
    const detail = (res.body as { detail?: string })?.detail ?? `HTTP ${res.status}`;
    throw Object.assign(new Error(detail), { status: res.status });
  }
  return res.body;
};
