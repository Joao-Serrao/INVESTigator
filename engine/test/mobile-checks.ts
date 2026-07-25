/** Checks for the mobile-specific additive logic (no Python counterpart to compare
 * against): the notification summary text and the Ollama-on-mobile restriction.
 *
 * Run:  npm run mobile-checks
 */

import { getLlm, OllamaLlm, TemplateLlm } from "../src/brain/llm.ts";
import type { Settings } from "../src/config.ts";
import { defaultSettings } from "../src/config.ts";
import { notificationText } from "../src/deliver.ts";
import type { Digest, DigestEvent } from "../src/models.ts";
import type { HttpClient } from "../src/platform.ts";

let fails = 0;
const eq = (label: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    fails++;
    console.log(`  FAIL ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
  }
};

const ev = (ticker: string, headline: string): DigestEvent => ({
  ticker, kind: "news", severity: "high", urgency: 8, headline, explanation: "", url: "",
});
const digest = (events: DigestEvent[], watchlist: DigestEvent[]): Digest => ({
  generated_at: new Date(0), period: "weekly", events, portfolio_total_eur: 0,
  data_freshness: "", amounts_provided: true, structure: [], watchlist,
  delivery_report: [], narrative: "",
});

// --- notification text ---
{
  const quiet = notificationText(digest([], []));
  eq("quiet.title", quiet.title, "INVESTigator — Weekly Digest");
  eq("quiet.body", quiet.body, "Nothing notable cleared your threshold. Quiet is good.");

  const busy = notificationText(digest([ev("AAPL", "Apple faces lawsuit")], [ev("TSLA", "Tesla recall")]));
  eq("busy.body", busy.body, "1 update · 1 on your radar — AAPL: Apple faces lawsuit");

  const many = notificationText(digest([ev("A", "x"), ev("B", "y"), ev("C", "z")], []));
  eq("many.body", many.body, "3 updates — A: x");

  // over-long body is truncated with an ellipsis
  const long = notificationText(digest([ev("AAPL", "z".repeat(400))], []));
  eq("long.truncated", long.body.length <= 220 && long.body.endsWith("…"), true);
}

// --- Ollama gated on mobile ---
{
  const http = {} as HttpClient;
  const s: Settings = { ...defaultSettings(), llm_provider: "ollama" };
  eq("desktop.ollama", getLlm(s, http, true) instanceof OllamaLlm, true);
  eq("mobile.ollama->template", getLlm(s, http, false) instanceof TemplateLlm, true);

  const c: Settings = { ...defaultSettings(), llm_provider: "claude", anthropic_api_key: "k" };
  // Claude with a key is allowed on both; only local models are gated.
  eq("mobile.claude.stays", getLlm(c, http, false).name, "claude");
}

console.log(fails ? `\n${fails} mismatches` : "mobile checks: OK");
if (fails) process.exit(1);
