/** Delivery layer — port of deliver/*.py.
 *
 * Each channel takes a finished Digest and pushes its narrative; channels fail
 * independently so one broken channel never blocks the others, and deliver()
 * returns a per-channel report the UI can SHOW instead of hiding in logs.
 *
 * Console and Discord are self-contained here. Email (SMTP) is platform-specific
 * — a raw TLS socket on desktop, a plugin on Android — so it's injected as an
 * EmailSender; without one, the email channel reports a clear error rather than
 * pretending to send.
 */

import type { SmtpConfig, Settings } from "./config.ts";
import type { Digest, DeliveryResult } from "./models.ts";
import type { HttpClient } from "./platform.ts";
import { pyTitle } from "./strings.ts";

const DISCORD_MAX = 1900; // headroom under Discord's 2000-char limit

/** Split a narrative on line boundaries where possible, then hard-wrap over-long
 * lines. Faithful port of discord._chunks (a real algorithm, so it's parity-tested). */
export function chunkDiscord(text: string, size = DISCORD_MAX): string[] {
  const out: string[] = [];
  let buf = "";
  for (let para of text.split("\n")) {
    if (buf.length + para.length + 1 > size) {
      if (buf) out.push(buf);
      while (para.length > size) {
        out.push(para.slice(0, size));
        para = para.slice(size);
      }
      buf = para;
    } else {
      buf = buf ? `${buf}\n${para}` : para;
    }
  }
  if (buf) out.push(buf);
  return out;
}

/** SMTP transport — implemented per platform, injected into delivery. Throws on
 * any failure so the reason surfaces in the report (mirrors email._send_raw). */
export interface EmailSender {
  send(cfg: SmtpConfig, subject: string, body: string): Promise<void>;
}

/** Native notification — platform-injected (the Tauri notification plugin). This
 * is the offline-capable delivery channel that makes the mobile build useful: a
 * digest can fire a notification with no network, no email, no server. */
export interface Notifier {
  notify(title: string, body: string): Promise<void>;
}

export interface DeliverContext {
  http: HttpClient;
  emailSender?: EmailSender;
  notifier?: Notifier;
  /** where console delivery writes; defaults to console.log */
  consoleSink?: (text: string) => void;
}

/** A short title + body for a notification (the full narrative is far too long).
 * Additive — this channel has no Python counterpart, so nothing to match. */
export function notificationText(digest: Digest): { title: string; body: string } {
  const title = `INVESTigator — ${pyTitle(digest.period)} Digest`;
  const n = digest.events.length;
  const w = digest.watchlist.length;
  let body: string;
  if (!n && !w) {
    body = "Nothing notable cleared your threshold. Quiet is good.";
  } else {
    const bits: string[] = [];
    if (n) bits.push(`${n} update${n === 1 ? "" : "s"}`);
    if (w) bits.push(`${w} on your radar`);
    body = bits.join(" · ");
    const top = digest.events[0] ?? digest.watchlist[0];
    if (top) body += ` — ${top.ticker}: ${top.headline}`;
  }
  return { title, body: body.length > 220 ? body.slice(0, 217) + "…" : body };
}

async function sendConsole(digest: Digest, ctx: DeliverContext): Promise<void> {
  const sink = ctx.consoleSink ?? ((t: string) => console.log(t));
  sink("\n" + "=".repeat(70) + "\n" + digest.narrative + "\n" + "=".repeat(70) + "\n");
}

async function sendDiscord(digest: Digest, settings: Settings, ctx: DeliverContext): Promise<void> {
  const url = settings.discord_webhook_url;
  if (!url) return; // selected but unconfigured -> no-op, like the Python version
  for (const chunk of chunkDiscord(digest.narrative, DISCORD_MAX)) {
    const res = await ctx.http.post(url, { content: chunk });
    if (!res.ok) throw new Error(`Discord HTTP ${res.status}`);
  }
}

/** `Investraton — {Period} Digest (YYYY-MM-DD)` from generated_at (UTC). */
export function emailSubject(digest: Digest): string {
  const d = digest.generated_at;
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const date = `${p(d.getUTCFullYear(), 4)}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
  return `Investraton — ${pyTitle(digest.period)} Digest (${date})`;
}

async function sendEmail(digest: Digest, settings: Settings, ctx: DeliverContext): Promise<void> {
  if (!ctx.emailSender) throw new Error("Email transport not available on this platform");
  await ctx.emailSender.send(settings.smtp, emailSubject(digest), digest.narrative);
}

async function sendNotification(digest: Digest, ctx: DeliverContext): Promise<void> {
  if (!ctx.notifier) throw new Error("Notifications not available on this platform");
  const { title, body } = notificationText(digest);
  await ctx.notifier.notify(title, body);
}

/** Send to every configured channel, isolating failures. */
export async function deliver(
  digest: Digest, settings: Settings, ctx: DeliverContext,
): Promise<DeliveryResult[]> {
  const report: DeliveryResult[] = [];
  for (const channel of settings.delivery) {
    try {
      if (channel === "console") await sendConsole(digest, ctx);
      else if (channel === "discord") await sendDiscord(digest, settings, ctx);
      else if (channel === "email") await sendEmail(digest, settings, ctx);
      else if (channel === "notification") await sendNotification(digest, ctx);
      else {
        report.push({ channel, ok: false, error: "unknown channel" });
        continue;
      }
      report.push({ channel, ok: true });
    } catch (e) {
      report.push({ channel, ok: false, error: errStr(e) });
    }
  }
  return report;
}

const TEST_SUBJECT = "Investraton — test email ✅";
const TEST_BODY =
  "This is a test from Investraton. If you received it, your email delivery is working.\n" +
  "You can now set Email as a delivery channel for your digests.";

/** Send a test email; throws on failure (drives the 'Send test email' button). */
export async function sendTestEmail(settings: Settings, ctx: DeliverContext): Promise<void> {
  if (!ctx.emailSender) throw new Error("Email transport not available on this platform");
  await ctx.emailSender.send(settings.smtp, TEST_SUBJECT, TEST_BODY);
}

function errStr(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}
