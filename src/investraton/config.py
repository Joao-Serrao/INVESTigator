"""Configuration loading: .env + app_settings.json + the portfolio plan YAML.

Settings precedence (lowest to highest): built-in defaults -> .env -> app_settings.json.
The app writes app_settings.json via the settings UI; the CLI/.env still work. This
keeps a single source of truth the GUI can manage without hand-editing .env.
"""

from __future__ import annotations

import json
import os
import sys
from dataclasses import dataclass, field
from pathlib import Path

import yaml
from dotenv import load_dotenv

_FROZEN = getattr(sys, "frozen", False)


def _resource_dir() -> Path:
    """Where bundled, read-only resources live (config defaults, web assets)."""
    if _FROZEN:
        return Path(sys._MEIPASS)  # PyInstaller extraction dir
    return Path(__file__).resolve().parents[2]  # repo root in dev


def _home_dir() -> Path:
    """Where the user's writable data lives (holdings, settings, db, schedules)."""
    env = os.environ.get("INVESTRATON_HOME")
    if env:
        return Path(env)
    if _FROZEN:  # installed app -> per-user app data, not the install dir (read-only)
        base = os.environ.get("APPDATA") or str(Path.home())
        return Path(base) / "Investraton"
    return Path(__file__).resolve().parents[2]  # repo root in dev

# Bundled resources (read-only) vs user home (writable). They coincide in dev.
RESOURCE_DIR = _resource_dir()
RESOURCE_CONFIG_DIR = RESOURCE_DIR / "config"
ROOT = HOME = _home_dir()
DATA_DIR = HOME / "data"
CONFIG_DIR = HOME / "config"
SETTINGS_JSON = CONFIG_DIR / "app_settings.json"


def provision_home() -> None:
    """Ensure the writable data/config dirs exist (called at startup)."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)


@dataclass
class Thresholds:
    price_move_pct: float = 3.0
    min_urgency_to_report: float = 2.0          # for OWNED positions
    news_lookback_days: int = 7
    watchlist_min_urgency: float = 0.0          # watched names: show ~everything
    watchlist_max_per_item: int = 8             # how many news items per watched name


@dataclass
class Plan:
    profile: dict = field(default_factory=dict)
    monthly_contribution_eur: float = 0.0
    allocation_targets: dict = field(default_factory=dict)
    watchlist: list = field(default_factory=list)
    thresholds: Thresholds = field(default_factory=Thresholds)


@dataclass
class Settings:
    llm_provider: str = "template"
    ollama_host: str = "http://localhost:11434"
    ollama_model: str = "llama3.1"
    anthropic_api_key: str = ""
    anthropic_model: str = "claude-haiku-4-5-20251001"
    delivery: list = field(default_factory=lambda: ["console"])
    discord_webhook_url: str = ""
    smtp: dict = field(default_factory=dict)
    db_path: Path = DATA_DIR / "investraton.db"
    holdings_csv: Path = DATA_DIR / "holdings.csv"


def load_app_settings() -> dict:
    """Read the GUI-managed overrides (may be empty/missing)."""
    if not SETTINGS_JSON.exists():
        return {}
    try:
        return json.loads(SETTINGS_JSON.read_text(encoding="utf-8")) or {}
    except Exception:  # noqa: BLE001
        return {}


def save_app_settings(data: dict) -> None:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    SETTINGS_JSON.write_text(json.dumps(data, indent=2), encoding="utf-8")


def load_settings() -> Settings:
    load_dotenv(ROOT / ".env")
    delivery = [d.strip() for d in os.getenv("INVESTRATON_DELIVERY", "console").split(",") if d.strip()]
    s = Settings(
        llm_provider=os.getenv("INVESTRATON_LLM", "template").strip().lower(),
        ollama_host=os.getenv("OLLAMA_HOST", "http://localhost:11434"),
        ollama_model=os.getenv("OLLAMA_MODEL", "llama3.1"),
        anthropic_api_key=os.getenv("ANTHROPIC_API_KEY", ""),
        anthropic_model=os.getenv("ANTHROPIC_MODEL", "claude-haiku-4-5-20251001"),
        delivery=delivery or ["console"],
        discord_webhook_url=os.getenv("DISCORD_WEBHOOK_URL", ""),
        smtp={
            "host": os.getenv("SMTP_HOST", ""),
            "port": int(os.getenv("SMTP_PORT", "587") or 587),
            "user": os.getenv("SMTP_USER", ""),
            "password": os.getenv("SMTP_PASSWORD", ""),
            "from": os.getenv("EMAIL_FROM", ""),
            "to": os.getenv("EMAIL_TO", ""),
        },
    )
    # Overlay GUI-managed overrides on top of env.
    o = load_app_settings()
    if o:
        s.llm_provider = str(o.get("llm_provider", s.llm_provider)).strip().lower()
        s.ollama_host = o.get("ollama_host", s.ollama_host)
        s.ollama_model = o.get("ollama_model", s.ollama_model)
        s.anthropic_api_key = o.get("anthropic_api_key", s.anthropic_api_key)
        s.anthropic_model = o.get("anthropic_model", s.anthropic_model)
        if o.get("delivery"):
            s.delivery = o["delivery"]
        s.discord_webhook_url = o.get("discord_webhook_url", s.discord_webhook_url)
        if isinstance(o.get("smtp"), dict):
            s.smtp.update(o["smtp"])
    return s


PLAN_PATH = CONFIG_DIR / "portfolio_plan.yaml"


def save_plan(raw: dict) -> None:
    """Write the portfolio plan YAML (used by the app's plan editor)."""
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    PLAN_PATH.write_text(yaml.safe_dump(raw, sort_keys=False, allow_unicode=True), encoding="utf-8")


def load_plan() -> Plan:
    """Load the portfolio plan, falling back to the bundled example if not customised."""
    path = PLAN_PATH
    if not path.exists():
        path = RESOURCE_CONFIG_DIR / "portfolio_plan.example.yaml"
    raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    plan_raw = raw.get("plan", {})
    th_raw = raw.get("thresholds", {})
    return Plan(
        profile=raw.get("profile", {}),
        monthly_contribution_eur=plan_raw.get("monthly_contribution_eur", 0.0),
        allocation_targets=plan_raw.get("allocation_targets", {}),
        watchlist=plan_raw.get("watchlist", []),
        thresholds=Thresholds(
            price_move_pct=th_raw.get("price_move_pct", 3.0),
            min_urgency_to_report=th_raw.get("min_urgency_to_report", 2.0),
            news_lookback_days=th_raw.get("news_lookback_days", 7),
            watchlist_min_urgency=th_raw.get("watchlist_min_urgency", 0.0),
            watchlist_max_per_item=th_raw.get("watchlist_max_per_item", 8),
        ),
    )
