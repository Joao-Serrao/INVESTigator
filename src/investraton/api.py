"""Local HTTP API exposing the engine to the app UI.

This is the bridge the Tauri shell wraps: the web frontend (served from /) calls
these JSON endpoints. The same FastAPI process serves the static UI, so in dev you
just run `python -m investraton.api` and open the browser.

Secrets stay local (single-user app on your machine). The /api/settings response
masks secret values so the UI never re-displays a stored key in clear text.
"""

from __future__ import annotations

import json
import logging
import sys
from dataclasses import asdict
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import __version__
from .config import (
    load_app_settings,
    load_plan,
    load_settings,
    save_app_settings,
    save_plan,
)
from .scheduler import (
    COMPLEXITIES,
    FREQUENCIES,
    delete_schedule,
    load_schedules,
    run_schedule,
    sync_windows_tasks,
    upsert_schedule,
)
from .engine.valuation import apply_current_values
from .engine.weights import compute_weights
from .ingest.holdings import load_all_holdings, save_holdings_csv
from .ingest.prices import cached_prices
from .models import utcnow
from .pipeline import analyse_structure, run_digest, serialize_digest
from .store import Store

log = logging.getLogger(__name__)

# Web assets ship inside the bundle; locate them whether frozen or in dev.
WEB_DIR = (Path(sys._MEIPASS) / "investraton" / "web") if getattr(sys, "frozen", False) \
    else Path(__file__).parent / "web"

app = FastAPI(title="Investraton", version=__version__)

# The Tauri shell's loading page lives on a different origin (tauri://) and polls
# this server to know when it's ready; allow that cross-origin read. Local app only.
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
)


# ---------- models ----------
class HoldingIn(BaseModel):
    ticker: str
    name: str = ""
    type: str = "equity"
    amount_invested_eur: float | str | None = None
    avg_cost: float | str | None = None
    strategy_tag: str = ""


class PlanIn(BaseModel):
    profile: dict = {}
    monthly_contribution_eur: float = 0.0
    allocation_targets: dict = {}
    watchlist: list = []
    thresholds: dict = {}


class SettingsIn(BaseModel):
    llm_provider: str | None = None
    ollama_host: str | None = None
    ollama_model: str | None = None
    anthropic_api_key: str | None = None
    anthropic_model: str | None = None
    delivery: list[str] | None = None
    discord_webhook_url: str | None = None
    smtp: dict | None = None


# ---------- status ----------
@app.get("/api/status")
def status():
    s = load_settings()
    holdings, notes = load_all_holdings(s, load_plan())
    deps = {}
    for d in ("yfinance", "feedparser", "fastapi"):
        try:
            __import__(d)
            deps[d] = True
        except ImportError:
            deps[d] = False
    return {
        "version": __version__,
        "now": utcnow().isoformat(),
        "llm_provider": s.llm_provider,
        "delivery": s.delivery,
        "holdings_count": len(holdings),
        "sources": notes,
        "deps": deps,
    }


# ---------- holdings ----------
@app.get("/api/holdings")
def get_holdings():
    s = load_settings()
    holdings, _ = load_all_holdings(s, load_plan())
    with Store(s.db_path) as store:
        apply_current_values(holdings, cached_prices([h.ticker for h in holdings if h.ticker], store), store)
    compute_weights(holdings)
    return {
        "holdings": [
            {
                "ticker": h.ticker, "name": h.name, "type": h.type,
                "amount_invested_eur": h.amount_invested_eur or None,
                "avg_cost": h.avg_cost or None, "strategy_tag": h.strategy_tag, "isin": h.isin,
                "weight": round(h.portfolio_weight, 4),
                "current_value": round(h.current_value, 2) if h.current_value else None,
            }
            for h in sorted(holdings, key=lambda x: x.portfolio_weight, reverse=True)
        ]
    }


@app.put("/api/holdings")
def put_holdings(rows: list[HoldingIn]):
    s = load_settings()
    save_holdings_csv(s.holdings_csv, [r.model_dump() for r in rows])
    return {"saved": len(rows)}


# ---------- plan ----------
@app.get("/api/plan")
def get_plan():
    p = load_plan()
    return {
        "profile": p.profile,
        "monthly_contribution_eur": p.monthly_contribution_eur,
        "allocation_targets": p.allocation_targets,
        "watchlist": p.watchlist,
        "thresholds": asdict(p.thresholds),
    }


