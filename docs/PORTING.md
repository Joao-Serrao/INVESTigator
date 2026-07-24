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

**Stage 1 — pure logic. ✅ DONE.** All seven deterministic modules are ported to `engine/src/`:
`weights`, `valuation`, `lookthrough`, `concentration`, `planAlign`, `scoping`, `urgency`.

Parity harness (`engine/test/`):

```powershell
python engine\test\make_fixtures.py   # dump inputs + expected output from the Python engine
cd engine && npm install && npm run parity
```

`make_fixtures.py` uses the **real** holdings/plan/ETF compositions (read-only) so the maths is
exercised against thousands of genuine constituents, and synthesises the price/news inputs so the
fixture is deterministic. Findings and events are compared as **exact strings** (which also
validates number formatting); floats use a 1e-9 relative epsilon to tolerate summation-order noise.

Current result: **22,057 comparisons, 0 mismatches** across 4 holdings / 4 ETFs / 3,437
constituents / 3,037 name exposures.

> ⚠️ Fixtures contain real positions and are git-ignored. Regenerate them locally.

**Bug this caught:** Python's `round()` and `f"{x:.Nf}"` use **banker's rounding** (half-to-even)
while JS `Math.round`/`toFixed` round half away from zero — `round(9.625, 2)` is `9.62` in Python
but `9.63` in JS. That silently shifted an urgency score and could push an item across a severity
threshold. All numeric output now goes through `src/round.ts` (`pyRound`/`pyFormat`/`pyThousands`).

**Stage 2 — storage. ✅ DONE.** `engine/src/store/` implements the contract above:
`files.ts` (holdings CSV, plan YAML via js-yaml, app_settings + schedules JSON, ETF cache) and
`db.ts` (the *same* SQLite schema, including the pre-`scope` `reported_events` migration).

Platform I/O is abstracted (`src/platform.ts`) with a Node adapter (`src/adapters/node.ts`) using
`node:fs` + the built-in `node:sqlite` — **no native dependency**. The Tauri adapter
(`tauri-plugin-fs` / `tauri-plugin-sql`) will implement the same two interfaces, so nothing above
that layer changes between desktop and Android.

```powershell
python engine\test\make_storage_fixtures.py
cd engine && npm run storage-parity
```

The database is opened **read-only**, so the test can never modify real data. Result:
**204 comparisons, 0 mismatches** — holdings, plan, settings, schedules, table counts,
`value_tracking` rows, the digest list, and row-level `alreadyReported` / `hasNews` /
`latestPrice` lookups all agree.

Secrets are redacted to a marker in the fixture: we assert keys and non-secret values match and
that secrets are consistently present, without copying credentials to another file.

