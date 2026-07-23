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
import { evaluate } from "./js/confluence.js";
import { computeR } from "./js/costs.js";
import { htfSliceAtTime, intervalMinutes } from "./js/htf.js";
import * as mexc from "./js/mexc.js";
import { MockProvider } from "./js/mockprovider.js";

main().catch((e) => { console.error("Backtest failed:", e.message); process.exit(1); });

async function main() {
  const args = process.argv.slice(2);
  const demo = args.includes("--demo");
  const scan = args.includes("--scan");
  const matrix = args.includes("--matrix");
  const walk = args.includes("--walk");
  const splitIdx = args.indexOf("--split");
  const doSplit = splitIdx !== -1;
  const pos = args.filter((a) => !a.startsWith("--"));
  const nums = pos.filter((a) => /^\d+$/.test(a));
  const words = pos.filter((a) => !/^\d+$/.test(a));
  const floats = pos.filter((a) => /^\d*\.\d+$/.test(a));
  const splitFrac = doSplit ? (parseFloat(floats[0]) || 0.7) : 0.7;
  const limit = clamp(parseInt(nums[0], 10) || 800, 200, 1500);
  let symbolArg, tf;
  if (scan) { tf = words[0] || "5m"; }
  else if (demo) { symbolArg = "BTCUSDT"; tf = words[0] || "5m"; }
  else { symbolArg = (words[0] || "BTCUSDT").toUpperCase(); tf = words[1] || "5m"; }

  const provider = demo ? new MockProvider({ full: true }) : { getKlines: mexc.getKlines, get24hr: mexc.get24hr };
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

  console.log(`\nBacktest — ${scan ? `SCAN top-${symbols.length}` : symbols[0]} · ${timeframes.join("/")} · ${limit} candles · HTF ${htfTf}+${regimeTf} (real) · ${demo ? "synthetic demo" : "MEXC"}`);
  console.log(`Gate: setup + >=${CONFIG.gate.minAgree}/10 aligned, no veto, HTF not counter, R:R>=${CONFIG.gate.minRR}, stop<=cap`);
  const c = CONFIG.costs;
  console.log(`Costs: fees ${(c.fees.makerPct * 100).toFixed(3)}/${(c.fees.takerPct * 100).toFixed(3)}%, slip ${(c.slippage.entryPct * 100).toFixed(3)}/${(c.slippage.stopPct * 100).toFixed(3)}%, spread ${(c.spreadPct * 100).toFixed(3)}% -> gross & net R\n`);

  // --- Gather trades (all symbols × timeframes) ----------------------------
  // Fetch REAL higher-timeframe series (bias + regime) once per (symbol, htfIv),
  // consumed via htfSliceAtTime — identical to the live scanner (parity).
  const htfCache = new Map();
  const fetchHtf = async (sym, htfIv) => {
    const key = `${sym}:${htfIv}`;
    if (htfCache.has(key)) return htfCache.get(key);
    const baseTf = matrix ? "5m" : tf;
    const hl = clamp(Math.ceil((limit * intervalMinutes(baseTf)) / intervalMinutes(htfIv)) + 80, 100, 1000);
    let h = [];
    try { h = await provider.getKlines(sym, htfIv, hl); } catch { h = []; }
    htfCache.set(key, h);
    return h;
  };

  const all = [];
  for (const sym of symbols) {
    const htf = await fetchHtf(sym, htfTf);
    const regime = await fetchHtf(sym, regimeTf);
    for (const t of timeframes) {
      let candles;
      try { candles = await provider.getKlines(sym, t, limit); }
      catch (e) { if (!scan) throw e; console.error(`  ${sym} ${t}: fetch failed (${e.message})`); continue; }
      if (!candles || candles.length < CONFIG.backtest.warmup + 30) continue;
      if (walk && !scan && !matrix) { await runWalkForward(candles, sym, t, htf, regime); return finish(); }
      for (const tr of replay(candles, sym, t, htf, regime)) all.push(tr);
      if (!demo) await sleep(CONFIG.timing.klineStaggerMs);
    }
  }
  if (walk) { console.log("--walk runs on a single symbol/timeframe (omit --scan/--matrix)."); return finish(); }

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

// --- Trade simulation (half off at TP1 -> BE -> runner to TP2) --------------
function simulateTrade(candles, plan) {
  const long = plan.direction === "LONG";
  const entry = plan.entryPrice;
  const R = Math.abs(entry - plan.stop);
  if (R <= 0) return { filled: false };
  const maxFill = CONFIG.backtest.maxBarsToFill;
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

// --- Walk-forward ----------------------------------------------------------
async function runWalkForward(candles, sym, tf, htf, regime) {
  const folds = 3;
  const warmup = CONFIG.backtest.warmup;
  const usable = candles.length - warmup;
  const win = Math.floor(usable / (folds + 1));
  if (win < 40) { console.log("Not enough candles for walk-forward (need more)."); return; }

  const grid = [];
  for (const minAgree of [6, 7]) for (const minRR of [1.2, 1.5]) for (const capScale of [1.0, 1.5]) grid.push({ minAgree, minRR, capScale });

  const snap = { minAgree: CONFIG.gate.minAgree, minRR: CONFIG.gate.minRR, cap: CONFIG.scalper.stopCapPct[tf] };
  const baseCap = snap.cap;
  const oosAll = [];
  console.log(`WALK-FORWARD — ${sym} ${tf} · ${folds} folds · grid ${grid.length} combos (minAgree×minRR×stopCap)\n`);
  console.log("  fold  train[from:to]  chosen(minAgree,minRR,capScale)  trainNet  testNet(OOS)  nTest");
  console.log("  " + "-".repeat(78));

  for (let f = 0; f < folds; f++) {
    const trainFrom = warmup + f * win, trainTo = trainFrom + win;
    const testFrom = trainTo, testTo = Math.min(candles.length - 2, testFrom + win);
    // Grid search on the train window.
    let best = null;
    for (const g of grid) {
      CONFIG.gate.minAgree = g.minAgree; CONFIG.gate.minRR = g.minRR; CONFIG.scalper.stopCapPct[tf] = baseCap * g.capScale;
      const tr = replay(candles, sym, tf, htf, regime, trainFrom, trainTo);
      const exp = mean(tr.map((t) => t.netR));
      const score = tr.length >= 3 ? exp : -Infinity; // ignore too-thin combos
      if (!best || score > best.score) best = { g, score, exp, n: tr.length };
    }
    // Evaluate chosen params out-of-sample.
    CONFIG.gate.minAgree = best.g.minAgree; CONFIG.gate.minRR = best.g.minRR; CONFIG.scalper.stopCapPct[tf] = baseCap * best.g.capScale;
    const oos = replay(candles, sym, tf, htf, regime, testFrom, testTo).map((t) => ({ ...t, fold: f }));
    for (const t of oos) oosAll.push(t);
    console.log("  " + pad(f, 6) + pad(`${trainFrom}:${trainTo}`, 16) + pad(`(${best.g.minAgree},${best.g.minRR},${best.g.capScale})`, 32) + pad(fmtR(best.exp), 10) + pad(fmtR(mean(oos.map((t) => t.netR))), 13) + oos.length);
  }
  // Restore config.
  CONFIG.gate.minAgree = snap.minAgree; CONFIG.gate.minRR = snap.minRR; CONFIG.scalper.stopCapPct[tf] = snap.cap;

  console.log("\nAGGREGATE OUT-OF-SAMPLE (chosen params per fold):");
  if (oosAll.length) reportGroups({ OOS: oosAll }); else console.log("  no OOS trades.");
  const e = mean(oosAll.map((t) => t.netR));
  console.log(`  -> walk-forward OOS net expectancy ${fmtR(e)} over ${oosAll.length} trades ${e > 0 ? "(positive)" : "(non-positive — be skeptical)"}`);
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
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
