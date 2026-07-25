/** App bootstrap: build the engine's AppContext from the Tauri platform and expose
 * it to the WebView as `window.__invest(method, path, body)`.
 *
 * ONE bootstrap serves both desktop and Android — Tauri builds the same frontend
 * into both. It branches on the runtime platform: on mobile it drops the console
 * channel, adds native notifications, and tells the engine to omit local AI
 * (Ollama). The vanilla-JS UI (shared with the Python build) calls the bridge where
 * it used to `fetch('/api/...')`; `window.__platform` lets it hide desktop-only options.
 */

import { invoke } from "@tauri-apps/api/core";
import { platform as osPlatform } from "@tauri-apps/plugin-os";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";

import { handle } from "@investigator/engine/app/router";
import type { AppContext } from "@investigator/engine/app/service";
import type { DeliverContext, EmailSender, Notifier } from "@investigator/engine/deliver";
import type { SmtpConfig } from "@investigator/engine/config";
import { Store } from "@investigator/engine/store/db";

import { makeTauriPlatform } from "./adapter.ts";

const IS_MOBILE = ((): boolean => {
  try {
    const p = osPlatform();
    return p === "android" || p === "ios";
  } catch {
    return false;
  }
})();
const PLATFORM: "desktop" | "android" = IS_MOBILE ? "android" : "desktop";

/** SMTP via a Rust command (lettre). Absent command -> throws, surfaced in the
 * per-channel delivery report rather than failing silently. */
const emailSender: EmailSender = {
  async send(cfg: SmtpConfig, subject: string, body: string) {
    await invoke("send_email", { cfg, subject, body });
  },
};

/** Native notifications via the Tauri plugin — the offline delivery channel. */
const notifier: Notifier = {
  async notify(title: string, body: string) {
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === "granted";
    if (!granted) throw new Error("Notification permission not granted");
    sendNotification({ title, body });
  },
};

async function buildContext(): Promise<AppContext> {
  const platform = await makeTauriPlatform();
  const store = new Store(platform.db);
  await store.init(); // creates tables if missing + migrates pre-scope reported_events

  const deliver: DeliverContext = {
    http: platform.http,
    emailSender,
    notifier,
    consoleSink: (t) => console.log(t),
  };
  return {
    fs: platform.fs,
    http: platform.http,
    paths: platform.paths,
    store,
    deliver,
    platform: PLATFORM,
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
    __platform?: "desktop" | "android";
  }
}

// Let the shared UI hide desktop-only options (e.g. the Ollama AI provider).
window.__platform = PLATFORM;

window.__invest = async (method: string, path: string, body?: unknown): Promise<unknown> => {
  const ctx = await ready;
  const res = await handle(ctx, method, path, body);
  if (res.status >= 400) {
    const detail = (res.body as { detail?: string })?.detail ?? `HTTP ${res.status}`;
    throw Object.assign(new Error(detail), { status: res.status });
  }
  return res.body;
};
