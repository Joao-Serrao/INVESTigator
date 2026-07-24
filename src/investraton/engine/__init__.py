"""Deterministic engine: every number the system relies on is computed here, in
code — weights, exposure, urgency. The LLM never recomputes these. Urgency is a
SORT KEY for relevance, not a verdict.
"""
