"""Ingestion layer: pulls holdings, prices, and news from free sources.

Holdings are entered by hand (data/holdings.csv now; an app form later) — no
broker APIs, since XTB discontinued theirs and Degiro never offered one. Prices
and news come from free public sources (yfinance, RSS).
"""
