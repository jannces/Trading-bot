// ============================================================================
// backtest.js — Validation tooling for the setup + gate + cost model.
//
//   node backtest.js SYMBOL TF CANDLES        single pair
//   node backtest.js --scan TF CANDLES        across the current top-50
//   node backtest.js --demo [TF] [CANDLES]    offline synthetic data
//
// Flags (combine with the above):
//   --split [frac]   report in-sample / out-of-sample split (default 0.7)
//   --matrix         run ALL scanner timeframes; print setup×TF×tier table
//   --walk           walk-forward: grid-search {minAgree, minRR, stopCap} on
//                    rolling train windows, report out-of-sample results
//
// Same gate as live (no look-ahead). HTF bias uses REAL higher-timeframe klines
// sliced by time (js/htf.js htfSliceAtTime) — identical to the live scanner, not
// resampled. Each trade is simulated with the shared cost model (js/costs.js):
// gross AND net R after fees + slippage. Reports win rate, gross/net expectancy,
// profit factor, max drawdown, and flags negative-net setups for config.disabledSetups.
// ============================================================================
import { CONFIG } from "./js/config.js";
import { evaluate, evaluateRaw, gateDecision } from "./js/confluence.js";
import { computeR } from "./js/costs.js";
import fs from "node:fs";
import path from "node:path";
import { htfSliceAtTime, intervalMinutes } from "./js/htf.js";
import { compareVerdict } from "./js/verdict.js";
import { computeFolds, foldSelectable, sizingWarning } from "./js/walk.js";
import * as mexc from "./js/mexc.js";
import { MockProvider } from "./js/mockprovider.js";

main().catch((e) => { console.error("Backtest failed:", e.message); process.exit(1); });

