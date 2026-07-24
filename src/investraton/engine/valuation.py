"""Estimate each holding's *current* value from price movement.

You enter an amount (your best estimate of value). We remember the price at that
moment, then scale the amount by how the price has moved since:

    current_value = amount * (price_now / price_when_you_set_it)

This is a ratio, so it's currency-agnostic (no FX needed) and works without knowing
your share count. It's an estimate, not your broker's exact figure — when it drifts
too far you just re-enter the amount, which resets the reference point.
"""

from __future__ import annotations

from ..models import Holding, PriceSnapshot
from ..store import Store


def apply_current_values(holdings: list[Holding], prices: dict[str, PriceSnapshot], store: Store) -> None:
    """Fill each holding's `current_value` in place, updating the stored basis when a
    position is new or its amount was edited."""
    for h in holdings:
        amount = h.amount_invested_eur
        if amount <= 0:
            h.current_value = 0.0
            continue
        snap = prices.get(h.key)
        price = snap.price if snap and snap.price else None
        if not price:
            h.current_value = amount  # no price -> fall back to entered amount
            continue
        basis = store.get_value_basis(h.key)
        if basis is None or abs(basis[1] - amount) > 0.01 or basis[0] <= 0:
            # New position, or the user re-entered the amount -> reset the reference.
            store.set_value_basis(h.key, price, amount)
            h.current_value = round(amount, 2)
        else:
            h.current_value = round(amount * (price / basis[0]), 2)


def effective_value(h: Holding) -> float:
    """The value to use for weighting/display: price-adjusted if known, else entered."""
    return h.current_value if h.current_value > 0 else h.amount_invested_eur
