/** Swappable LLM providers — port of brain/llm.py.
 *
 * - TemplateLlm: no model at all. Deterministic, offline, always works.
 * - OllamaLlm:   local model via Ollama's HTTP API (desktop only).
 * - ClaudeLlm:   Anthropic Messages API. Needs a key.
 *
 * getLlm(settings) picks one and falls back to TemplateLlm if the provider is
 * unreachable or unconfigured — the digest must ALWAYS render. All HTTP goes
 * through the injected HttpClient (native on Tauri, global fetch on Node).
 *
 * The guardrails live in SYSTEM_PROMPT, but they're belt-and-braces: the engine
 * renders every number itself, so the model can only ever add a qualitative line.
 */

import type { HttpClient } from "../platform.ts";
import type { Settings } from "../config.ts";

export const SYSTEM_PROMPT =
  "You are Investraton, a personal investment INTELLIGENCE assistant. You are a " +
  "context amplifier, NOT a trading assistant. Absolute rules:\n" +
  "1. NEVER recommend buying, selling, or holding. No 'you should', no price targets.\n" +
  "2. NEVER invent or alter numbers. Use ONLY the figures provided; do no arithmetic.\n" +
  "3. For every item, explain WHY IT MATTERS TO THIS PERSON given their holdings/plan.\n" +
  "4. Be concise and calm. Reduce noise. Never create urgency or action pressure.\n" +
  "5. If data is labelled stale/approximate, preserve that caveat.\n" +
  "Write a clear, scannable digest in Markdown.";

export interface Llm {
  name: string;
  generate(prompt: string): Promise<string>;
}

/** No-LLM fallback: returns empty so the caller uses its deterministic template. */
export class TemplateLlm implements Llm {
  name = "template";
  async generate(_prompt: string): Promise<string> {
    return "";
  }
}

export class OllamaLlm implements Llm {
  name = "ollama";
  private host: string;
  private model: string;
  private http: HttpClient;

  constructor(host: string, model: string, http: HttpClient) {
    this.host = host.replace(/\/+$/, "");
    this.model = model;
    this.http = http;
  }

  async generate(prompt: string): Promise<string> {
    const res = await this.http.postJson<{ message?: { content?: string } }>(
      `${this.host}/api/chat`,
      {
        model: this.model,
        stream: false,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
      },
    );
    return (res?.message?.content ?? "").trim();
  }
}

export class ClaudeLlm implements Llm {
  name = "claude";
  private apiKey: string;
  private model: string;
  private http: HttpClient;

  constructor(apiKey: string, model: string, http: HttpClient) {
    this.apiKey = apiKey;
    this.model = model;
    this.http = http;
  }

  async generate(prompt: string): Promise<string> {
    const res = await this.http.postJson<{ content?: Array<{ type?: string; text?: string }> }>(
      "https://api.anthropic.com/v1/messages",
      {
        model: this.model,
        max_tokens: 1500,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: prompt }],
      },
      {
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
    );
    return (res?.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("")
      .trim();
  }
}

/** Pick a provider from settings, falling back to TemplateLlm. */
export function getLlm(settings: Settings, http: HttpClient): Llm {
  try {
    if (settings.llm_provider === "ollama") {
      return new OllamaLlm(settings.ollama_host, settings.ollama_model, http);
    }
    if (settings.llm_provider === "claude") {
      if (!settings.anthropic_api_key) return new TemplateLlm();
      return new ClaudeLlm(settings.anthropic_api_key, settings.anthropic_model, http);
    }
  } catch {
    return new TemplateLlm();
  }
  return new TemplateLlm();
}
