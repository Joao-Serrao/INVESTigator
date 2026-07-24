/** Port of engine/lookthrough.py — effective exposure after decomposing ETFs.
 *
 * Turns "25% IWDA + 16% AAPL" into "3.x% effective AAPL once the ETF is decoded".
 * All deterministic; this module does the arithmetic so the LLM never has to.
 */

import type { ETFComposition, Exposure, Holding } from "./models.ts";
import { holdingKey } from "./models.ts";

export interface LookThrough {
  by_name: Exposure[];
  by_sector: Exposure[];
  by_country: Exposure[];
  by_region: Exposure[];
  /** fraction of the portfolio successfully decomposed */
  coverage: number;
  opaque: Array<[string, number]>;
  /** etf base ticker -> { constituent ticker: weight } */
  etf_constituents: Record<string, Record<string, number>>;
  as_of: Record<string, string>;
}

/** Strip an exchange suffix: IWDA.AS -> IWDA */
export const baseTicker = (t: string): string => t.toUpperCase().split(".")[0];

const isEtf = (h: Holding): boolean => h.type.toLowerCase() === "etf";

/** Disambiguate same-ticker-different-market collisions (e.g. "2330"). */
const nameKey = (ticker: string, country: string): string =>
  `${ticker.toUpperCase()}|${(country || "").toUpperCase()}`;

/** Country -> region/continent, so a bloc-level event can be flagged. */
const REGION: Record<string, string> = {
  "united states": "North America", canada: "North America",
  "united kingdom": "Europe", france: "Europe", germany: "Europe", switzerland: "Europe",
  netherlands: "Europe", sweden: "Europe", italy: "Europe", spain: "Europe",
  denmark: "Europe", finland: "Europe", belgium: "Europe", norway: "Europe",
  ireland: "Europe", austria: "Europe", portugal: "Europe", luxembourg: "Europe",
  poland: "Europe", greece: "Europe",
  japan: "Developed Asia-Pacific", australia: "Developed Asia-Pacific",
  "hong kong": "Developed Asia-Pacific", singapore: "Developed Asia-Pacific",
  "new zealand": "Developed Asia-Pacific",
  china: "Emerging Asia", taiwan: "Emerging Asia", "korea (south)": "Emerging Asia",
  "south korea": "Emerging Asia", india: "Emerging Asia", indonesia: "Emerging Asia",
  thailand: "Emerging Asia", malaysia: "Emerging Asia", philippines: "Emerging Asia",
  vietnam: "Emerging Asia", pakistan: "Emerging Asia",
  brazil: "Latin America", mexico: "Latin America", chile: "Latin America",
  colombia: "Latin America", peru: "Latin America", argentina: "Latin America",
  "saudi arabia": "Middle East & Africa", "united arab emirates": "Middle East & Africa",
  qatar: "Middle East & Africa", kuwait: "Middle East & Africa", israel: "Middle East & Africa",
  "south africa": "Middle East & Africa", egypt: "Middle East & Africa", turkey: "Middle East & Africa",
  nigeria: "Middle East & Africa", bahrain: "Middle East & Africa", oman: "Middle East & Africa",
};

export const regionOf = (country: string): string =>
  REGION[(country || "").trim().toLowerCase()] ?? "Other";

export type GetComposition = (ticker: string, isin: string) => ETFComposition | null;