async function main() {
  const args = process.argv.slice(2);
  const demo = args.includes("--demo");
  const scan = args.includes("--scan");
  const matrix = args.includes("--matrix");
  const walk = args.includes("--walk");
  const compare = args.includes("--compare");
  const dataIdx = args.indexOf("--data");
  const dataDir = dataIdx !== -1 ? args[dataIdx + 1] : null;
  const splitIdx = args.indexOf("--split");
  const doSplit = splitIdx !== -1;
  const pos = args.filter((a, i) => !a.startsWith("--") && !(dataIdx !== -1 && i === dataIdx + 1));
  const nums = pos.filter((a) => /^\d+$/.test(a));
  const words = pos.filter((a) => !/^\d+$/.test(a));
  const floats = pos.filter((a) => /^\d*\.\d+$/.test(a));
  const splitFrac = doSplit ? (parseFloat(floats[0]) || 0.7) : 0.7;
  const limit = clamp(parseInt(nums[0], 10) || 800, 200, 1500);
  let symbolArg, tf;
  if (compare) { symbolArg = "BTCUSDT"; tf = words[1] || "5m"; } // words are the two TFs
  else if (scan) { tf = words[0] || "5m"; }
  else if (demo) { symbolArg = "BTCUSDT"; tf = words[0] || "5m"; }
  else if (walk && dataDir) { symbolArg = "POOL"; tf = words[0] || "5m"; } // lone word is the TF
  else { symbolArg = (words[0] || "BTCUSDT").toUpperCase(); tf = words[1] || "5m"; }

  // Real provider fetches DEEP (paged via endTime) so --limit beyond MEXC's
  // ~500/request cap actually works instead of being silently truncated.
  const realGetKlines = async (sym, t, lim) => {
    const res = await mexc.getKlinesDeep(sym, t, lim);
    if (res.received < lim) console.error(`  ${sym} ${t}: requested ${lim}, received ${res.received} (deep fetch; limited history)`);
    return res.candles;
  };
  const provider = demo ? new MockProvider({ full: true }) : { getKlines: realGetKlines, get24hr: mexc.get24hr };
  const htfTf = CONFIG.htf.biasTf;
  const regimeTf = CONFIG.htf.regimeTf;
  const timeframes = matrix ? CONFIG.scanner.timeframes : [tf];

  // Resolve the symbol universe.
  let symbols;
  if (scan) {
    const tickers = await provider.get24hr();
    symbols = mexc.rankTopPairs(tickers, CONFIG.scanner.topN).map((t) => t.symbol);
  } else {
    symbols = [demo ? "BTCUSDT" : symbolArg];
  }

  if (!(walk && dataDir)) {
    console.log(`\nBacktest — ${scan ? `SCAN top-${symbols.length}` : symbols[0]} · ${timeframes.join("/")} · ${limit} candles · HTF ${htfTf}+${regimeTf} (real) · ${demo ? "synthetic demo" : "MEXC"}`);
  } else {
    console.log(`\nBacktest — pooled walk-forward from --data ${dataDir} · ${tf} · HTF ${htfTf}+${regimeTf}`);
  }
  console.log(`Gate: setup + >=${CONFIG.gate.minAgree}/10 aligned, no veto, HTF not counter, R:R>=${CONFIG.gate.minRR}, stop<=cap`);
  const c = CONFIG.costs;
  console.log(`Costs: fees ${(c.fees.makerPct * 100).toFixed(3)}/${(c.fees.takerPct * 100).toFixed(3)}%, slip ${(c.slippage.entryPct * 100).toFixed(3)}/${(c.slippage.stopPct * 100).toFixed(3)}%, spread ${(c.spreadPct * 100).toFixed(3)}% -> gross & net R\n`);

  // --- Gather trades (all symbols × timeframes) ----------------------------
  // Fetch REAL higher-timeframe series (bias + regime) once per (symbol, htfIv),
  // consumed via htfSliceAtTime — identical to the live scanner (parity).
  const htfCache = new Map();
  const fetchHtf = async (sym, htfIv, baseTf = matrix ? "5m" : tf) => {
    const key = `${sym}:${htfIv}`;
    if (htfCache.has(key)) return htfCache.get(key);
    const hl = clamp(Math.ceil((limit * intervalMinutes(baseTf)) / intervalMinutes(htfIv)) + 80, 100, 1000);
    let h = [];
    try { h = await provider.getKlines(sym, htfIv, hl); } catch { h = []; }
    htfCache.set(key, h);
    return h;
  };

  // --- Compare mode: 1m vs 5m over the same period, with per-setup verdicts ---
  if (compare) {
    const cmpTfs = words.length >= 2 ? words.slice(0, 2) : ["1m", "5m"];
    await runCompare(symbols, cmpTfs, provider, fetchHtf, htfTf, regimeTf, limit, demo, scan);
    return finish();
  }

  // --- Walk-forward: single pair, or multiple pooled pairs with --data <dir> --
  if (walk) {
    let seriesList;
    if (dataDir) {
      seriesList = loadDataDir(dataDir, tf, htfTf, regimeTf);
      if (!seriesList.length) { console.log(`No usable series in --data ${dataDir} (need <SYMBOL>.json with a "${tf}" array).`); return finish(); }
    } else {
      const sym = symbols[0];
      const htf = await fetchHtf(sym, htfTf);
      const regime = await fetchHtf(sym, regimeTf);
      let candles = [];
      try { candles = await provider.getKlines(sym, tf, limit); } catch (e) { console.log(`fetch failed: ${e.message}`); return finish(); }
      seriesList = [{ sym, candles, htf, regime }];
    }
    runWalkForward(seriesList, tf);
    return finish();
  }

  const all = [];
  if (dataDir) {
    // Offline: replay from committed --data files (used by matrix/normal too).
    for (const t of timeframes) {
      for (const s of loadDataDir(dataDir, t, htfTf, regimeTf)) {
        for (const tr of replay(s.candles, s.sym, t, s.htf, s.regime)) all.push(tr);
      }
    }
  } else {
    for (const sym of symbols) {
      const htf = await fetchHtf(sym, htfTf);
      const regime = await fetchHtf(sym, regimeTf);
      for (const t of timeframes) {
        let candles;
        try { candles = await provider.getKlines(sym, t, limit); }
        catch (e) { if (!scan) throw e; console.error(`  ${sym} ${t}: fetch failed (${e.message})`); continue; }
        if (!candles || candles.length < CONFIG.backtest.warmup + 30) continue;
        for (const tr of replay(candles, sym, t, htf, regime)) all.push(tr);
        if (!demo) await sleep(CONFIG.timing.klineStaggerMs);
      }
    }
  }

  if (all.length === 0) { console.log("No filled trades on this sample."); return finish(); }

  // --- Reports -------------------------------------------------------------
  if (scan && !matrix) { console.log("BY PAIR"); reportGroups(groupBy(all, (t) => t.pair)); console.log(""); }
  if (matrix) {
    console.log("SETUP × TIMEFRAME × TIER  (net expectancy)");
    reportMatrix(all);
    console.log("");
  }
  console.log("BY SETUP TYPE"); reportGroups(groupBy(all, (t) => t.setupName));
  console.log("\nBY TIER"); reportGroups(groupBy(all, (t) => t.tier), ["A+", "A", "B"]);
  console.log("\nOVERALL"); reportGroups({ ALL: all });

  if (doSplit) reportSplit(all, splitFrac);
  reportNegative(all);
  finish();
}

