/** Port of engine/weights.py — portfolio weighting by current (price-adjusted) value.
 *
 * Amounts are OPTIONAL:
 *   - no amounts at all    -> equal weight
 *   - some amounts missing -> missing ones get the average of the provided ones
 *   - all amounts present  -> weight strictly by value
 */

import type { Holding } from "./models.ts";
import { holdingKey } from "./models.ts";
import { effectiveValue } from "./valuation.ts";

export interface WeightResult {
  total_eur: number;
  amounts_given: boolean;
}

export function computeWeights(holdings: Holding[]): WeightResult {
  if (holdings.length === 0) return { total_eur: 0, amounts_given: false };

  const provided = holdings
    .filter((h) => h.amount_invested_eur > 0)
    .map((h) => effectiveValue(h));

  if (provided.length === 0) {
    // Nothing quantified — equal weight so a position still carries exposure signal.
    for (const h of holdings) h.portfolio_weight = 1 / holdings.length;
    return { total_eur: 0, amounts_given: false };
  }

  // Fill gaps with the average of what was provided, so unquantified positions
  // remain visible rather than silently weighting to zero.
  const avg = provided.reduce((a, b) => a + b, 0) / provided.length;
  const effective: Record<string, number> = {};
  for (const h of holdings) {
    effective[holdingKey(h)] = h.amount_invested_eur > 0 ? effectiveValue(h) : avg;
  }
  const total = Object.values(effective).reduce((a, b) => a + b, 0);
  for (const h of holdings) {
    h.portfolio_weight = total ? effective[holdingKey(h)] / total : 0;
  }
  return { total_eur: provided.reduce((a, b) => a + b, 0), amounts_given: true };
}
