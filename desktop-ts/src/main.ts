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
import {
  cancel, isPermissionGranted, onAction, pending, requestPermission, sendNotification,
  Schedule as NotifSchedule, ScheduleEvery,
} from "@tauri-apps/plugin-notification";

import { handle } from "@investigator/engine/app/router";
import type { AppContext } from "@investigator/engine/app/service";
import type { DeliverContext, EmailSender, Notifier } from "@investigator/engine/deliver";
import type { SmtpConfig } from "@investigator/engine/config";
import { loadSchedules } from "@investigator/engine/store/files";
import { Store } from "@investigator/engine/store/db";

import { makeTauriPlatform, type TauriPlatform } from "./adapter.ts";

const IS_MOBILE = ((): boolean => {
  try {
    const p = osPlatform();
    return p === "android" || p === "ios";
  } catch {
    return false;
  }
})();
const PLATFORM: "desktop" | "android" = IS_MOBILE ? "android" : "desktop";

// One platform init, shared by the context and the mobile scheduler.
const platformP: Promise<TauriPlatform> = makeTauriPlatform();

/** SMTP via a Rust command (lettre). Absent command -> throws, surfaced in the
 * per-channel delivery report rather than failing silently. */
const emailSender: EmailSender = {
  async send(cfg: SmtpConfig, subject: string, body: string) {
    await invoke("send_email", { cfg, subject, body });
  },
};

/** Native notifications via the Tauri plugin — the offline delivery channel.
 * Tagged so a tap opens History (where the just-delivered digest is). */
const notifier: Notifier = {
  async notify(title: string, body: string) {
    if (!(await ensureNotifyPermission())) throw new Error("Notification permission not granted");
    sendNotification({ title, body, extra: { view: "history" } });
  },
};

async function ensureNotifyPermission(): Promise<boolean> {
  if (await isPermissionGranted()) return true;
  return (await requestPermission()) === "granted";
}

// ---------------------------------------------------------------- mobile scheduler
// allowWhileIdle would make the plugin schedule an EXACT alarm, which throws a
// SecurityException on Android 12+ unless the app holds SCHEDULE_EXACT_ALARM. We
// keep it false: an inexact reminder (fires within a short window) is right for a
// digest and needs no special-permission prompt.
const ALLOW_IDLE = false;

/** Map a saved schedule (frequency + HH:MM) to a repeating notification schedule.
 * `interval` is calendar-matched (like cron); `every` is a fixed cadence, used for
 * the odd "every 3 days" case. */
function toNotifSchedule(frequency: string, time: string): NotifSchedule {
  const [hh, mm] = (time || "08:00").split(":");
  const hour = Number(hh) || 0;
  const minute = Number(mm) || 0;
  switch (frequency) {
    case "daily": return NotifSchedule.interval({ hour, minute }, ALLOW_IDLE);
    case "every_3_days": return NotifSchedule.every(ScheduleEvery.Day, 3, ALLOW_IDLE);
    case "monthly": return NotifSchedule.interval({ day: 1, hour, minute }, ALLOW_IDLE);
    case "weekly":
    default: return NotifSchedule.interval({ weekday: 2, hour, minute }, ALLOW_IDLE); // Monday
  }
}

/** Best-effort readable message from any thrown/rejected value (Tauri rejects with
 * objects/strings, not always Errors — String(obj) would give "[object Object]"). */
function errText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  try { return JSON.stringify(e); } catch { return String(e); }
}

/** Stable positive 32-bit notification id from a schedule's id. */
function notifIdFor(sid: string): number {
  let h = 0;
  for (let i = 0; i < sid.length; i++) h = (Math.imul(h, 31) + sid.charCodeAt(i)) | 0;
  return (Math.abs(h) % 2_000_000_000) + 1;
}

/** Register a reminder notification for every enabled schedule (replacing any
 * previous ones). Called after each schedule change and once on launch, since
 * AlarmManager alarms don't survive a reboot. */
async function applyMobileSchedules(): Promise<{ ok: boolean; error?: string; results: unknown[] }> {
  try {
    if (!(await ensureNotifyPermission())) {
      return { ok: false, error: "Notification permission not granted", results: [] };
    }
    const { fs, paths } = await platformP;
    const scheds = await loadSchedules(fs, paths);
    // Clear previously-scheduled reminders, then re-create. NB: cancelAll() is
    // broken in the plugin (it invokes `cancel` with no `notifications`, hitting a
    // lateinit -> "lateinit property notifications has not been initialized"), so we
    // enumerate the pending ones and cancel them by explicit id.
    try {
      const ids = (await pending()).map((p) => p.id).filter((id) => typeof id === "number");
      if (ids.length) await cancel(ids);
    } catch { /* nothing pending yet */ }
    const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
    for (const s of scheds) {
      if (!s.enabled) continue;
      try {
        await sendNotification({
          id: notifIdFor(s.id),
          title: `INVESTigator — ${s.name}`,
          body: `Your ${s.frequency.replace(/_/g, " ")} digest is due — tap to run it.`,
          schedule: toNotifSchedule(s.frequency, s.time),
          extra: { scheduleId: s.id }, // so a tap can find + run this schedule
        });
        results.push({ name: s.name, ok: true });
      } catch (e) {
        results.push({ name: s.name, ok: false, detail: errText(e) });
      }
    }
    const failed = results.find((r) => !r.ok);
    return { ok: !failed, error: failed?.detail, results };
  } catch (e) {
    return { ok: false, error: errText(e), results: [] };
  }
}

async function buildContext(): Promise<AppContext> {
  const platform = await platformP;
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
    // On mobile, schedules become repeating reminder notifications (AlarmManager via
    // the notification plugin). On desktop, Windows Task Scheduler (Rust command).
    syncTasks: IS_MOBILE
      ? applyMobileSchedules
      : () => invoke("sync_schedules") as Promise<{ ok: boolean; error?: string; results: unknown[] }>,
  };
}

// Kick off init once; every bridge call awaits the same promise.
const ready: Promise<AppContext> = buildContext();

if (IS_MOBILE) {
  ready.then(async (ctx) => {
    // Re-register reminders on launch (belt-and-braces; the plugin also restores
    // them on BOOT_COMPLETED).
    await applyMobileSchedules();
    // Tapping a reminder opens the app, runs that schedule (delivering to its
    // channels), and jumps to History so the result is visible.
    try {
      await onAction(async (n) => {
        const sid = typeof n.extra?.scheduleId === "string" ? n.extra.scheduleId : null;
        if (sid) {
          // A schedule reminder: run that digest, then show the result.
          try {
            await handle(ctx, "POST", `/api/schedules/${encodeURIComponent(sid)}/run`);
          } catch { /* it still delivered to its channels */ }
          location.hash = "history";
        } else if (n.extra?.view === "history") {
          // A delivered digest: jump to History to read it.
          location.hash = "history";
        }
      });
    } catch { /* onAction unsupported on this platform */ }
  }).catch(() => {});
}

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