function finish() {
  console.log("\nSmall single-sample study; conservative fills; net = after fees+slippage. Not financial advice.");
}

// --- Replay one series (optionally only bars in [from,to)) -----------------
function replay(candles, sym, tf, htf, regime, from, to) {
  const warmup = CONFIG.backtest.warmup;
  from = from ?? warmup;
  to = to ?? candles.length - 2;
  const emitted = [];
  const seen = new Set();
  for (let i = Math.max(warmup, from); i < to; i++) {
    const slice = candles.slice(0, i + 1);
    const htfSlice = htfSliceAtTime(htf, candles[i].time);
    const regimeSlice = htfSliceAtTime(regime, candles[i].time);
    const dec = evaluate(slice, htfSlice, {
      symbol: sym, interval: tf, htfInterval: CONFIG.htf.biasTf,
      regimeCandles: regimeSlice, regimeInterval: CONFIG.htf.regimeTf,
    });
    if (dec.status !== "ACTIVE") continue;
    const p = dec.plan;
    const key = `${p.id}:${p.triggerIndex}:${p.direction}`;
    if (seen.has(key)) continue;
    seen.add(key);
    emitted.push(p);
  }
  const trades = [];
  for (const plan of emitted) {
    const t = simulateTrade(candles, plan);
    if (t.filled) trades.push({ pair: sym, tf, setupId: plan.id, setupName: plan.name, tier: plan.tier, posFrac: plan.triggerIndex / candles.length, ...t });
  }
  return trades;
}

// --- Precompute the expensive, params-INDEPENDENT scan once per bar ----------
// evaluateRaw (strategies + indicators + setup detection + HTF/regime bias) is
// pure in the candles [0..i] and in the ONE detection knob the grid varies
// (gate.triggerRecencyBars). We compute it once per (series, recency) and let
// the grid re-apply the cheap gateDecision() across every minAgree/capScale/
// expireBars combo and every fold — turning an O(bars × combos × folds) scan
// into an O(bars × distinctRecencies) one, with identical output.
//
// NO LOOK-AHEAD (structural, not just tested): bar i is handed exactly
// candles.slice(0, i+1); the slice ENDS at candles[i], so evaluateRaw cannot
// read any future bar. We assert the slice endpoint below so the guarantee
// can't silently rot.
function precomputeRaw(series, tf, recency) {
  const { candles, htf, regime, sym } = series;
  const warmup = CONFIG.backtest.warmup;
  const snapRec = CONFIG.gate.triggerRecencyBars;
  CONFIG.gate.triggerRecencyBars = recency;
  const rawByBar = new Array(candles.length);
  try {
    for (let i = warmup; i < candles.length; i++) {
      const slice = candles.slice(0, i + 1);
      // Structural look-ahead guard: the slice must end AT bar i, nothing later.
      if (slice.length !== i + 1 || slice[slice.length - 1].time !== candles[i].time)
        throw new Error(`look-ahead guard tripped at bar ${i}: slice does not end at candles[i]`);
      const htfSlice = htfSliceAtTime(htf, candles[i].time);
      const regimeSlice = htfSliceAtTime(regime, candles[i].time);
      rawByBar[i] = evaluateRaw(slice, htfSlice, {
        symbol: sym, interval: tf, htfInterval: CONFIG.htf.biasTf,
        regimeCandles: regimeSlice, regimeInterval: CONFIG.htf.regimeTf,
      });
    }
  } finally {
    CONFIG.gate.triggerRecencyBars = snapRec;
  }
  return rawByBar;
}

