"""Portfolio weighting. The invested amount is the value proxy (no live
revaluation yet — that arrives with reliable FX + price coverage in v1).

Amounts are OPTIONAL: you enter what you hold, and *optionally* how much. So this
degrades sensibly:
  - no amounts at all   -> equal weight (so exposure-based scoring still works),
  - some amounts missing -> missing ones get the average of the provided ones,
  - all amounts present  -> weight strictly by amount.
"""

from __future__ import annotations

from ..models import Holding
from .valuation import effective_value


def compute_weights(holdings: list[Holding]) -> tuple[float, bool]:
    """Fill in `portfolio_weight` on each holding in place, using each position's
    current (price-adjusted) value when available, else the entered amount.

    Returns (total_eur, amounts_were_given). `amounts_were_given` is False when no
    holding had an amount, so callers can label the portfolio total as nominal.
    """
    if not holdings:
        return 0.0, False

    provided = [effective_value(h) for h in holdings if h.amount_invested_eur > 0]
    if not provided:
        # Nothing quantified — equal weight so a position still carries exposure signal.
        for h in holdings:
            h.portfolio_weight = 1.0 / len(holdings)
        return 0.0, False

    # Fill gaps with the average of what was provided, so unquantified positions
    # remain visible rather than silently weighting to zero.
    avg = sum(provided) / len(provided)
    effective = {h.key: (effective_value(h) if h.amount_invested_eur > 0 else avg) for h in holdings}
    total = sum(effective.values())
    for h in holdings:
        h.portfolio_weight = effective[h.key] / total if total else 0.0
    return sum(provided), True
