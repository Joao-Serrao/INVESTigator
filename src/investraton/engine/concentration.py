"""Concentration & overlap analysis on top of look-through exposure.

Surfaces the things the plan called out: hidden single-name concentration (you own
a stock directly AND via your ETFs), ETF overlap (two funds holding the same
names), and region/sector concentration. Produces Findings — descriptive, with
why-it-matters context, never advice.
"""

from __future__ import annotations

from itertools import combinations

from ..models import Finding
from .lookthrough import LookThrough

# Tunable thresholds (kept here, explicit and transparent).
SINGLE_NAME_NOTE = 0.03      # effective weight that's worth a mention
SINGLE_NAME_WATCH = 0.05     # effective weight worth a stronger flag
HIDDEN_MIN = 0.02            # min combined weight to flag direct+ETF overlap of one name
OVERLAP_NOTE = 0.15          # ETF-vs-ETF shared fraction worth mentioning
COUNTRY_NOTE = 0.50          # top-country share worth a mention
SECTOR_NOTE = 0.25           # top-sector share worth a mention


def analyse_concentration(lt: LookThrough) -> list[Finding]:
    findings: list[Finding] = []
    findings += _single_name(lt)
    findings += _hidden(lt)
    findings += _overlap(lt)
    findings += _geography(lt)
    findings += _sector(lt)
    return findings


def _single_name(lt: LookThrough) -> list[Finding]:
    top = [e for e in lt.by_name if e.weight > 0][:5]
    if not top:
        return []
    leader = top[0]
    sev = "watch" if leader.weight >= SINGLE_NAME_WATCH else ("note" if leader.weight >= SINGLE_NAME_NOTE else "info")
    listing = ", ".join(f"{e.label} {e.weight*100:.1f}%" for e in top)
    return [Finding(
        kind="concentration",
        title=f"Top effective holdings: {leader.label} at {leader.weight*100:.1f}%",
        detail=f"After looking through your ETFs, your largest single-name exposures are: {listing}. "
               f"This is your true company-level concentration, not what the ticker list suggests.",
        severity=sev,
    )]


def _hidden(lt: LookThrough) -> list[Finding]:
    hidden = [e for e in lt.by_name if e.direct > 0 and e.via_etf > 0 and e.weight >= HIDDEN_MIN]
    hidden.sort(key=lambda e: e.weight, reverse=True)
    out = []
    for e in hidden[:4]:
        out.append(Finding(
            kind="concentration",
            title=f"Hidden concentration in {e.label}: {e.weight*100:.1f}% effective",
            detail=f"You hold {e.label} both directly ({e.direct*100:.1f}%) and inside your ETFs "
                   f"({e.via_etf*100:.1f}%). Your real exposure is {e.weight*100:.1f}% — more than the "
                   f"direct position alone implies.",
            severity="watch" if e.weight >= SINGLE_NAME_WATCH else "note",
        ))
    return out


def _overlap(lt: LookThrough) -> list[Finding]:
    out = []
    etfs = lt.etf_constituents
    for a, b in combinations(sorted(etfs), 2):
        wa, wb = etfs[a], etfs[b]
        common = set(wa) & set(wb)
        if not common:
            continue
        shared = sum(min(wa[t], wb[t]) for t in common)
        if shared >= OVERLAP_NOTE:
            out.append(Finding(
                kind="overlap",
                title=f"{a} and {b} overlap ~{shared*100:.0f}%",
                detail=f"{a} and {b} share roughly {shared*100:.0f}% of their holdings ({len(common)} common "
                       f"names). Holding both gives you less diversification than two funds suggest — you're "
                       f"doubling down on the shared names.",
                severity="note",
            ))
    return out


def _geography(lt: LookThrough) -> list[Finding]:
    regions = [e for e in lt.by_region if e.key not in ("Unmapped ETF",)]
    decoded = sum(e.weight for e in regions)
    if decoded <= 0:
        return []
    top = max(regions, key=lambda e: e.weight)
    share = top.weight / decoded
    reg3 = ", ".join(f"{e.label} {e.weight/decoded*100:.0f}%"
                     for e in sorted(regions, key=lambda e: e.weight, reverse=True)[:3])
    countries = [e for e in lt.by_country if e.key not in ("Unmapped ETF",)]
    cty3 = ", ".join(f"{e.label} {e.weight/sum(c.weight for c in countries)*100:.0f}%"
                     for e in sorted(countries, key=lambda e: e.weight, reverse=True)[:3]) if countries else ""
    sev = "note" if share >= COUNTRY_NOTE else "info"
    return [Finding(
        kind="region",
        title=f"Regional tilt: {top.label} {share*100:.0f}% of decoded exposure",
        detail=f"By region: {reg3}." + (f" Top countries: {cty3}." if cty3 else "")
               + " A regional event (e.g. across Europe or Asia) hits every name in that bloc, "
                 "so this is your real geographic concentration.",
        severity=sev,
    )]


def _sector(lt: LookThrough) -> list[Finding]:
    sec = [e for e in lt.by_sector if e.key not in ("Unmapped ETF",)]
    decoded = sum(e.weight for e in sec)
    if decoded <= 0:
        return []
    top = max(sec, key=lambda e: e.weight)
    share = top.weight / decoded
    top3 = ", ".join(f"{e.label} {e.weight/decoded*100:.0f}%" for e in sorted(sec, key=lambda e: e.weight, reverse=True)[:3])
    sev = "note" if share >= SECTOR_NOTE else "info"
    return [Finding(
        kind="sector",
        title=f"Sector tilt: {top.label} {share*100:.0f}% of decoded exposure",
        detail=f"Your largest sector exposures are {top3}. Worth knowing when a sector-specific event hits.",
        severity=sev,
    )]
