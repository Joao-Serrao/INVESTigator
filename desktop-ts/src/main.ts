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
  cancel, isPermissionGranted, pending, requestPermission, sendNotification,
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
// MUST be true. Reading the plugin's setExactIfPossible(): on Android 12+ without
// the exact-alarm permission, allowWhileIdle=true -> setAndAllowWhileIdle (RTC_WAKEUP,
// fires through Doze, NO special permission), whereas false -> a plain set() that is
// inexact and DEFERRED until the app/device next wakes (the "only fires when I reopen
// the app" bug). It does NOT throw — the earlier crash was the cancelAll() bug.
const ALLOW_IDLE = true;

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
          body: `Your ${s.frequency.replace(/_/g, " ")} digest is due — open the app to run it.`,
          schedule: toNotifSchedule(s.frequency, s.time),
          extra: { scheduleId: s.id },
        });
        results.push({ name: s.name, ok: true });
      } catch (e) {
        results.push({ name: s.name, ok: false, detail: errText(e) });
      }
    }
    await baselineNewSchedules(); // so catch-up won't fire retroactively for new ones
    const failed = results.find((r) => !r.ok);
    return { ok: !failed, error: failed?.detail, results };
  } catch (e) {
    return { ok: false, error: errText(e), results: [] };
  }
}

// ---------------------------------------------------------------- catch-up runner
// The plugin's notification-tap path can't identify which reminder was tapped
// (sourceJson is never populated, so the tap payload's `notification` is null),
// and cold-start taps race the listener. So instead of reacting to the tap, we
// RUN a schedule the next time the app opens after its time has passed. Combined
// with the reminder (which nudges the user to open the app), this delivers
// "reminder -> open -> digest runs -> History" without depending on the tap.
const RUNS_FILE = "mobile_last_runs.json";

// Serialize every read-modify-write of the runs file. runDueSchedules (fired on
// visibilitychange) and baselineNewSchedules (launch / save / import) both do
// load -> mutate -> save; without a lock one clobbers the other, so a due schedule
// runs twice or its baseline is lost and it fires retroactively.
let runsLock: Promise<unknown> = Promise.resolve();
function withRunsLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = runsLock.then(fn, fn);
  runsLock = next.then(() => {}, () => {});
  return next;
}

async function loadRuns(): Promise<Record<string, number>> {
  const { fs, paths } = await platformP;
  const text = await fs.readText(fs.join(paths.home, "config", RUNS_FILE));
  if (!text) return {};
  try { return JSON.parse(text) as Record<string, number>; } catch { return {}; }
}
async function saveRuns(runs: Record<string, number>): Promise<void> {
  const { fs, paths } = await platformP;
  await fs.mkdirp(fs.join(paths.home, "config"));
  await fs.writeText(fs.join(paths.home, "config", RUNS_FILE), JSON.stringify(runs));
}

/** Most recent scheduled datetime <= now (ms); null for the cadence-based every_3_days. */
function mostRecentOccurrence(freq: string, time: string, now: number): number | null {
  const [h, m] = (time || "08:00").split(":").map((x) => Number(x) || 0);
  const at = new Date(now);
  at.setHours(h, m, 0, 0);
  if (freq === "daily") {
    if (at.getTime() > now) at.setDate(at.getDate() - 1);
    return at.getTime();
  }
  if (freq === "weekly") {
    at.setDate(at.getDate() - ((at.getDay() + 6) % 7)); // back to Monday
    if (at.getTime() > now) at.setDate(at.getDate() - 7);
    return at.getTime();
  }
  if (freq === "monthly") {
    at.setDate(1);
    if (at.getTime() > now) at.setMonth(at.getMonth() - 1);
    return at.getTime();
  }
  return null;
}

const navHistory = () => {
  if (typeof window.__nav === "function") window.__nav("history");
  else location.hash = "history";
};

let catchingUp = false;
/** Run any enabled schedule whose time has passed since we last ran it. */
async function runDueSchedules(): Promise<void> {
  if (catchingUp) return;
  catchingUp = true;
  try {
    await withRunsLock(async () => {
      const ctx = await ready;
      const { fs, paths } = await platformP;
      const scheds = await loadSchedules(fs, paths);
      const runs = await loadRuns();
      const now = Date.now();
      const due = scheds.filter((s) => {
        if (!s.enabled) return false;
        const last = runs[s.id] ?? 0;
        return s.frequency === "every_3_days"
          ? last > 0 && now - last >= 3 * 86_400_000
          : (() => { const o = mostRecentOccurrence(s.frequency, s.time, now); return o !== null && o > last; })();
      });
      if (due.length === 0) return;

      // Jump to History with a "running" banner FIRST, so it feels instant; the digest
      // (network fetch) then fills in and we refresh History to show the result.
      window.__digestRunning = due.length;
      navHistory();
      for (const s of due) {
        try {
          await handle(ctx, "POST", `/api/schedules/${encodeURIComponent(s.id)}/run`);
          runs[s.id] = now;
        } catch { /* try again next open */ }
        window.__digestRunning = Math.max(0, (window.__digestRunning ?? 1) - 1);
      }
      await saveRuns(runs);
      window.__digestRunning = 0;
      navHistory(); // re-render: banner gone, new entry present
    });
  } finally {
    catchingUp = false;
  }
}

/** Baseline lastRun=now for brand-new schedules so catch-up doesn't fire for times
 * that already passed before the schedule existed. */
async function baselineNewSchedules(): Promise<void> {
  await withRunsLock(async () => {
    const { fs, paths } = await platformP;
    const scheds = await loadSchedules(fs, paths);
    const runs = await loadRuns();
    let changed = false;
    for (const s of scheds) if (s.enabled && !(s.id in runs)) { runs[s.id] = Date.now(); changed = true; }
    if (changed) await saveRuns(runs);
  });
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
  // On launch: re-arm reminders (backstop; the plugin also restores on BOOT), then
  // run anything already due. On every foreground (incl. opening via a reminder tap):
  // run due schedules. This is what makes "reminder -> open -> digest runs -> History"
  // work without relying on the plugin's unusable tap payload.
  ready.then(async () => {
    await applyMobileSchedules();
    await runDueSchedules();
  }).catch(() => {});
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") runDueSchedules().catch(() => {});
  });
} else {
  // Desktop: when a Windows scheduled task launched us as `run-schedule <id>`, the
  // window stays hidden — run that digest (delivering to its channels) and exit.
  ready.then(async (ctx) => {
    const taskId = await invoke<string | null>("pending_scheduled_run").catch(() => null);
    if (!taskId) return;
    try {
      await handle(ctx, "POST", `/api/schedules/${encodeURIComponent(taskId)}/run`);
    } catch { /* best effort — nothing to show, we're headless */ }
    finally { await invoke("exit_app").catch(() => {}); } // never leak the hidden process
  }).catch(async () => {
    // Context init itself failed. If this was a headless scheduled launch we must
    // still exit, or the invisible window lingers forever (the Rust watchdog is the
    // final backstop). A normal launch keeps its now-visible window.
    const taskId = await invoke<string | null>("pending_scheduled_run").catch(() => null);
    if (taskId) await invoke("exit_app").catch(() => {});
  });
}

declare global {
  interface Window {
    __invest?: (method: string, path: string, body?: unknown) => Promise<unknown>;
    __platform?: "desktop" | "android";
    __nav?: (view: string) => void;
    __digestRunning?: number;
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