// Cheap replay: identical to replay() but re-uses precomputed evaluateRaw and
// only re-applies gateDecision (which reads the grid's minAgree/capScale). The
// composition gateDecision(evaluateRaw(...)) IS evaluate(...), so this is
// byte-for-byte the same as replay() at the same config — the golden guards it.
function cheapReplay(series, rawByBar, tf, from, to) {
  const { candles, sym } = series;
  const warmup = CONFIG.backtest.warmup;
  from = from ?? warmup;
  to = to ?? candles.length - 2;
  const emitted = [];
  const seen = new Set();
  for (let i = Math.max(warmup, from); i < to; i++) {
    const dec = gateDecision(rawByBar[i], { symbol: sym, interval: tf });
    if (dec.status !== "ACTIVE") continue;
    const p = dec.plan;
    const key = `${p.id}:${p.triggerIndex}:${p.direction}`;
    if (seen.has(key)) continue;
    seen.add(key);
    emitted.push(p);
  }
  const trades = [];
  for (const plan of emitted) {
    const t = simulateTrade(candles, plan);
    if (t.filled) trades.push({ pair: sym, tf, setupId: plan.id, setupName: plan.name, tier: plan.tier, posFrac: plan.triggerIndex / candles.length, ...t });
  }
  return trades;
}

// --- Trade simulation (half off at TP1 -> BE -> runner to TP2) --------------
function simulateTrade(candles, plan) {
  const long = plan.direction === "LONG";
  const entry = plan.entryPrice;
  const R = Math.abs(entry - plan.stop);
  if (R <= 0) return { filled: false };
  // Honor the live expiry window (scalper.expireBars) so the --walk grid over
  // expireBars is meaningful; fall back to maxBarsToFill.
  const maxFill = CONFIG.scalper.expireBars[plan.interval] ?? CONFIG.backtest.maxBarsToFill;
  let fillIndex = -1;
  for (let j = plan.triggerIndex + 1; j < candles.length && j <= plan.triggerIndex + maxFill; j++) {
    const cc = candles[j];
    if (long ? cc.low <= plan.entryHigh : cc.high >= plan.entryLow) { fillIndex = j; break; }
  }
  if (fillIndex === -1) return { filled: false };
  let tp1 = false, stop = plan.stop, mae = 0;
  for (let k = fillIndex; k < candles.length; k++) {
    const cc = candles[k];
    const adverse = long ? (cc.low - entry) / R : (entry - cc.high) / R;
    if (adverse < mae) mae = adverse;
    if (!tp1) {
      if (long ? cc.low <= stop : cc.high >= stop) return fin("stopped", k, false);
      if (long ? cc.high >= plan.tp1 : cc.low <= plan.tp1) { tp1 = true; stop = entry; }
    } else {
      if (long ? cc.low <= stop : cc.high >= stop) return fin("tp1_be", k, false);
      if (long ? cc.high >= plan.tp2 : cc.low <= plan.tp2) return fin("tp1_tp2", k, false);
    }
  }
  return fin(tp1 ? "tp1_open" : "running", candles.length - 1, true);
  function fin(path, k, open) { const { grossR, netR } = computeR(plan, path); return { filled: true, path, grossR, netR, open, fillIndex, exitIndex: k, maeR: mae }; }
}

