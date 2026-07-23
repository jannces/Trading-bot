# RUN_ME — fetch real MEXC data and run the validation locally (Windows / PowerShell)

**Why this file exists:** the environment where this branch was built **cannot
reach `api.mexc.com`** (outbound is blocked by the sandbox network policy — a
`403 CONNECT` on every request). Market data was therefore **not** fetched or
synthesized here. Run the steps below on your own machine (which can reach MEXC)
to produce a real snapshot, run the full validation, and generate the verdict.
Then hand the results back (Step 5).

All commands are PowerShell, run **from the repo root** (the folder with
`package.json`). Nothing here places orders or touches your exchange account —
it only reads public klines.

---

## 0. Prerequisites (once)

```powershell
node --version        # need Node 18+
npm install           # installs ws; better-sqlite3 is optional and may be skipped
```

If `better-sqlite3` fails to build, that's fine — it's optional and unused by the
validation (the scanner falls back to a JSON ledger).

---

## 1. Fetch the snapshot (~70 days of 5m for the top-20 USDT pairs + BTC)

Same universe filter as the live scanner (top-N USDT pairs by 24h quote volume,
leveraged tokens and stable/stable pairs excluded), timeframes 5m + 15m (bias) +
1h (regime), 20 000 5m candles each (~69 days). BTCUSDT is always included for the
regime layer.

```powershell
node fetch-data.js --out .\data --top 20 --limit 20000 --tfs 5m,15m,1h
```

This pages **forward** through MEXC's ~500-rows-per-request cap (via `startTime`,
which MEXC treats as a lower bound), so it makes many requests and takes a few
minutes. It writes `.\data\<SYMBOL>.json` per pair plus `.\data\manifest.json`
(requested vs received, pages, gaps, `stalled`, `listedLate`, earliest/latest).

> **`ⓘ listed later than window`** on a pair just means it's newer than ~70 days
> (e.g. a recent listing) — it's **usable-but-short**, not an error.
>
> **`✗ PAGINATION STALL`** (a page returns rows that add nothing — `startTime` not
> advancing) exits non-zero; that snapshot is unusable. Re-run with `--debug` to
> print, per request, the exact query params and returned `openTime` range:
> ```powershell
> node fetch-data.js --out .\data --top 20 --limit 20000 --tfs 5m,15m,1h --debug
> ```
> If the `[deep]` trace shows `startTime` advancing but the returned `openTime`
> window **not** moving with it, capture that trace — the endpoint's time semantics
> have changed again and the cursor needs another look.

> Optional — to also enable the `1m` vs `5m` comparison in Step 3, add `1m` to the
> timeframes: `--tfs 1m,5m,15m,1h`. Without it the run is **5m-only** (the compare
> stage will say so explicitly). 1m at 20 000 candles is only ~14 days; that is
> fine for the comparison.

---

## 2. Verify the snapshot before trusting it

```powershell
node verify-manifest.js .\data
```

Prints a provenance table (per pair/TF: candle count + actual date range) and
flags any series that came back **short** (< 95% of requested) or with
**continuity gaps**. Exit code is non-zero if anything is incomplete. A few thin
pairs are OK; a wall of short series means MEXC throttled you — wait and re-run
Step 1.

---

## 3. Run the full validation (saves everything, timestamped)

```powershell
npm run validate
```

This runs, over `.\data`, in sequence and saves all output (human tables **and**
machine-readable JSON) under `.\results\<timestamp>\`:

1. `--matrix` — setup × timeframe × tier: net R, profit factor, n.
2. `--compare 1m 5m` — **only if 1m data is present**; otherwise it records a
   `"5m-only run"` note and skips.
3. pooled `--walk 5m` — full grid, fold coverage %, per-fold selections, aggregate
   out-of-sample expectancy.

Before running the heavy walk it prints a **calibration estimate** (single-pair
timing × pair count) and **aborts with a warning if the projected time exceeds 2
hours** — so you are never surprised by an overnight job. It also **refuses to run
on known-bad data**: if a pagination stall occurred, or more than 20% of pairs are
flagged by `verify-manifest` (override with `$env:VALIDATE_MAX_BAD_FRACTION="0.1"`),
it aborts with fetch-fix instructions instead of producing confident numbers from
garbage. Note the `.\results\<timestamp>\` path it prints; you need it for Step 4.

---

## 4. Turn the measurement into a verdict + a proposed config diff

```powershell
node analyze-results.js .\results\<timestamp>      # use the folder printed in Step 3
```

This applies the **conservative** verdict logic and writes
`.\results\<timestamp>\VALIDATION.md`:

- setup×TF with **negative net expectancy AND n ≥ `backtest.minTradesForVerdict`
  (50)** → proposed for `config.disabledSetups`;
- walk-forward OOS-selected parameters adopted **only** where the aggregate OOS had
  enough trades **and** non-negative net expectancy — otherwise it keeps current
  defaults and says so;
- anything below the minimum trade count is listed under **"unresolved: need more
  history"**, never turned into a recommendation;
- data provenance, full tables, every proposed change with its supporting numbers,
  and an honest bottom line (including, if everything is negative, that no setup
  showed positive net expectancy and that parameter tuning is not the fix).

It **does not** change `js/config.js`. Proposed edits are printed as a diff for you
to review and apply by hand.

---

## 5. Hand the results back

Zip or commit the whole `.\results\<timestamp>\` folder (it contains the raw
outputs, the JSON, the copied data manifest, and `VALIDATION.md`) and share it.
That folder is the complete, reproducible record of the run.

---

## Re-running later with fresher data

The entire pipeline is one loop — re-fetch and re-validate whenever you want a
fresher read:

```powershell
node fetch-data.js --out .\data --top 20 --limit 20000 --tfs 5m,15m,1h ; `
node verify-manifest.js .\data ; `
npm run validate
# then: node analyze-results.js .\results\<newest-timestamp>
```