@app.put("/api/plan")
def put_plan(plan: PlanIn):
    raw = {
        "profile": plan.profile,
        "plan": {
            "monthly_contribution_eur": plan.monthly_contribution_eur,
            "allocation_targets": plan.allocation_targets,
            "watchlist": plan.watchlist,
        },
        "thresholds": plan.thresholds,
    }
    save_plan(raw)
    return {"saved": True}


# ---------- settings (secrets masked on read) ----------
_SECRET_KEYS = {"anthropic_api_key"}


@app.get("/api/settings")
def get_settings():
    raw = load_app_settings()
    s = load_settings()
    smtp = dict(s.smtp)
    if smtp.get("password"):
        smtp["password"] = "********"
    return {
        "llm_provider": s.llm_provider,
        "ollama_host": s.ollama_host,
        "ollama_model": s.ollama_model,
        "anthropic_api_key": "********" if (raw.get("anthropic_api_key") or s.anthropic_api_key) else "",
        "anthropic_model": s.anthropic_model,
        "delivery": s.delivery,
        "discord_webhook_url": s.discord_webhook_url,
        "smtp": smtp,
    }


@app.put("/api/settings")
def put_settings(incoming: SettingsIn):
    current = load_app_settings()
    data = incoming.model_dump(exclude_none=True)
    # Don't overwrite a stored secret with the masking placeholder.
    for k in _SECRET_KEYS:
        if data.get(k) == "********":
            data.pop(k, None)
    # MERGE smtp rather than replace, so saving other settings (with the password
    # field left blank) never wipes the stored SMTP password.
    if isinstance(data.get("smtp"), dict):
        incoming_smtp = data.pop("smtp")
        # Keep stored values when a field is blank or the masked placeholder, so a
        # partial save (e.g. password field left empty) never wipes the SMTP config.
        incoming_smtp = {k: v for k, v in incoming_smtp.items() if v not in (None, "", "********")}
        merged = dict(current.get("smtp", {}))
        merged.update(incoming_smtp)
        current["smtp"] = merged
    current.update(data)
    save_app_settings(current)
    return {"saved": True}


# ---------- structure (look-through / concentration / plan) ----------
@app.get("/api/structure")
def get_structure():
    s = load_settings()
    holdings, _ = load_all_holdings(s, load_plan())
    if not holdings:
        raise HTTPException(404, "No holdings. Add positions first.")
    with Store(s.db_path) as store:
        apply_current_values(holdings, cached_prices([h.ticker for h in holdings if h.ticker], store), store)
    compute_weights(holdings)
    findings, lt = analyse_structure(holdings, load_plan())
    return {
        "coverage": round(lt.coverage, 4),
        "opaque": [{"label": l, "weight": round(w, 4)} for l, w in lt.opaque],
        "as_of": lt.as_of,
        "by_name": [_exp(e) for e in lt.by_name[:25]],
        "by_region": [_exp(e) for e in lt.by_region[:10]],
        "by_country": [_exp(e) for e in lt.by_country[:12]],
        "by_sector": [_exp(e) for e in lt.by_sector[:10]],
        "findings": [{"kind": f.kind, "title": f.title, "detail": f.detail, "severity": f.severity}
                     for f in findings],
    }


def _exp(e):
    return {"label": e.label, "weight": round(e.weight, 4),
            "direct": round(e.direct, 4), "via_etf": round(e.via_etf, 4), "detail": e.detail}


# ---------- digest preview ----------
@app.get("/api/digest")
def get_digest(deliver: bool = False, focus: str = "all", complexity: str = "standard"):
    return serialize_digest(run_digest(period="weekly", deliver_output=deliver,
                                       focus=focus, complexity=complexity))


# ---------- history ----------
@app.get("/api/history")
def get_history():
    s = load_settings()
    with Store(s.db_path) as store:
        return {"history": store.list_digests(60)}


@app.get("/api/history/{digest_id}")
def get_history_item(digest_id: int):
    s = load_settings()
    with Store(s.db_path) as store:
        payload = store.get_digest(digest_id)
    if payload is None:
        raise HTTPException(404, "No such digest")
    return json.loads(payload)