// --- Stats + reporting -----------------------------------------------------
function stats(ts) {
  const n = ts.length;
  const net = ts.map((t) => t.netR);
  const wins = net.filter((r) => r > 1e-9);
  const losses = net.filter((r) => r < -1e-9);
  const sumPos = wins.reduce((a, b) => a + b, 0);
  const sumNeg = Math.abs(losses.reduce((a, b) => a + b, 0));
  return {
    n, winRate: n ? (wins.length / n) * 100 : 0,
    grossAvg: mean(ts.map((t) => t.grossR)), netAvg: mean(net), netTotal: net.reduce((a, b) => a + b, 0),
    pf: sumNeg > 0 ? sumPos / sumNeg : (sumPos > 0 ? Infinity : 0),
    maxDD: maxDrawdownR(ts), open: ts.filter((t) => t.open).length,
  };
}
function reportGroups(groups, order) {
  const keys = order ? order.filter((k) => groups[k]?.length) : Object.keys(groups);
  console.log("  " + pad("group", 20) + pad("n", 5) + pad("win%", 7) + pad("grossR", 8) + pad("netR", 8) + pad("PF", 6) + pad("maxDD", 9) + "open");
  console.log("  " + "-".repeat(70));
  for (const k of keys) {
    const s = stats(groups[k]);
    console.log("  " + pad(k, 20) + pad(s.n, 5) + pad(fmtPct(s.winRate), 7) + pad(fmtR(s.grossAvg), 8) + pad(fmtR(s.netAvg), 8) + pad(fmtPF(s.pf), 6) + pad(fmtR(-s.maxDD), 9) + s.open);
  }
}
function reportMatrix(all) {
  const groups = groupBy(all, (t) => `${t.setupName} | ${t.tf} | ${t.tier}`);
  const keys = Object.keys(groups).sort();
  console.log("  " + pad("setup | tf | tier", 34) + pad("n", 5) + pad("win%", 7) + pad("netR", 8) + pad("PF", 6) + "maxDD");
  console.log("  " + "-".repeat(66));
  for (const k of keys) {
    const s = stats(groups[k]);
    console.log("  " + pad(k, 34) + pad(s.n, 5) + pad(fmtPct(s.winRate), 7) + pad(fmtR(s.netAvg), 8) + pad(fmtPF(s.pf), 6) + fmtR(-s.maxDD));
  }
}
function reportSplit(all, frac) {
  const is = all.filter((t) => t.posFrac < frac);
  const oos = all.filter((t) => t.posFrac >= frac);
  console.log(`\nIN-SAMPLE / OUT-OF-SAMPLE (split at ${(frac * 100).toFixed(0)}% of each series)`);
  reportGroups({ [`in-sample`]: is.length ? is : [{ grossR: 0, netR: 0, open: 0 }], [`out-of-sample`]: oos.length ? oos : [{ grossR: 0, netR: 0, open: 0 }] });
  const eIs = mean(is.map((t) => t.netR)), eOos = mean(oos.map((t) => t.netR));
  console.log(`  -> net expectancy IS ${fmtR(eIs)} vs OOS ${fmtR(eOos)} ${robustNote(eIs, eOos)}`);
}
function robustNote(is, oos) {
  if (!isFinite(is) || !isFinite(oos)) return "";
  if (is > 0 && oos > 0) return "(holds up out-of-sample)";
  if (is > 0 && oos <= 0) return "(does NOT hold out-of-sample — likely overfit/regime-dependent)";
  return "(negative in-sample too)";
}
function reportNegative(all) {
  const bySetup = groupBy(all, (t) => `${t.setupId}`);
  const byCombo = groupBy(all, (t) => `${t.setupId}@${t.tf}`);
  const negSetups = Object.entries(bySetup).filter(([, ts]) => mean(ts.map((t) => t.netR)) < 0);
  const negCombos = Object.entries(byCombo).filter(([, ts]) => mean(ts.map((t) => t.netR)) < 0 && ts.length >= 5);
  console.log("");
  if (!negSetups.length) { console.log("No setup shows negative NET expectancy on this sample."); return; }
  console.log("⚠ Negative NET-expectancy on this sample:");
  for (const [id, ts] of negSetups) console.log(`   - ${id}: net ${fmtR(mean(ts.map((t) => t.netR)))} (gross ${fmtR(mean(ts.map((t) => t.grossR)))}) over ${ts.length}`);
  const suggest = negCombos.map(([k]) => k);
  if (suggest.length) console.log(`\n   Suggested config.disabledSetups: ${JSON.stringify(suggest)}`);
}