> ⚠️ Note the two databases. In dev, Python's `HOME` is the **repo root**, so it uses
> `data/investraton.db`; the *installed* app uses `%APPDATA%\Investraton\`. The parity test
> deliberately points at the repo path so both sides read the same file.

**Stage 3 — ingestion. ✅ DONE.** `engine/src/ingest/`:

| Module | Source | Replaces |
|---|---|---|
| `prices.ts` | Yahoo chart endpoint (`/v8/finance/chart/{sym}?range=5d&interval=1d`) | `yfinance` |
| `news.ts` | Google News RSS (+ `site:` for custom domains), Yahoo headline RSS, custom feeds | `feedparser`, `yfinance.news` |
| `etfHoldings.ts` | iShares daily holdings CSV, product-id addressed, with `index_proxies` | `requests` + `csv` |

HTTP is abstracted (`HttpClient` in `src/platform.ts`) because a plain webview **cannot** fetch any
of these — CORS blocks all three. Tauri's `tauri-plugin-http` performs requests natively and
therefore bypasses CORS; Node uses global `fetch`.

Two notes on fidelity. Python gets prices through `yfinance`, which is itself a wrapper over that
chart endpoint — we confirmed the raw `close` array and the derived `price`/`change` match
`yfinance.history(period="5d")` exactly for the same symbol. And RSS moves from `feedparser` to
`fast-xml-parser` (works in Node *and* in a webview, unlike `feedparser`).

*Parity had to change shape here:* live data moves, so instead of comparing live fetches we
snapshot real payloads once, have the Python parsers produce their output, and assert the TS
parsers agree.

```powershell
python engine\test\make_ingest_fixtures.py   # captures raw responses + Python's parse
cd engine && npm run ingest-parity
```

Result: **4,390 comparisons, 0 mismatches** — 3 price snapshots, both news query builders,
222 RSS entries (title, link, source, publish instant, summary text, **and `dedup_key`**), and all
505 constituents of a real S&P 500 CSV plus their weight sum.

`dedup_key` is checked explicitly: it drives the "have we already shown this?" contract, so a
mismatch would make the Android app re-report every article once on first run.

One deliberate divergence: `feedparser` sanitises HTML in `summary`, `fast-xml-parser` returns it
raw. Neither engine renders the stored summary as markup, so the harness compares the *visible
text* (tags stripped, entities decoded, whitespace collapsed) rather than the raw bytes.

The suite was verified against planted errors — 3 mutations in the fixture produced exactly 3
failures and a non-zero exit, so a green run is not a vacuous one.

**Stage 4 — application layer. ✅ DONE.** The orchestration that ties Stages 1–3 together, plus the
API surface the UI calls:

| Module | Ports | Notes |
|---|---|---|
| `src/pipeline.ts` | `pipeline.run_digest` / `analyse_structure` / `serialize_digest` | ingest → score → dedup → structure → narrate → deliver |
| `src/brain/narrative.ts` | `brain/narrative.py` | deterministic template body; LLM only adds a qualitative line |
| `src/brain/llm.ts` | `brain/llm.py` | Template / Ollama / Claude, all HTTP through `HttpClient` |
| `src/deliver.ts` | `deliver/*.py` | console + Discord here; email SMTP injected per-platform |
| `src/config.ts` | settings half of `config.py` | defaults + `app_settings.json` (no `.env` — a dev-only Python path) |
| `src/app/service.ts` | every `api.py` endpoint | the "local TS calls instead of `fetch('/api/...')`" surface |

Two design choices make this port testable and portable:

- **Ingestion is injected.** `runDigest` takes an `IngestFns` bundle (prices / news / compositions)
  that defaults to the real Stage-3 fetchers but can be stubbed — which is what makes an offline,
  deterministic end-to-end parity test possible.
- **I/O is behind interfaces.** Delivery transports (`EmailSender`, the console sink) and the
  schedule-sync hook are injected through the context, so the same pipeline runs under Node,
  desktop Tauri, and Android — only the adapters differ. Windows Task Scheduler / Android
  AlarmManager wiring is deferred to its platform (Stage 6); the service does the data-level
  schedule CRUD and calls the injected sync hook.

A subtle bug the port surfaced: the narrative interpolates a raw `urgency` float, and Python's
`str(8.0)` is `"8.0"` where JS's `String(8)` is `"8"`. Added `pyFloatStr` so whole-number urgencies
keep their trailing `.0` — otherwise the narrative would silently diverge on any integer score.

*Parity here is end-to-end.* `make_pipeline_fixtures.py` runs Python `run_digest` on fixed inputs
with stubbed ingestion across five scenarios (varying focus, complexity, and period to exercise
thresholds, per-subject caps, structure on/off, watchlist on/off, and the empty-digest branch), and
captures `serialize_digest`. `pipeline-parity.ts` feeds the TS engine the same inputs and asserts
equality — numbers within a relative epsilon, **everything else (including the entire narrative
string) exactly**.

```powershell
python engine\test\make_pipeline_fixtures.py
cd engine && npm run pipeline-parity
```

Result: **450 comparisons, 0 mismatches** — one run of the whole loop (scoping → scoring →
threshold/dedup → caps → look-through/concentration/plan → narrative → serialize) agrees down to
the byte. Verified against planted errors: mutating a freshness label, a narrative word, and one
urgency produced exactly three failures.

The **UI wiring itself** (binding the existing vanilla-JS front-end to `app/service.ts` through the
Tauri bridge) lands with the desktop shell in Stage 5, since it needs the Tauri adapters
(`tauri-plugin-fs` / `-sql` / `-http`) that `service.ts` is written against.

**Stage 5 — desktop parity.** Ship the TS build on Windows and run it beside the Python one on the
same data until they agree. Python retires only after that.

**Stage 6 — Android.** Delivery keeps email/Discord and gains native notifications (which work
fully offline — only *fetching* needs the network). AI is **Template or Claude-with-your-key** —
Ollama is desktop-only.

Scheduling: use **`AlarmManager.setExactAndAllowWhileIdle()`** (or `setAlarmClock()` for the
strongest guarantee) — these fire *through* Doze and are what alarm apps use. Do **not** use
`WorkManager` periodic work for the digest: it is deferrable by design (15-min floor, batched,
delayed in Doze). Requires the user-grantable `SCHEDULE_EXACT_ALARM` permission on Android 12+,
and reaching AlarmManager from Tauri needs a small Kotlin plugin.

## Known losses / risks

- **Android scheduling needs the right API + one permission prompt** (see Stage 6). Exact alarms are
  reliable; aggressive OEM battery managers (Xiaomi/Huawei/Oppo) may still need the user to exempt
  the app from battery optimisation.
- **`yfinance` conveniences** (symbol quirks, retries) must be re-implemented; expect edge cases
  with exchange-suffixed tickers.
- **pandas is gone.** Fine here — the maths is sums and ratios — but CSV parsing must handle the
  iShares preamble/BOM exactly as `etf_holdings.py` does today.
- This is a **multi-session project**, not an afternoon. Stage 1 + 2 are where the real value and
  the real risk-reduction live.