# ---------- news sources ----------
class SourceIn(BaseModel):
    type: str  # "domain" | "rss"
    value: str
    name: str = ""


@app.get("/api/sources")
def get_sources():
    return {"sources": load_app_settings().get("news_sources", [])}


@app.put("/api/sources")
def put_sources(sources: list[SourceIn]):
    current = load_app_settings()
    current["news_sources"] = [s.model_dump() for s in sources]
    save_app_settings(current)
    return {"saved": len(sources)}


# ---------- schedules ----------
class ScheduleIn(BaseModel):
    id: str = ""
    name: str = "Digest"
    frequency: str = "weekly"
    time: str = "08:00"
    complexity: str = "standard"
    focus: str = "all"
    delivery: list[str] = []
    skip_if_empty: bool = False
    enabled: bool = True


@app.get("/api/schedules")
def get_schedules():
    return {"schedules": load_schedules(), "frequencies": FREQUENCIES, "complexities": COMPLEXITIES}


@app.put("/api/schedules")
def put_schedule(s: ScheduleIn):
    return {"schedule": upsert_schedule(s.model_dump())}


@app.delete("/api/schedules/{sched_id}")
def remove_schedule(sched_id: str):
    delete_schedule(sched_id)
    return {"deleted": sched_id}


@app.post("/api/schedules/sync")
def post_sync():
    return sync_windows_tasks()


@app.post("/api/schedules/{sched_id}/run")
def post_run(sched_id: str):
    # Run now actually delivers (per the schedule's channels), so you can test it.
    try:
        return serialize_digest(run_schedule(sched_id, deliver=True))
    except ValueError as e:
        raise HTTPException(404, str(e))


@app.get("/api/open")
def open_url(url: str):
    """Open a URL in the user's default browser (webviews ignore target=_blank, so
    the UI routes external links here)."""
    if not url.lower().startswith(("http://", "https://")):
        raise HTTPException(400, "Only http(s) URLs.")
    import os
    import webbrowser

    try:
        if sys.platform.startswith("win"):
            os.startfile(url)  # noqa: S606 - default browser
        else:
            webbrowser.open(url)
    except Exception:  # noqa: BLE001
        try:
            webbrowser.open(url)
        except Exception:  # noqa: BLE001
            pass
    return {"ok": True}


@app.post("/api/test-email")
def post_test_email():
    """Send a test email and report the SMTP outcome (so config errors are visible)."""
    from .deliver.email import send_test

    try:
        send_test(load_settings())
        return {"ok": True}
    except Exception as e:  # noqa: BLE001 - surface the real reason to the UI
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}


# ---------- static UI (mounted last so /api/* wins) ----------
@app.get("/")
def index():
    return FileResponse(WEB_DIR / "index.html")


if WEB_DIR.exists():
    app.mount("/", StaticFiles(directory=str(WEB_DIR)), name="web")


def _port_in_use(host: str, port: int) -> bool:
    import socket

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.5)
        return s.connect_ex((host, port)) == 0


def main() -> None:
    import uvicorn

    from .config import HOME, provision_home

    provision_home()
    # Installed app: re-register scheduled tasks so they always point at the current
    # exe (self-heals task commands after an app update). Best-effort, off-thread so
    # it never delays startup.
    if getattr(sys, "frozen", False):
        import threading

        def _resync():
            try:
                from .scheduler import sync_windows_tasks

                sync_windows_tasks()
            except Exception:  # noqa: BLE001
                pass

        threading.Thread(target=_resync, daemon=True).start()
    # If an engine is already serving (e.g. the app is open), don't start a second
    # one — just exit quietly. Prevents port-bind errors / scary popups.
    if _port_in_use("127.0.0.1", 8765):
        return
    # A windowed (no-console) build has no stdout; route logs to a file so neither
    # our logging nor uvicorn crashes writing to a missing console.
    if getattr(sys, "frozen", False):
        try:
            logf = open(HOME / "investraton.log", "a", encoding="utf-8", buffering=1)
            sys.stdout = sys.stderr = logf
        except Exception:  # noqa: BLE001
            pass
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    print("Investraton app -> http://127.0.0.1:8765")
    uvicorn.run(app, host="127.0.0.1", port=8765, log_level="warning")


if __name__ == "__main__":
    main()