export function computeLookthrough(holdings: Holding[], getComp: GetComposition): LookThrough {
  const byName: Record<string, [number, number]> = {}; // key -> [direct, viaEtf]
  const label: Record<string, string> = {};
  const bySector: Record<string, number> = {};
  const byCountry: Record<string, number> = {};
  const byRegion: Record<string, number> = {};
  // ticker -> [sector, country, name] borrowed from ETF constituents
  const secMaster: Record<string, [string, string, string]> = {};
  const opaque: Array<[string, number]> = [];
  const etfConstituents: Record<string, Record<string, number>> = {};
  const asOf: Record<string, string> = {};

  const add = (m: Record<string, number>, k: string, v: number) => { m[k] = (m[k] ?? 0) + v; };

  // Resolve compositions once, and build a security master so DIRECT stocks can
  // borrow sector/country from any ETF that contains them.
  const comps: Record<string, ETFComposition> = {};
  for (const h of holdings) {
    if (!isEtf(h)) continue;
    const comp = getComp(h.ticker, h.isin ?? "");
    if (!comp) continue;
    comps[holdingKey(h)] = comp;
    asOf[baseTicker(h.ticker)] = comp.as_of;
    for (const c of comp.constituents) {
      const t = c.ticker.toUpperCase();
      if (!(t in secMaster)) secMaster[t] = [c.sector, c.country, c.name];
    }
  }

  let covered = 0;
  for (const h of holdings) {
    const w = h.portfolio_weight;
    const comp = comps[holdingKey(h)];
    if (comp) {
      covered += w;
      const cons: Record<string, number> = {};
      for (const c of comp.constituents) cons[c.ticker.toUpperCase()] = c.weight;
      etfConstituents[baseTicker(h.ticker)] = cons;
      for (const c of comp.constituents) {
        const k = nameKey(c.ticker, c.country);
        if (!byName[k]) byName[k] = [0, 0];
        byName[k][1] += w * c.weight;
        label[k] = c.name || c.ticker;
        const sector = c.asset_class && c.asset_class !== "Equity"
          ? c.asset_class : (c.sector || "Unknown");
        add(bySector, sector, w * c.weight);
        add(byCountry, c.country || "Unknown", w * c.weight);
        add(byRegion, regionOf(c.country), w * c.weight);
      }
    } else if (isEtf(h)) {
      opaque.push([h.name || h.ticker, w]);
      add(bySector, "Unmapped ETF", w);
      add(byCountry, "Unmapped ETF", w);
      add(byRegion, "Unmapped ETF", w);
    } else {
      covered += w;
      const t = baseTicker(h.ticker);
      const [sector, country, nm] = secMaster[t] ?? ["Unknown", "Unknown", ""];
      const k = nameKey(t, country); // share the country key so direct+ETF merge
      if (!byName[k]) byName[k] = [0, 0];
      byName[k][0] += w;
      label[k] = h.name || nm || t;
      add(bySector, sector || "Unknown", w);
      add(byCountry, country || "Unknown", w);
      add(byRegion, regionOf(country), w);
    }
  }

  const nameExposures: Exposure[] = Object.entries(byName).map(([k, [direct, via]]) => ({
    key: k,
    label: label[k] ?? k,
    weight: direct + via,
    direct,
    via_etf: via,
    detail: splitDetail(direct, via),
  }));
  nameExposures.sort((a, b) => b.weight - a.weight);

  return {
    by_name: nameExposures,
    by_sector: decodedExposures(bySector),
    by_country: decodedExposures(byCountry),
    by_region: decodedExposures(byRegion),
    coverage: covered,
    opaque: opaque.sort((a, b) => b[1] - a[1]),
    etf_constituents: etfConstituents,
    as_of: asOf,
  };
}

/** Region/sector as a share of the DECODED portion: drop the opaque bucket and
 * renormalise to 100%, so bars stay consistent with the findings. */
function decodedExposures(d: Record<string, number>): Exposure[] {
  const items: Record<string, number> = {};
  for (const [k, v] of Object.entries(d)) if (k !== "Unmapped ETF") items[k] = v;
  const total = Object.values(items).reduce((a, b) => a + b, 0);
  const out: Exposure[] = Object.entries(items).map(([k, v]) => ({
    key: k, label: k, weight: total > 0 ? v / total : v,
    direct: 0, via_etf: 0, detail: "",
  }));
  out.sort((a, b) => b.weight - a.weight);
  return out;
}

function splitDetail(direct: number, via: number): string {
  if (direct > 0 && via > 0) {
    return `${(direct * 100).toFixed(1)}% direct + ${(via * 100).toFixed(1)}% via ETFs`;
  }
  if (direct > 0) return "held directly";
  return "via ETFs";
}
