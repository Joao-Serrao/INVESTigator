"""CLI entry point.  Run: python -m investraton <command>

Commands:
  digest            Run the full loop and deliver the digest (default: weekly).
  digest --dry-run  Build the digest but don't deliver or mark items as reported.
  holdings          Print the merged holdings + computed weights and exit.
  structure         Print ETF look-through, concentration/overlap, and plan drift.
  doctor            Report which data sources / LLM / delivery channels are usable.
"""

from __future__ import annotations

import argparse
import logging
import sys


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="investraton")
    sub = parser.add_subparsers(dest="command")

    p_digest = sub.add_parser("digest", help="Run the loop and deliver a digest.")
    p_digest.add_argument("--period", default="weekly")
    p_digest.add_argument("--dry-run", action="store_true", help="Build but don't deliver/record.")

    sub.add_parser("holdings", help="Show holdings + computed weights.")
    p_struct = sub.add_parser("structure", help="Show look-through, concentration, plan drift.")
    p_struct.add_argument("--top", type=int, default=12, help="How many effective holdings to list.")
    sub.add_parser("app", help="Launch the local web app (http://127.0.0.1:8765).")

    p_run = sub.add_parser("run-schedule", help="Run one saved schedule now (used by Task Scheduler).")
    p_run.add_argument("id")
    p_run.add_argument("--no-deliver", action="store_true")
    p_sched = sub.add_parser("schedules", help="List or sync scheduled digests.")
    p_sched.add_argument("action", nargs="?", default="list", choices=["list", "sync"])

    sub.add_parser("doctor", help="Check which sources/LLM/delivery are configured.")

    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.INFO if args.verbose else logging.WARNING,
        format="%(levelname)s %(name)s: %(message)s",
    )

    if args.command == "holdings":
        return _cmd_holdings()
    if args.command == "structure":
        return _cmd_structure(args.top)
    if args.command == "app":
        from .api import main as app_main

        app_main()
        return 0
    if args.command == "run-schedule":
        from .scheduler import run_schedule

        digest = run_schedule(args.id, deliver=not args.no_deliver)
        print(f"Ran schedule {args.id}: {len(digest.events)} events, {len(digest.watchlist)} watchlist.")
        return 0
    if args.command == "schedules":
        return _cmd_schedules(args.action)
    if args.command == "doctor":
        return _cmd_doctor()
    if args.command == "digest" or args.command is None:
        period = getattr(args, "period", "weekly")
        dry = getattr(args, "dry_run", False)
        from .pipeline import run_digest

        digest = run_digest(period=period, deliver_output=not dry)
        if dry:
            print(digest.narrative)
        return 0

    parser.print_help()
    return 1


def _cmd_holdings() -> int:
    from .config import load_plan, load_settings
    from .engine.weights import compute_weights
    from .ingest.holdings import load_all_holdings

    settings = load_settings()
    plan = load_plan()
    holdings, notes = load_all_holdings(settings, plan)
    total, amounts_given = compute_weights(holdings)
    print(f"Sources: {'; '.join(notes)}")
    if amounts_given:
        print(f"Total invested (basis): €{total:,.2f}\n")
    else:
        print("Invested amounts not provided — showing equal weights.\n")
    print(f"{'TICKER':<12}{'WEIGHT':>8}  {'EUR':>12}  {'TYPE':<14}{'SRC':<8}NAME")
    for h in sorted(holdings, key=lambda x: x.portfolio_weight, reverse=True):
        print(
            f"{h.ticker:<12}{h.portfolio_weight*100:>7.1f}%  "
            f"{h.amount_invested_eur:>12,.0f}  {h.type:<14}{h.source:<8}{h.name}"
        )
    return 0


def _cmd_structure(top: int) -> int:
    from .config import load_plan, load_settings
    from .engine.weights import compute_weights
    from .ingest.holdings import load_all_holdings
    from .pipeline import analyse_structure

    settings = load_settings()
    plan = load_plan()
    holdings, _ = load_all_holdings(settings, plan)
    if not holdings:
        print("No holdings. Add positions to data/holdings.csv first.")
        return 1
    compute_weights(holdings)
    findings, lt = analyse_structure(holdings, plan)

    print(f"Look-through coverage: {lt.coverage*100:.0f}% of portfolio "
          f"({len(lt.opaque)} opaque ETF(s))")
    if lt.as_of:
        print("ETF data as of: " + ", ".join(f"{k} {v}" for k, v in lt.as_of.items()))
    if lt.opaque:
        print("Opaque (no free holdings feed): "
              + ", ".join(f"{lbl} {w*100:.0f}%" for lbl, w in lt.opaque))

    print("\n— Effective single-name exposure (after ETF look-through) —")
    for e in lt.by_name[:top]:
        print(f"  {e.weight*100:6.2f}%  {e.label[:34]:<34} ({e.detail})")

    print("\n— By region —")
    for e in lt.by_region[:7]:
        print(f"  {e.weight*100:6.2f}%  {e.label}")
    print("\n— By country —")
    for e in lt.by_country[:6]:
        print(f"  {e.weight*100:6.2f}%  {e.label}")
    print("\n— By sector —")
    for e in lt.by_sector[:6]:
        print(f"  {e.weight*100:6.2f}%  {e.label}")

    print("\n— Findings —")
    for f in findings:
        print(f"  [{f.severity}] {f.title}")
    return 0


def _cmd_schedules(action: str) -> int:
    from .scheduler import load_schedules, sync_windows_tasks

    if action == "sync":
        res = sync_windows_tasks()
        print("Synced to Windows Task Scheduler:" if res.get("ok") else "Sync had issues:")
        for r in res.get("results", []):
            print(f"  [{'ok' if r['ok'] else 'FAIL'}] {r['name']} ({r['id']}) — {r['detail']}")
        if res.get("error"):
            print("  " + res["error"])
        return 0
    schedules = load_schedules()
    if not schedules:
        print("No schedules yet. Create them in the app (Schedules tab).")
        return 0
    for s in schedules:
        state = "on" if s.get("enabled", True) else "off"
        print(f"  [{state}] {s['name']} — {s['frequency']} @ {s.get('time')} · "
              f"{s['complexity']} · focus={s['focus']} · id={s['id']}")
    return 0


def _cmd_doctor() -> int:
    from .config import load_settings

    s = load_settings()
    print("Investraton doctor\n------------------")
    print(f"DB path:        {s.db_path}")
    print(f"Holdings CSV:   {s.holdings_csv}  {'(found)' if s.holdings_csv.exists() else '(MISSING)'}")
    print(f"LLM provider:   {s.llm_provider}")
    if s.llm_provider == "claude":
        print(f"  Claude key:   {'set' if s.anthropic_api_key else 'MISSING'}")
    if s.llm_provider == "ollama":
        print(f"  Ollama:       {s.ollama_host} / {s.ollama_model}")
    print(f"Delivery:       {', '.join(s.delivery)}")
    print(f"  Discord URL:  {'set' if s.discord_webhook_url else 'not set'}")
    print(f"  SMTP host:    {s.smtp.get('host') or 'not set'}")
    for dep in ("yfinance", "feedparser", "yaml", "requests", "dotenv"):
        try:
            __import__(dep)
            print(f"dep {dep:<12} OK")
        except ImportError:
            print(f"dep {dep:<12} MISSING")
    return 0


if __name__ == "__main__":
    sys.exit(main())
