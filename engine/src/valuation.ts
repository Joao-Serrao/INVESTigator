/** Port of engine/valuation.py — estimate each holding's current value from price movement.
 *
 * current_value = amount * (price_now / price_when_you_set_it)
 *
 * A ratio, so it's currency-agnostic and needs no share count. Re-entering the
 * amount resets the reference point.
 *
 * The Python version reads/writes the basis through the store; here the basis is
 * passed in and any update is returned, keeping the function pure and testable.
 */

import type { Holding, PriceSnapshot } from "./models.ts";
import { holdingKey } from "./models.ts";
import { pyRound } from "./round.ts";

export interface ValueBasis {
  basis_price: number;
  basis_amount: number;
}

export type BasisMap = Record<string, ValueBasis>;

/** Basis rows that changed and must be persisted. */
export type BasisUpdates = Record<string, ValueBasis>;

export function applyCurrentValues(
  holdings: Holding[],
  prices: Record<string, PriceSnapshot>,
  basis: BasisMap,
): BasisUpdates {
  const updates: BasisUpdates = {};
  for (const h of holdings) {
    const amount = h.amount_invested_eur;
    if (amount <= 0) {
      h.current_value = 0;
      continue;
    }
    const snap = prices[holdingKey(h)];
    const price = snap && snap.price ? snap.price : null;
    if (!price) {
      h.current_value = amount; // no price -> fall back to entered amount
      continue;
    }
    const b = basis[holdingKey(h)];
    if (!b || Math.abs(b.basis_amount - amount) > 0.01 || b.basis_price <= 0) {
      // New position, or the user re-entered the amount -> reset the reference.
      updates[holdingKey(h)] = { basis_price: price, basis_amount: amount };
      h.current_value = round2(amount);
    } else {
      h.current_value = round2(amount * (price / b.basis_price));
    }
  }
  return updates;
}

/** The value to use for weighting/display: price-adjusted if known, else entered. */
export const effectiveValue = (h: Holding): number =>
  h.current_value > 0 ? h.current_value : h.amount_invested_eur;

/** Python's round(x, 2) — banker's rounding; see src/round.ts. */
export const round2 = (x: number): number => pyRound(x, 2);
