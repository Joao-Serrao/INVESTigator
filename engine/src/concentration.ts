/** Port of engine/concentration.py — concentration & overlap analysis.
 *
 * Surfaces hidden single-name concentration (owned directly AND via ETFs), ETF
 * overlap, and region/sector tilt. Descriptive findings, never advice.
 */

import type { Exposure, Finding } from "./models.ts";
import type { LookThrough } from "./lookthrough.ts";
import { pyFormat } from "./round.ts";

// Tunable thresholds — explicit and transparent.
const SINGLE_NAME_NOTE = 0.03;
const SINGLE_NAME_WATCH = 0.05;
const HIDDEN_MIN = 0.02;
const OVERLAP_NOTE = 0.15;
const COUNTRY_NOTE = 0.50;
const SECTOR_NOTE = 0.25;

const f1 = (x: number) => pyFormat(x, 1);
const f0 = (x: number) => pyFormat(x, 0);

export function analyseConcentration(lt: LookThrough): Finding[] {
  return [...singleName(lt), ...hidden(lt), ...overlap(lt), ...geography(lt), ...sector(lt)];
}

function singleName(lt: LookThrough): Finding[] {
  const top = lt.by_name.filter((e) => e.weight > 0).slice(0, 5);
  if (top.length === 0) return [];
  const leader = top[0];
  const sev = leader.weight >= SINGLE_NAME_WATCH ? "watch"
    : leader.weight >= SINGLE_NAME_NOTE ? "note" : "info";
  const listing = top.map((e) => `${e.label} ${f1(e.weight * 100)}%`).join(", ");
  return [{
    kind: "concentration",
    title: `Top effective holdings: ${leader.label} at ${f1(leader.weight * 100)}%`,
    detail: `After looking through your ETFs, your largest single-name exposures are: ${listing}. ` +
      `This is your true company-level concentration, not what the ticker list suggests.`,
    severity: sev,
  }];
}

function hidden(lt: LookThrough): Finding[] {
  const items = lt.by_name
    .filter((e) => e.direct > 0 && e.via_etf > 0 && e.weight >= HIDDEN_MIN)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 4);
  return items.map((e) => ({
    kind: "concentration",
    title: `Hidden concentration in ${e.label}: ${f1(e.weight * 100)}% effective`,
    detail: `You hold ${e.label} both directly (${f1(e.direct * 100)}%) and inside your ETFs ` +
      `(${f1(e.via_etf * 100)}%). Your real exposure is ${f1(e.weight * 100)}% — more than the ` +
      `direct position alone implies.`,
    severity: e.weight >= SINGLE_NAME_WATCH ? "watch" : "note",
  }));
}

function overlap(lt: LookThrough): Finding[] {
  const out: Finding[] = [];
  const etfs = lt.etf_constituents;
  const names = Object.keys(etfs).sort();
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const a = names[i], b = names[j];
      const wa = etfs[a], wb = etfs[b];
      const common = Object.keys(wa).filter((t) => t in wb);
      if (common.length === 0) continue;
      const shared = common.reduce((acc, t) => acc + Math.min(wa[t], wb[t]), 0);
      if (shared >= OVERLAP_NOTE) {
        out.push({
          kind: "overlap",
          title: `${a} and ${b} overlap ~${f0(shared * 100)}%`,
          detail: `${a} and ${b} share roughly ${f0(shared * 100)}% of their holdings ` +
            `(${common.length} common names). Holding both gives you less diversification than ` +
            `two funds suggest — you're doubling down on the shared names.`,
          severity: "note",
        });
      }
    }
  }
  return out;
}

function geography(lt: LookThrough): Finding[] {
  const regions = lt.by_region.filter((e) => e.key !== "Unmapped ETF");
  const decoded = regions.reduce((a, e) => a + e.weight, 0);
  if (decoded <= 0) return [];
  const top = regions.reduce((m, e) => (e.weight > m.weight ? e : m), regions[0]);
  const share = top.weight / decoded;
  const reg3 = [...regions].sort((a, b) => b.weight - a.weight).slice(0, 3)
    .map((e) => `${e.label} ${f0(e.weight / decoded * 100)}%`).join(", ");
  const countries = lt.by_country.filter((e) => e.key !== "Unmapped ETF");
  const cTotal = countries.reduce((a, e) => a + e.weight, 0);
  const cty3 = countries.length
    ? [...countries].sort((a, b) => b.weight - a.weight).slice(0, 3)
        .map((e) => `${e.label} ${f0(e.weight / cTotal * 100)}%`).join(", ")
    : "";
  return [{
    kind: "region",
    title: `Regional tilt: ${top.label} ${f0(share * 100)}% of decoded exposure`,
    detail: `By region: ${reg3}.` + (cty3 ? ` Top countries: ${cty3}.` : "") +
      ` A regional event (e.g. across Europe or Asia) hits every name in that bloc, ` +
      `so this is your real geographic concentration.`,
    severity: share >= COUNTRY_NOTE ? "note" : "info",
  }];
}

function sector(lt: LookThrough): Finding[] {
  const sec = lt.by_sector.filter((e) => e.key !== "Unmapped ETF");
  const decoded = sec.reduce((a, e) => a + e.weight, 0);
  if (decoded <= 0) return [];
  const top = sec.reduce((m, e) => (e.weight > m.weight ? e : m), sec[0]);
  const share = top.weight / decoded;
  const top3 = [...sec].sort((a, b) => b.weight - a.weight).slice(0, 3)
    .map((e) => `${e.label} ${f0(e.weight / decoded * 100)}%`).join(", ");
  return [{
    kind: "sector",
    title: `Sector tilt: ${top.label} ${f0(share * 100)}% of decoded exposure`,
    detail: `Your largest sector exposures are ${top3}. Worth knowing when a sector-specific event hits.`,
    severity: share >= SECTOR_NOTE ? "note" : "info",
  }];
}

export type { Exposure };
