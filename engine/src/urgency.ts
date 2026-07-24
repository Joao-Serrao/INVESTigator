/** Port of engine/urgency.py — urgency scoring + event construction.
 *
 * Urgency is ADDITIVE and clamped, never multiplicative: each factor is a 0..1
 * signal, weighted and summed, then clamped to [0, 10]. A single weak factor
 * lowers a score but never silently nukes an otherwise important event. The
 * result is a SORT KEY for attention, not a verdict.
 */

import type { DigestEvent, Holding, NewsItem, Plan, PriceSnapshot, Subject } from "./models.ts";
import { isTheme } from "./models.ts";
import { pyFormat, pyRound } from "./round.ts";

// Weights sum to 10 -> urgency lands on a 0..10 scale.
const W_EXPOSURE = 4.0;
const W_SEVERITY = 3.0;
const W_PLAN = 2.0;
const W_TIME = 1.0;

const HIGH_SEVERITY_KW = [
  "lawsuit", "fraud", "investigation", "bankruptcy", "default", "guidance cut",
  "profit warning", "downgrade", "recall", "data breach", "resigns", "ceo steps down",
  "plunge", "crash", "halt", "delist",
];
const MED_SEVERITY_KW = [
  "earnings", "results", "guidance", "acquisition", "merger", "dividend", "buyback",
  "upgrade", "partnership", "launch", "forecast", "outlook", "revenue", "layoff",
];

const clamp = (x: number, lo = 0, hi = 10): number => Math.max(lo, Math.min(hi, x));

function severityLabel(score10: number): string {
  if (score10 >= 6.5) return "high";
  if (score10 >= 3.5) return "medium";
  return "low";
}

export function newsSeverityFactor(title: string): number {
  const t = title.toLowerCase();
  if (HIGH_SEVERITY_KW.some((kw) => t.includes(kw))) return 0.9;
  if (MED_SEVERITY_KW.some((kw) => t.includes(kw))) return 0.55;
  return 0.2;
}

/** 0..1 — does this position sit in a bucket the plan actively cares about? */
function planRelevance(h: Holding, plan: Plan): number {
  const targets = plan.allocation_targets ?? {};
  const bucket = h.type in targets ? h.type : null;
  const weightInPlan = bucket ? targets[bucket] : 0;
  const onWatchlist = new Set((plan.watchlist ?? []).map((w) => String(w).toUpperCase()))
    .has(h.ticker.toUpperCase());
  let rel = 0.4 + 0.6 * Math.min(1.0, weightInPlan / 0.5);
  if (onWatchlist) rel = Math.max(rel, 0.9);
  return Math.min(1.0, rel);
}

const fmt1 = (x: number): string => pyFormat(x, 1);
const round2 = (x: number): number => pyRound(x, 2);

export function priceEvent(h: Holding, snap: PriceSnapshot, plan: Plan): DigestEvent | null {
  if (snap.change_pct_1d === null || snap.change_pct_1d === undefined) return null;
  const move = Math.abs(snap.change_pct_1d);
  if (move < plan.thresholds.price_move_pct) return null; // severity thresholding

  const exposureF = Math.min(1.0, h.portfolio_weight / 0.15);
  const severityF = Math.min(1.0, move / 10.0);
  const planF = planRelevance(h, plan);
  const timeF = snap.stale ? 0.5 : 1.0;

  const score = clamp(W_EXPOSURE * exposureF + W_SEVERITY * severityF + W_PLAN * planF + W_TIME * timeF);
  const direction = snap.change_pct_1d > 0 ? "up" : "down";
  const staleNote = snap.stale ? " (cached/stale price)" : "";
  return {
    ticker: h.ticker,
    kind: "price_move",
    severity: severityLabel(score),
    urgency: round2(score),
    headline: `${h.ticker} ${direction} ${fmt1(move)}% on the day`,
    explanation:
      `${h.name || h.ticker} is ${fmt1(h.portfolio_weight * 100)}% of your portfolio; ` +
      `a ${fmt1(move)}% ${direction} move${staleNote} therefore moves real capital you hold.`,
    url: "",
  };
}

export function newsEvent(h: Holding, item: NewsItem, plan: Plan): DigestEvent | null {
  const onWatchlist = new Set((plan.watchlist ?? []).map((w) => String(w).toUpperCase()))
    .has(h.ticker.toUpperCase());
  const severityF = newsSeverityFactor(item.title);

  // Severity gate: generic chatter about a stock you happen to own is NOT news.
  if (severityF < 0.5 && !onWatchlist) return null;

  // For news, severity leads and exposure modulates (capped) so a big holding
  // can't flood the digest.
  const exposureF = Math.min(0.6, h.portfolio_weight / 0.25);
  const planF = planRelevance(h, plan);
  const timeF = 1.0;

  const score = clamp(W_EXPOSURE * exposureF + W_SEVERITY * severityF + W_PLAN * planF + W_TIME * timeF);
  return {
    ticker: h.ticker,
    kind: "news",
    severity: severityLabel(score),
    urgency: round2(score),
    headline: item.title,
    explanation:
      `Concerns ${h.name || h.ticker} (${fmt1(h.portfolio_weight * 100)}% of your portfolio, ` +
      `tagged '${h.strategy_tag || h.type}'). Surfaced because it intersects a position you hold.`,
    url: item.url,
  };
}

// Watchlist items are things you're actively considering, so they get a baseline
// of attention even without portfolio exposure.
export const WATCHLIST_INTEREST_BASE = 3.0;

export function watchlistEvent(subj: Subject, item: NewsItem, _plan: Plan): DigestEvent | null {
  const severityF = Math.max(newsSeverityFactor(item.title), 0.3); // never fully mute a watched name
  const score = clamp(WATCHLIST_INTEREST_BASE + 4.0 * severityF + 1.0);
  const kindWord = isTheme(subj) ? "theme" : "potential entry";
  return {
    ticker: subj.ticker || subj.name,
    kind: "watchlist",
    severity: severityLabel(score),
    urgency: round2(score),
    headline: item.title,
    explanation:
      `On your watchlist (${kindWord}), not yet owned. Surfaced because you asked to ` +
      `track ${subj.name} — this is discovery context for capital you might deploy.`,
    url: item.url,
  };
}
