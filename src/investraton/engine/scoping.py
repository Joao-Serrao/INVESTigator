"""Digest scoping: complexity presets and focus selection.

A digest run can be tuned along two axes (used by manual runs and schedules):

- complexity: how much filtering + how rich the output.
    simple   -> only the clearly-relevant items, no structure section.
    standard -> the default balance.
    complex  -> more items + full structure analysis.
    urgent   -> only high-urgency items (alerts), nothing else.
    none     -> no filtering, show (almost) everything.

- focus: which subjects to include.
    all       -> holdings + watchlist.
    invested  -> holdings only.
    watchlist -> watchlist only (discovery mode).
    group:<x> -> holdings whose strategy_tag or type == x.
"""

from __future__ import annotations

from dataclasses import dataclass

from ..models import Holding, Subject


@dataclass
class Complexity:
    min_urgency: float
    max_per_subject: int
    max_total: int
    include_structure: bool
    include_watchlist: bool
    label: str


COMPLEXITY_PRESETS: dict[str, Complexity] = {
    "simple":   Complexity(4.0, 2, 8, False, True, "Simple"),
    "standard": Complexity(2.0, 3, 15, True, True, "Standard"),
    "complex":  Complexity(1.0, 5, 30, True, True, "Complex"),
    "urgent":   Complexity(6.5, 2, 10, False, False, "Urgent only"),
    "none":     Complexity(0.0, 50, 200, True, True, "No filtering"),
}


def get_complexity(name: str, plan_min_urgency: float) -> Complexity:
    preset = COMPLEXITY_PRESETS.get((name or "standard").lower())
    if preset is None:
        preset = COMPLEXITY_PRESETS["standard"]
    # The plan's own threshold acts as a floor for 'standard' so user tuning still bites.
    if name in (None, "", "standard"):
        preset = Complexity(max(preset.min_urgency, plan_min_urgency), preset.max_per_subject,
                            preset.max_total, preset.include_structure, preset.include_watchlist,
                            preset.label)
    return preset


def build_subjects(holdings: list[Holding], watchlist: list[str], focus: str) -> list[Subject]:
    """Turn holdings + watchlist into the Subject set selected by `focus`."""
    focus = (focus or "all").lower()
    owned = [
        Subject(name=h.name or h.ticker, ticker=h.ticker, owned=True, weight=h.portfolio_weight,
                strategy_tag=h.strategy_tag, type=h.type)
        for h in holdings
    ]
    owned_keys = {s.key for s in owned}
    watch = []
    for w in watchlist or []:
        w = str(w).strip()
        if not w:
            continue
        is_ticker = _looks_like_ticker(w)
        name = w.replace("_", " ") if not is_ticker else w
        subj = Subject(name=name, ticker=w if is_ticker else "", owned=False, type="watchlist")
        if subj.key in owned_keys:
            continue  # already owned; the holdings path covers it
        watch.append(subj)

    if focus == "invested":
        return owned
    if focus == "watchlist":
        return watch
    if focus.startswith("group:"):
        tag = focus.split(":", 1)[1].strip().lower()
        return [s for s in owned if tag in (s.strategy_tag.lower(), s.type.lower())]
    return owned + watch


def _looks_like_ticker(s: str) -> bool:
    # Heuristic: short, no spaces, mostly upper/dot/digits -> treat as a ticker.
    if " " in s or "_" in s:
        return False
    core = s.replace(".", "").replace("-", "")
    return len(s) <= 6 and core.isalnum() and core.upper() == core
