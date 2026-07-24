/** Port of engine/plan_align.py — actual allocation vs the user's stated plan.
 *
 * Alignment detection only; never advice.
 */

import type { Finding, Holding, Plan } from "./models.ts";
import { pyFormat, pyThousands } from "./round.ts";

const DRIFT_NOTE = 0.05;  // 5 percentage points
const DRIFT_WATCH = 0.10; // 10 percentage points

const LABELS: Record<string, string> = {
  etf: "ETFs",
  growth_stock: "Growth stocks",
  experimental: "Experimental",
  equity: "Other equities",
};

function label(key: string): string {
  if (key in LABELS) return LABELS[key];
  // Python: key.replace("_", " ").title()
  return key.replaceAll("_", " ").replace(/\w\S*/g, (w) =>
    w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

const f0 = (x: number): string => pyFormat(x, 0);
const fThousands = (x: number): string => pyThousands(x);

export function analysePlan(holdings: Holding[], plan: Plan): Finding[] {
  const targets = plan.allocation_targets ?? {};
  if (Object.keys(targets).length === 0 || holdings.length === 0) return [];

  const current: Record<string, number> = {};
  for (const h of holdings) current[h.type] = (current[h.type] ?? 0) + h.portfolio_weight;

  const findings: Finding[] = [];
  const buckets = new Set([...Object.keys(targets), ...Object.keys(current)]);
  const drifts: Array<[string, number, number, number]> = [];
  for (const b of buckets) {
    const cur = current[b] ?? 0;
    const tgt = targets[b] ?? 0;
    drifts.push([b, cur, tgt, cur - tgt]);
  }

  // Headline: overall alignment across known plan buckets.
  const summary = Object.keys(targets)
    .map((b) => `${label(b)} ${f0((current[b] ?? 0) * 100)}% (target ${f0(targets[b] * 100)}%)`)
    .join("; ");
  findings.push({
    kind: "plan_drift",
    title: "Allocation vs plan",
    detail: `Current vs target: ${summary}.`,
    severity: "info",
  });

  // Individual drifts worth flagging.
  drifts.sort((a, b) => Math.abs(b[3]) - Math.abs(a[3]));
  for (const [b, cur, tgt, drift] of drifts) {
    if (!(b in targets)) {
      if (cur >= DRIFT_NOTE) {
        findings.push({
          kind: "plan_drift",
          title: `${label(b)} sits outside your plan (${f0(cur * 100)}%)`,
          detail: `${f0(cur * 100)}% of your portfolio is in '${label(b)}', which isn't a bucket in ` +
            `your allocation plan. Either it's intentional or your plan needs updating.`,
          severity: "note",
        });
      }
      continue;
    }
    if (Math.abs(drift) < DRIFT_NOTE) continue;
    const over = drift > 0;
    const tail = !over && plan.monthly_contribution_eur
      ? `Your €${fThousands(plan.monthly_contribution_eur)}/month could be steered toward ` +
        `under-weight buckets if you want to track the plan.`
      : "Worth knowing when you deploy your next contribution.";
    findings.push({
      kind: "plan_drift",
      title: `${label(b)} is ${over ? "over" : "under"} target by ${f0(Math.abs(drift) * 100)}pp`,
      detail: `${label(b)} is ${f0(cur * 100)}% vs your ${f0(tgt * 100)}% target ` +
        `(${over ? "+" : ""}${f0(drift * 100)}pp). ` + tail,
      severity: Math.abs(drift) >= DRIFT_WATCH ? "watch" : "note",
    });
  }
  return findings;
}
