/** Digest -> prose — port of brain/narrative.py.
 *
 * The body is ALWAYS the deterministic template (correct numbers, straight from
 * the engine). An optional LLM contributes only a short qualitative summary line
 * on top; it can never invent figures or sections. If the LLM returns nothing or
 * throws, the template stands alone.
 */

import type { Digest, DigestEvent } from "../models.ts";
import { pyFloatStr, pyThousands } from "../round.ts";
import { pyTitle } from "../strings.ts";
import type { Llm } from "./llm.ts";
import { TemplateLlm } from "./llm.ts";

export async function buildNarrative(digest: Digest, llm: Llm): Promise<string> {
  let summary = "";
  if (!(llm instanceof TemplateLlm)) {
    try {
      summary = (await llm.generate(summaryPrompt(digest))).trim();
    } catch {
      summary = ""; // never let the brain break delivery
    }
  }
  return templateNarrative(digest, summary);
}

export function summaryPrompt(digest: Digest): string {
  const lines = [
    "You are summarising a personal investment digest in 2-3 short sentences.",
    "STRICT RULES: do NOT state any euro amounts, percentages, prices or holdings — " +
      "speak only qualitatively (e.g. 'a quiet week', 'concentration is in tech'). " +
      "Do NOT invent events or positions. No buy/sell/hold advice. Plain text only.",
    "",
    `Events this period: ${digest.events.length} owned, ${digest.watchlist.length} on watchlist.`,
  ];
  if (digest.events.length) {
    lines.push(
      "Top items: " + digest.events.slice(0, 4).map((e) => `${e.ticker} (${e.kind})`).join("; "),
    );
  }
  if (digest.structure.length) {
    lines.push("Structure notes: " + digest.structure.slice(0, 4).map((f) => f.title).join("; "));
  }
  if (!digest.events.length && !digest.watchlist.length) {
    lines.push("Nothing notable cleared the threshold this period.");
  }
  lines.push("\nWrite the 2-3 sentence qualitative summary now:");
  return lines.join("\n");
}

/** `%Y-%m-%d %H:%M UTC` from a Date's UTC fields. */
function fmtGenerated(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${p(d.getUTCFullYear(), 4)}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`
  );
}

export function templateNarrative(digest: Digest, summary = ""): string {
  const value = digest.amounts_provided
    ? `Portfolio ≈ €${pyThousands(digest.portfolio_total_eur)}`
    : "Amounts not set";
  const out: string[] = [
    `# INVESTigator — ${pyTitle(digest.period)} Digest`,
    `_Generated ${fmtGenerated(digest.generated_at)} · ${value} · ${digest.data_freshness}_`,
    "",
  ];
  if (summary) out.push(`> 🧠 _${summary}_`, "");

  // --- What happened (events) ---
  out.push("## What happened");
  if (!digest.events.length) {
    out.push("Nothing cleared your relevance threshold this period. Quiet is good. ✅\n");
  } else {
    const bySev: Record<string, DigestEvent[]> = { high: [], medium: [], low: [] };
    for (const e of digest.events) (bySev[e.severity] ?? bySev.low).push(e);
    out.push(
      `**${digest.events.length} item(s)** cleared your relevance threshold, ` +
        "ranked by how much they touch *your* capital — not by drama.\n",
    );
    for (const [sev, lab] of [["high", "🔴 High"], ["medium", "🟠 Medium"], ["low", "🟡 Low"]] as const) {
      if (!bySev[sev].length) continue;
      out.push(`### ${lab}`);
      for (const e of bySev[sev]) {
        const link = e.url ? ` ([source](${e.url}))` : "";
        out.push(`- **${e.ticker} · ${e.headline}**${link}`);
        out.push(`  - _Urgency ${pyFloatStr(e.urgency)}/10._ ${e.explanation}`);
      }
      out.push("");
    }
  }

  // --- On your radar (watchlist / discovery) ---
  if (digest.watchlist.length) {
    out.push("## On your radar");
    out.push("_Things you're tracking but don't own yet — discovery context, not advice._\n");
    for (const e of digest.watchlist) {
      const link = e.url ? ` ([source](${e.url}))` : "";
      out.push(`- **${e.ticker} · ${e.headline}**${link}`);
      out.push(`  - _Urgency ${pyFloatStr(e.urgency)}/10._ ${e.explanation}`);
    }
    out.push("");
  }

  // --- Your structure (look-through / concentration / plan) ---
  if (digest.structure.length) {
    out.push("## Your structure");
    const icon: Record<string, string> = { watch: "🔴", note: "🟠", info: "▫️" };
    for (const f of digest.structure) {
      out.push(`- ${icon[f.severity] ?? "▫️"} **${f.title}**`);
      out.push(`  - ${f.detail}`);
    }
    out.push("");
  }

  out.push("_No buy/sell/hold advice — this is context, not a recommendation._");
  return out.join("\n");
}