// --- Compare two timeframes over the same period, with per-setup verdicts ---
async function runCompare(symbols, cmpTfs, provider, fetchHtf, htfTf, regimeTf, limit, demo, scan) {
  const [tfA, tfB] = cmpTfs;
  const minV = CONFIG.backtest.minTradesForVerdict;
  const baseTf = cmpTfs.slice().sort((a, b) => intervalMinutes(b) - intervalMinutes(a))[0]; // longest -> size HTF for it
  const trades = { [tfA]: [], [tfB]: [] };

  console.log(`COMPARE ${tfA} vs ${tfB} — ${scan ? `top-${symbols.length}` : symbols[0]} · ${limit} candles · min ${minV} trades for a verdict\n`);
  for (const sym of symbols) {
    const htf = await fetchHtf(sym, htfTf, baseTf);
    const regime = await fetchHtf(sym, regimeTf, baseTf);
    for (const tf of cmpTfs) {
      let candles;
      try { candles = await provider.getKlines(sym, tf, limit); }
      catch (e) { if (!scan) throw e; continue; }
      if (!candles || candles.length < CONFIG.backtest.warmup + 30) continue;
      for (const tr of replay(candles, sym, tf, htf, regime)) trades[tf].push(tr);
      if (!demo) await sleep(CONFIG.timing.klineStaggerMs);
    }
  }

  // Overall side-by-side.
  const sA = stats(trades[tfA]); const sB = stats(trades[tfB]);
  console.log("OVERALL");
  console.log("  " + pad("metric", 12) + pad(tfA, 12) + tfB);
  console.log("  " + "-".repeat(34));
  const row = (label, fa, fb) => console.log("  " + pad(label, 12) + pad(fa, 12) + fb);
  row("n", sA.n, sB.n);
  row("win%", fmtPct(sA.winRate), fmtPct(sB.winRate));
  row("netR", fmtR(sA.netAvg), fmtR(sB.netAvg));
  row("PF", fmtPF(sA.pf), fmtPF(sB.pf));
  row("maxDD(R)", fmtR(-sA.maxDD), fmtR(-sB.maxDD));

  // Per setup + verdict.
  console.log("\nPER SETUP (net R / PF / n)  ->  verdict");
  console.log("  " + pad("setup", 20) + pad(`${tfA}`, 20) + pad(`${tfB}`, 20) + "verdict");
  console.log("  " + "-".repeat(78));
  const setups = [...new Set([...trades[tfA], ...trades[tfB]].map((t) => t.setupName))];
  for (const name of setups) {
    const a = stats(trades[tfA].filter((t) => t.setupName === name));
    const b = stats(trades[tfB].filter((t) => t.setupName === name));
    const cell = (s) => `${fmtR(s.netAvg)}/${fmtPF(s.pf)}/${s.n}`;
    console.log("  " + pad(name, 20) + pad(cell(a), 20) + pad(cell(b), 20) + compareVerdict(a, b, tfA, tfB, minV));
  }
  console.log("\nVerdicts use net expectancy; a TF needs >= min trades or its side is 'insufficient'. Not financial advice.");
}

