/** Port of engine/scoping.py — complexity presets and focus selection. */

import type { Holding, Subject } from "./models.ts";
import { subjectKey } from "./models.ts";

export interface Complexity {
  min_urgency: number;
  max_per_subject: number;
  max_total: number;
  include_structure: boolean;
  include_watchlist: boolean;
  label: string;
}

export const COMPLEXITY_PRESETS: Record<string, Complexity> = {
  simple:   { min_urgency: 4.0, max_per_subject: 2,  max_total: 8,   include_structure: false, include_watchlist: true,  label: "Simple" },
  standard: { min_urgency: 2.0, max_per_subject: 3,  max_total: 15,  include_structure: true,  include_watchlist: true,  label: "Standard" },
  complex:  { min_urgency: 1.0, max_per_subject: 5,  max_total: 30,  include_structure: true,  include_watchlist: true,  label: "Complex" },
  urgent:   { min_urgency: 6.5, max_per_subject: 2,  max_total: 10,  include_structure: false, include_watchlist: false, label: "Urgent only" },
  none:     { min_urgency: 0.0, max_per_subject: 50, max_total: 200, include_structure: true,  include_watchlist: true,  label: "No filtering" },
};

export function getComplexity(name: string | null | undefined, planMinUrgency: number): Complexity {
  let preset = COMPLEXITY_PRESETS[(name || "standard").toLowerCase()];
  if (!preset) preset = COMPLEXITY_PRESETS["standard"];
  // The plan's own threshold acts as a floor for 'standard' so user tuning still bites.
  if (name === null || name === undefined || name === "" || name === "standard") {
    preset = { ...preset, min_urgency: Math.max(preset.min_urgency, planMinUrgency) };
  }
  return preset;
}

/** Heuristic: short, no spaces, mostly upper/dot/digits -> treat as a ticker. */
export function looksLikeTicker(s: string): boolean {
  if (s.includes(" ") || s.includes("_")) return false;
  const core = s.replaceAll(".", "").replaceAll("-", "");
  return s.length <= 6 && isAlnum(core) && core.toUpperCase() === core;
}

/** Match Python str.isalnum(): non-empty and every char alphanumeric. */
function isAlnum(s: string): boolean {
  return s.length > 0 && /^[\p{L}\p{N}]+$/u.test(s);
}

export function buildSubjects(holdings: Holding[], watchlist: string[], focus: string): Subject[] {
  const f = (focus || "all").toLowerCase();
  const owned: Subject[] = holdings.map((h) => ({
    name: h.name || h.ticker,
    ticker: h.ticker,
    owned: true,
    weight: h.portfolio_weight,
    strategy_tag: h.strategy_tag,
    type: h.type,
  }));
  const ownedKeys = new Set(owned.map(subjectKey));

  const watch: Subject[] = [];
  for (const raw of watchlist ?? []) {
    const w = String(raw).trim();
    if (!w) continue;
    const isTicker = looksLikeTicker(w);
    const name = isTicker ? w : w.replaceAll("_", " ");
    const subj: Subject = {
      name, ticker: isTicker ? w : "", owned: false, weight: 0,
      strategy_tag: "", type: "watchlist",
    };
    if (ownedKeys.has(subjectKey(subj))) continue; // already owned
    watch.push(subj);
  }

  if (f === "invested") return owned;
  if (f === "watchlist") return watch;
  if (f.startsWith("group:")) {
    const tag = f.slice("group:".length).trim().toLowerCase();
    return owned.filter((s) => s.strategy_tag.toLowerCase() === tag || s.type.toLowerCase() === tag);
  }
  return [...owned, ...watch];
}
