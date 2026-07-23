// ============================================================================
// fetch-data.js — Assemble deep MEXC klines history into the --data format that
// `backtest.js --walk --data <dir>` (pooled walk-forward) loads.
//
//   node fetch-data.js --out ./klines --top 20 --limit 20000
//   node fetch-data.js --out ./klines --pairs BTCUSDT,ETHUSDT --limit 20000
//   node fetch-data.js --out ./klines --pairs BTCUSDT --limit 5000 --tfs 5m,15m,1h
//   MOCK=1 node fetch-data.js --out ./klines --pairs BTCUSDT   (offline, small)
//
// MEXC caps a single klines request at ~500 rows; this pages backward via
// endTime (js/mexc.js getKlinesDeep) to reach an arbitrary --limit, stitching by
// open time, de-duplicating the seam, and validating continuity.
//
// Output per pair: <SYMBOL>.json = { symbol, "5m":[...], "15m":[...], "1h":[...] }
// (parsed candles) — exactly what --data pooling loads. A manifest.json records
// requested vs received (and gaps) per pair/timeframe. Higher timeframes are
// sized to cover the same wall-clock span as the primary (smallest) timeframe,
// and BTCUSDT (with 15m) is always included so the BTC-regime filter has data.
// ============================================================================
import fs from "node:fs";
import path from "node:path";
import { CONFIG } from "./js/config.js";
import { intervalMinutes } from "./js/htf.js";
import * as mexc from "./js/mexc.js";
import { MockProvider } from "./js/mockprovider.js";

const MOCK = process.env.MOCK === "1" || process.argv.includes("--mock");

function argVal(name, def) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

main().catch((e) => { console.error("fetch-data failed:", e.message); process.exit(1); });

async function main() {
  const outDir = path.resolve(argVal("--out", "./klines"));
  const limit = Math.max(200, parseInt(argVal("--limit", "20000"), 10));
  const pairsArg = argVal("--pairs", null);
  const topN = parseInt(argVal("--top", ""), 10);
  const debug = process.argv.includes("--debug"); // per-request paging trace to stderr

  // Timeframes: requested scan TFs + the HTF bias + regime layers (all needed by
  // the gate). Always include the primary (smallest) first.
  const defaultTfs = [...new Set([...CONFIG.scanner.timeframes, CONFIG.htf.biasTf, CONFIG.htf.regimeTf])];
  const tfs = (argVal("--tfs", null)?.split(",").map((s) => s.trim()) || defaultTfs).filter(Boolean);
  const primaryTf = [...tfs].sort((a, b) => intervalMinutes(a) - intervalMinutes(b))[0];
  const spanMinutes = limit * intervalMinutes(primaryTf); // wall-clock span to cover on every TF

  const provider = MOCK ? new MockProvider({ full: true }) : mexc;

  // Resolve pairs.
  let pairs;
  if (pairsArg) pairs = pairsArg.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  else if (MOCK) pairs = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
  else {
    const n = Number.isFinite(topN) ? topN : CONFIG.scanner.topN;
    const tickers = await mexc.get24hr();
    pairs = mexc.rankTopPairs(tickers, n).map((t) => t.symbol);
  }
  // Ensure BTCUSDT (BTC-regime filter needs it) is present.
  const btc = CONFIG.regime.btcSymbol;
  if (!pairs.includes(btc)) pairs.push(btc);

  fs.mkdirSync(outDir, { recursive: true });
  console.log(`Fetching ${pairs.length} pairs · TFs ${tfs.join("/")} · primary ${primaryTf} · target ${limit} candles (~${(spanMinutes / 1440).toFixed(1)} days) · ${MOCK ? "MOCK" : "MEXC"}\n`);

  const manifest = { fetchedAt: new Date().toISOString(), source: MOCK ? "mock" : "mexc", primaryTf, target: limit, tfs, perPair: {} };
  let stalls = 0; // pagination stalls seen (an ERROR, distinct from short history)

  for (const sym of pairs) {
    const fileObj = { symbol: sym };
    const rec = {};
    for (const tf of tfs) {
      const want = Math.min(60000, Math.ceil(spanMinutes / intervalMinutes(tf)) + 60);
      let res;
      try {
        res = MOCK
          ? await mockDeep(provider, sym, tf, want)
          : await mexc.getKlinesDeep(sym, tf, want, { onProgress: () => {}, debug });
      } catch (e) {
        console.error(`  ${sym} ${tf}: FAILED (${e.message})`);
        rec[tf] = { requested: want, received: 0, error: e.message };
        continue;
      }
      fileObj[tf] = res.candles;
      rec[tf] = { requested: want, received: res.received, pages: res.pages, gaps: res.gaps.length, stalled: !!res.stalled };
      // A STALL (pages returned data that merged to nothing) is an ERROR — the API
      // stopped advancing, so the depth is bogus. Only call it "short history" when
      // paging genuinely ran out of candles (no stall): a real limited-history pair.
      if (res.stalled) {
        stalls++;
        rec[tf].error = `pagination stall — the API stopped returning new candles after ${res.pages} page(s) (${res.received} unique). endTime is not advancing; deep history is unavailable via this path. Run with --debug to see per-request openTime.`;
        console.error(`  ${sym} ${tf}: ✗ PAGINATION STALL — requested ${want}, only ${res.received} unique after ${res.pages} pages (endTime not advancing). Re-run with --debug.`);
      } else {
        const short = res.received < want ? "  ⚠ short (limited history — genuine end of series)" : "";
        console.log(`  ${sym} ${tf}: requested ${want}, received ${res.received} (${res.pages} pages, ${res.gaps.length} gaps)${short}`);
      }
    }
    fs.writeFileSync(path.join(outDir, `${sym}.json`), JSON.stringify(fileObj));
    manifest.perPair[sym] = rec;
  }

  manifest.stalls = stalls;
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(`\nWrote ${pairs.length} pair files + manifest.json to ${outDir}`);
  if (stalls) {
    console.error(`\n✗ ${stalls} pagination stall(s) — this snapshot's deep history is NOT reliable. Do NOT validate on it.`);
    console.error(`  Re-run with --debug to capture the exact per-request query params + returned openTime range, so the endTime/interval semantics can be confirmed.`);
    process.exitCode = 1;
  } else {
    console.log(`Run: node backtest.js --walk --data ${outDir} ${primaryTf}`);
  }
}

/** Offline mock "deep" fetch (single call; the mock has limited depth). */
async function mockDeep(provider, sym, tf, want) {
  const candles = await provider.getKlines(sym, tf, want);
  return { candles, requested: want, received: candles.length, uniqueTotal: candles.length, pages: 1, gaps: [] };
}
