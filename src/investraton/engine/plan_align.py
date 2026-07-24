"""Plan-alignment: compare the portfolio's actual shape to the user's stated plan.

This is the differentiator from the original design — it lets the system say
"your growth bucket is running hot vs your 15% target" or "semis weakness lands in
a bucket you're underweight", purely as *alignment detection*. Never advice.
"""

from __future__ import annotations

from collections import defaultdict

from ..config import Plan
from ..models import Finding, Holding

DRIFT_NOTE = 0.05   # 5 percentage points
DRIFT_WATCH = 0.10  # 10 percentage points

# Friendly labels for plan buckets / holding types.
_LABELS = {
    "etf": "ETFs",
    "growth_stock": "Growth stocks",
    "experimental": "Experimental",
    "equity": "Other equities",
}


def _label(key: str) -> str:
    return _LABELS.get(key, key.replace("_", " ").title())


def analyse_plan(holdings: list[Holding], plan: Plan) -> list[Finding]:
    targets = plan.allocation_targets or {}
    if not targets or not holdings:
        return []

    current: dict[str, float] = defaultdict(float)
    for h in holdings:
        current[h.type] += h.portfolio_weight

    findings: list[Finding] = []
    buckets = set(targets) | set(current)
    drifts = []
    for b in buckets:
        cur = current.get(b, 0.0)
        tgt = targets.get(b, 0.0)
        drifts.append((b, cur, tgt, cur - tgt))

    # Headline: overall alignment summary across known plan buckets.
    summary = "; ".join(
        f"{_label(b)} {current.get(b,0)*100:.0f}% (target {targets[b]*100:.0f}%)"
        for b in targets
    )
    findings.append(Finding(
        kind="plan_drift",
        title="Allocation vs plan",
        detail=f"Current vs target: {summary}.",
        severity="info",
    ))

    # Individual drifts worth flagging.
    for b, cur, tgt, drift in sorted(drifts, key=lambda x: abs(x[3]), reverse=True):
        if b not in targets:
            if cur >= DRIFT_NOTE:
                findings.append(Finding(
                    kind="plan_drift",
                    title=f"{_label(b)} sits outside your plan ({cur*100:.0f}%)",
                    detail=f"{cur*100:.0f}% of your portfolio is in '{_label(b)}', which isn't a bucket in your "
                           f"allocation plan. Either it's intentional or your plan needs updating.",
                    severity="note",
                ))
            continue
        if abs(drift) < DRIFT_NOTE:
            continue
        over = drift > 0
        findings.append(Finding(
            kind="plan_drift",
            title=f"{_label(b)} is {'over' if over else 'under'} target by {abs(drift)*100:.0f}pp",
            detail=f"{_label(b)} is {cur*100:.0f}% vs your {tgt*100:.0f}% target "
                   f"({'+' if over else ''}{drift*100:.0f}pp). "
                   + (f"Your €{plan.monthly_contribution_eur:,.0f}/month could be steered toward "
                      f"under-weight buckets if you want to track the plan."
                      if not over and plan.monthly_contribution_eur else
                      "Worth knowing when you deploy your next contribution."),
            severity="watch" if abs(drift) >= DRIFT_WATCH else "note",
        ))
    return findings
