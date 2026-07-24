"""Swappable LLM providers behind a tiny `LLM` protocol.

- TemplateLLM: no model at all. Deterministic, offline, always works.
- OllamaLLM:   local model via Ollama HTTP API. Free, private.
- ClaudeLLM:   Anthropic Messages API. Best quality, needs a key.

`get_llm(settings)` picks one from config and *falls back to TemplateLLM* if the
chosen provider is unreachable — the digest must always render.
"""

from __future__ import annotations

import logging
from typing import Protocol

import requests

log = logging.getLogger(__name__)

# Enforces the guardrails regardless of provider.
SYSTEM_PROMPT = (
    "You are Investraton, a personal investment INTELLIGENCE assistant. You are a "
    "context amplifier, NOT a trading assistant. Absolute rules:\n"
    "1. NEVER recommend buying, selling, or holding. No 'you should', no price targets.\n"
    "2. NEVER invent or alter numbers. Use ONLY the figures provided; do no arithmetic.\n"
    "3. For every item, explain WHY IT MATTERS TO THIS PERSON given their holdings/plan.\n"
    "4. Be concise and calm. Reduce noise. Never create urgency or action pressure.\n"
    "5. If data is labelled stale/approximate, preserve that caveat.\n"
    "Write a clear, scannable digest in Markdown."
)


class LLM(Protocol):
    name: str

    def generate(self, prompt: str) -> str: ...


class TemplateLLM:
    """No-LLM fallback: returns empty so the caller uses its deterministic template."""

    name = "template"

    def generate(self, prompt: str) -> str:  # noqa: ARG002
        return ""


class OllamaLLM:
    name = "ollama"

    def __init__(self, host: str, model: str):
        self.host = host.rstrip("/")
        self.model = model

    def generate(self, prompt: str) -> str:
        resp = requests.post(
            f"{self.host}/api/chat",
            json={
                "model": self.model,
                "stream": False,
                "messages": [
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": prompt},
                ],
            },
            timeout=120,
        )
        resp.raise_for_status()
        return (resp.json().get("message", {}) or {}).get("content", "").strip()


class ClaudeLLM:
    name = "claude"

    def __init__(self, api_key: str, model: str):
        self.api_key = api_key
        self.model = model

    def generate(self, prompt: str) -> str:
        resp = requests.post(
            "https://api.anthropic.com/v1/messages",
            headers={
                "x-api-key": self.api_key,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            json={
                "model": self.model,
                "max_tokens": 1500,
                "system": SYSTEM_PROMPT,
                "messages": [{"role": "user", "content": prompt}],
            },
            timeout=60,
        )
        resp.raise_for_status()
        blocks = resp.json().get("content", [])
        return "".join(b.get("text", "") for b in blocks if b.get("type") == "text").strip()


def get_llm(settings) -> LLM:
    provider = settings.llm_provider
    try:
        if provider == "ollama":
            return OllamaLLM(settings.ollama_host, settings.ollama_model)
        if provider == "claude":
            if not settings.anthropic_api_key:
                log.warning("INVESTRATON_LLM=claude but ANTHROPIC_API_KEY is empty; using template.")
                return TemplateLLM()
            return ClaudeLLM(settings.anthropic_api_key, settings.anthropic_model)
    except Exception as e:  # noqa: BLE001
        log.warning("LLM init failed (%s); using template fallback.", e)
    return TemplateLLM()