// --- Walk-forward (single pair, or multiple pooled pairs) -------------------
// Folds are derived from the candles ACTUALLY available and cover the full
// usable range (fold math in js/walk.js). Pooled pairs share folds by TIMESTAMP.
function runWalkForward(seriesList, tf) {
  const warmup = CONFIG.backtest.warmup;
  const W = CONFIG.backtest.walk;
  const pairs = seriesList.length;
  const ref = seriesList.reduce((a, b) => (b.candles.length > a.candles.length ? b : a));
  const total = ref.candles.length;
  const fold = computeFolds(total, warmup, W.trainBars, W.testBars);

  // Header — make truncation visible.
  console.log(`WALK-FORWARD — ${pairs === 1 ? seriesList[0].sym : `${pairs} pairs pooled`} ${tf}`);
  console.log(`  candles: ${total}${pairs > 1 ? " (ref)" : ""} · warm-up: ${warmup} · usable: ${fold.usable} · train ${W.trainBars}/test ${W.testBars} bars · folds ${fold.folds.length} · coverage ${fold.coveragePct.toFixed(0)}%`);
  if (pairs > 1) console.log(`  pooled candles across ${pairs} pairs: ${seriesList.reduce((s, x) => s + x.candles.length, 0)}`);

  if (fold.insufficient) {
    console.log(`\n  INSUFFICIENT DATA: ${fold.reason}.`);
    console.log(`  Fetch more candles (per-request limits apply) or pool pairs with --data <dir>.`);
    return;
  }

  const tAt = (idx) => (idx >= total ? ref.candles[total - 1].time + 1 : ref.candles[idx].time);

  // Grid.
  const baseExpire = CONFIG.scalper.expireBars[tf] ?? 10;
  const baseRecency = CONFIG.gate.triggerRecencyBars;
  const baseCap = CONFIG.scalper.stopCapPct[tf];
  const grid = [];
  for (const minAgree of [6, 7])
    for (const capScale of [0.75, 1.0, 1.5])
      for (const expireBars of [baseExpire, Math.max(4, Math.round(baseExpire * 0.6))])
        for (const recency of [baseRecency, Math.max(2, baseRecency - 1)])
          grid.push({ minAgree, minRR: CONFIG.gate.minRR, capScale, expireBars, recency });

  // Precompute the expensive scan ONCE per distinct recency (the only detection
  // knob the grid varies), reused across all combos and folds via gateDecision.
  const distinctRecencies = [...new Set(grid.map((g) => g.recency))];
  const rawCache = new Map(); // recency -> array (parallel to seriesList) of rawByBar
  for (const rec of distinctRecencies) rawCache.set(rec, seriesList.map((s) => precomputeRaw(s, tf, rec)));
  const rawFor = (recency) => rawCache.get(recency);

  // Sizing sanity from the OBSERVED frequency (full-range pooled replay). Uses
  // the base recency (== current CONFIG), so it matches the pre-refactor path.
  const fullTrades = poolCheapReplay(seriesList, rawFor(baseRecency), tf, tAt(warmup), tAt(total));
  const tradesPerBar = fold.usable > 0 ? fullTrades.length / fold.usable : 0;
  const warn = sizingWarning(tradesPerBar, W.testBars, warmup, W.trainBars, W.minTradesPerFoldWarn, pairs);
  if (warn) {
    console.log(`\n  ⚠ SIZING: ~${warn.expected.toFixed(1)} trades expected per ${W.testBars}-bar test window (< ${W.minTradesPerFoldWarn}).`);
    console.log(`     To reach ${W.minTradesPerFoldWarn}/fold: ~${fmtN(warn.neededCandles)} candles per pair, OR pool ~${fmtN(warn.neededPairs)} pairs via --data <dir>.`);
  }

  const snap = { minAgree: CONFIG.gate.minAgree, minRR: CONFIG.gate.minRR, cap: baseCap, expire: baseExpire, recency: baseRecency };
  const applyG = (g) => {
    CONFIG.gate.minAgree = g.minAgree; CONFIG.gate.minRR = g.minRR;
    CONFIG.scalper.stopCapPct[tf] = baseCap * g.capScale;
    CONFIG.scalper.expireBars[tf] = g.expireBars;
    CONFIG.gate.triggerRecencyBars = g.recency;
  };

  console.log(`\n  grid ${grid.length} combos (minAgree×stopCap×expireBars×recency)`);
  console.log("  fold  chosen(minAgree,capScale,expire,recency)  trainN  trainNet  testN  testNet(OOS)  note");
  console.log("  " + "-".repeat(94));

  const oosAll = [];
  let included = 0;
  for (const F of fold.folds) {
    const tTrainFrom = tAt(F.trainFrom), tTrainTo = tAt(F.trainTo);
    const tTestFrom = tAt(F.testFrom), tTestTo = tAt(F.testTo);
    // Grid search on the (pooled) train window.
    let best = null;
    let maxTrainN = 0;
    for (const g of grid) {
      applyG(g);
      const tr = poolCheapReplay(seriesList, rawFor(g.recency), tf, tTrainFrom, tTrainTo);
      maxTrainN = Math.max(maxTrainN, tr.length);
      const exp = mean(tr.map((t) => t.netR));
      const score = tr.length >= W.minTrainTrades ? exp : -Infinity;
      if (!best || score > best.score) best = { g, score, exp, n: tr.length };
    }
    const selectionMade = best.score > -Infinity;
    const trainN = selectionMade ? best.n : maxTrainN; // real best-effort count for reporting
    // OOS trades under the chosen params (only if a real selection was made).
    let testTrades = [];
    if (selectionMade) { applyG(best.g); testTrades = poolCheapReplay(seriesList, rawFor(best.g.recency), tf, tTestFrom, tTestTo); }
    const gate = foldSelectable(trainN, testTrades.length, W.minTrainTrades, W.minTestTrades);

    if (!gate.selectable) {
      console.log("  " + pad(F.index, 6) + pad("— no selection —", 44) + pad(trainN, 8) + pad("—", 10) + pad(0, 7) + pad("—", 14) + gate.reason);
      continue;
    }
    if (gate.includeTest) { for (const t of testTrades) oosAll.push({ ...t, fold: F.index }); included++; }
    console.log("  " + pad(F.index, 6) + pad(`(${best.g.minAgree},${best.g.capScale},${best.g.expireBars},${best.g.recency})`, 44) + pad(trainN, 8) + pad(fmtR(best.exp), 10) + pad(testTrades.length, 7) + pad(fmtR(mean(testTrades.map((t) => t.netR))), 14) + (gate.includeTest ? "" : gate.reason));
  }
  // Restore config.
  CONFIG.gate.minAgree = snap.minAgree; CONFIG.gate.minRR = snap.minRR;
  CONFIG.scalper.stopCapPct[tf] = snap.cap; CONFIG.scalper.expireBars[tf] = snap.expire;
  CONFIG.gate.triggerRecencyBars = snap.recency;

  console.log(`\nAGGREGATE OUT-OF-SAMPLE (${included}/${fold.folds.length} folds contributed):`);
  if (oosAll.length) reportGroups({ OOS: oosAll }); else { console.log("  no OOS trades from qualifying folds."); return; }
  const e = mean(oosAll.map((t) => t.netR));
  console.log(`  -> walk-forward OOS net expectancy ${fmtR(e)} over ${oosAll.length} trades ${e > 0 ? "(positive)" : "(non-positive — be skeptical)"}`);
}

