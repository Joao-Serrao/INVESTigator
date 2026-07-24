# Porting the engine to TypeScript (desktop + Android)

Goal: replace the Python/PyInstaller sidecar with a TypeScript engine running inside the
Tauri webview, so one codebase targets **Windows and Android** (and macOS/Linux/iOS).

## The rule that makes this safe

> **The new engine reads the same files, at the same paths, with the same schema.**

There is then **no migration step and nothing to lose** — the TS engine simply picks up where
the Python one left off. Any change to a format is a deliberate, versioned decision, never a
side effect of the rewrite.

### The data contract (must not change)

Location: `%APPDATA%\Investraton\` on Windows (Tauri's app-data dir elsewhere).

| Path | Format | Holds |
| --- | --- | --- |
| `data/holdings.csv` | CSV — `ticker,name,type,amount_invested_eur,avg_cost,strategy_tag,isin` | Your positions |
| `config/portfolio_plan.yaml` | YAML — `profile`, `plan{monthly_contribution_eur, allocation_targets, watchlist}`, `thresholds` | Plan + watchlist + noise thresholds |
| `config/app_settings.json` | JSON — `llm_provider`, `delivery[]`, `discord_webhook_url`, `smtp{}`, `news_sources[]` | Settings & secrets |
| `config/schedules.json` | JSON array — `{id,name,frequency,time,complexity,focus,delivery[],skip_if_empty,enabled}` | Scheduled digests |
| `data/etf_holdings/<productId>.json` | JSON — `{ticker,name,as_of,source,fetched_at,constituents[]}` | Cached ETF compositions |
| `data/investraton.db` | SQLite | Everything below |

SQLite tables (keep names + columns identical):

| Table | Columns | Why losing it hurts |
| --- | --- | --- |
| `value_tracking` | `ticker, basis_price, basis_amount, updated_at` | **Most sensitive.** Holds the price *at the moment you set each amount*. Lose it and every "Value now" resets to the entered amount and all gain/loss disappears. |
| `reported_events` | `dedup_key, scope, ticker, kind, reported_at` | Per-tier dedup. Lose it and previously-sent items resurface once. |
| `news` | `dedup_key, ticker, title, url, source, published, summary, first_seen` | Article dedup. Lose it and old news resurfaces. |
| `digests` | `id, created_at, period, focus, complexity, events_count, watch_count, payload` | The History tab. |
| `prices` | `ticker, price, currency, change_pct_1d, as_of` | Price cache / stale fallback. Cheapest to lose (refetches). |

Use `tauri-plugin-sql` (SQLite) pointed at the **same file** — do not create a new database.
`js-yaml` keeps the plan file readable rather than converting it to JSON.

## Staged plan

**Stage 0 — safety.** Back up `%APPDATA%\Investraton` (done: `Documents\INVESTigator-backup-*.zip`).
Add Export/Import so config+data is portable — this doubles as the way to get your setup onto Android.

**Stage 1 — pure logic (highest value, zero risk).** Port the deterministic modules, which have no
I/O and are just arithmetic:
`weights`, `valuation`, `lookthrough`, `concentration`, `plan_align`, `scoping`, `urgency`.
Then run a **parity harness**: feed both engines identical fixtures and assert the outputs match
exactly. Nothing ships until the numbers agree.

**Stage 2 — storage.** CSV/YAML/JSON readers + the SQLite layer, against the contract above.
Verify by opening *your real database* read-only and confirming History, dedup and value-basis
all resolve identically.

**Stage 3 — ingestion.** Prices (Yahoo JSON endpoints — what `yfinance` wraps), news (Google News /
Yahoo RSS + custom feeds), ETF holdings (iShares CSV). All plain HTTP through
`tauri-plugin-http`, which performs requests natively and therefore **bypasses CORS** — the reason
this can't just be done in a plain webview.

**Stage 4 — UI.** Largely unchanged: it already speaks to a small API surface, which becomes local
TS calls instead of `fetch('/api/...')`.

**Stage 5 — desktop parity.** Ship the TS build on Windows and run it beside the Python one on the
same data until they agree. Python retires only after that.

**Stage 6 — Android.** Scheduling moves to WorkManager (~15-min floor, and Doze/OEM battery
managers make it genuinely less reliable than Task Scheduler). Delivery keeps email/Discord and
gains native notifications. AI is **Template or Claude-with-your-key** — Ollama is desktop-only.

## Known losses / risks

- **Background reliability on Android is worse.** This is an OS constraint, not a design choice.
- **`yfinance` conveniences** (symbol quirks, retries) must be re-implemented; expect edge cases
  with exchange-suffixed tickers.
- **pandas is gone.** Fine here — the maths is sums and ratios — but CSV parsing must handle the
  iShares preamble/BOM exactly as `etf_holdings.py` does today.
- This is a **multi-session project**, not an afternoon. Stage 1 + 2 are where the real value and
  the real risk-reduction live.