/** Pool replay over a TIME range using PRECOMPUTED evaluateRaw (cheap gate only). */
function poolCheapReplay(seriesList, rawArr, tf, tFrom, tTo) {
  const out = [];
  for (let k = 0; k < seriesList.length; k++) {
    const s = seriesList[k];
    const from = idxAtTime(s.candles, tFrom);
    const to = idxAtTime(s.candles, tTo);
    if (to > from) for (const tr of cheapReplay(s, rawArr[k], tf, from, to)) out.push(tr);
  }
  return out;
}
/** First index whose candle time is >= t (binary search; candles ascending). */
function idxAtTime(candles, t) {
  let lo = 0, hi = candles.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (candles[m].time < t) lo = m + 1; else hi = m; }
  return lo;
}
/** Load pooled series from a --data dir: <SYMBOL>.json with { tf: candles[] }. */
function loadDataDir(dir, tf, htfTf, regimeTf) {
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "manifest.json"); } catch { return []; }
  const toCandles = (arr) => (Array.isArray(arr) && arr.length && Array.isArray(arr[0]) ? mexc.parseKlines(arr) : Array.isArray(arr) ? arr : []);
  const series = [];
  for (const file of files) {
    let obj;
    try { obj = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")); } catch { continue; }
    const sym = obj.symbol || file.replace(/\.json$/i, "");
    const candles = toCandles(obj[tf]);
    if (candles.length >= CONFIG.backtest.warmup + 5) {
      series.push({ sym, candles, htf: toCandles(obj[htfTf]), regime: toCandles(obj[regimeTf]) });
    }
  }
  return series;
}

// --- helpers ---------------------------------------------------------------
function maxDrawdownR(trades) {
  const seq = [...trades].sort((a, b) => (a.fillIndex ?? 0) - (b.fillIndex ?? 0));
  let eq = 0, peak = 0, dd = 0;
  for (const t of seq) { eq += t.netR; if (eq > peak) peak = eq; if (peak - eq > dd) dd = peak - eq; }
  return dd;
}
function groupBy(arr, keyFn) { const o = {}; for (const x of arr) (o[keyFn(x)] ||= []).push(x); return o; }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }
function pad(s, w) { return String(s).padEnd(w); }
function fmtPct(v) { return Number.isFinite(v) ? v.toFixed(0) + "%" : "—"; }
function fmtR(v) { return Number.isFinite(v) ? (v >= 0 ? "+" : "") + v.toFixed(2) : "—"; }
function fmtPF(v) { return v === Infinity ? "∞" : Number.isFinite(v) ? v.toFixed(2) : "—"; }
function fmtN(v) { return Number.isFinite(v) ? String(v) : "∞"; }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
