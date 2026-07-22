// ============================================================================
// backtest.js — Prove the setup + gate + scalper guardrails on MEXC data.
//
//   node backtest.js SYMBOL TF CANDLES      e.g. node backtest.js BTCUSDT 5m 1000
//   node backtest.js --scan TF CANDLES      run across the current top-50 list
//   node backtest.js --demo [TF] [CANDLES]  offline synthetic data (no network)
//   node backtest.js --demo --scan TF N     offline scan across mock symbols
//
// Replays candles bar-by-bar through the SAME evaluate() gate the scanner uses
// (no look-ahead; HTF derived by resampling). Simulates each emitted plan:
// limit fill -> half off at TP1 -> stop to breakeven -> runner to TP2, with
// conservative intrabar fills. Reports per setup type / per tier (and per pair
// in --scan): signals, win rate, avg R, expectancy, max drawdown in R. Flags any
// setup type with negative expectancy to disable in config.js.
// ============================================================================
import { CONFIG } from "./js/config.js";
import { evaluate } from "./js/confluence.js";
import { resampleToHTF, htfFactor } from "./js/htf.js";
import * as mexc from "./js/mexc.js";
import { MockProvider } from "./js/mockprovider.js";

main().catch((e) => { console.error("Backtest failed:", e.message); process.exit(1); });

async function main() {
  const args = process.argv.slice(2);
  const demo = args.includes("--demo");
  const scan = args.includes("--scan");
  const pos = args.filter((a) => !a.startsWith("--"));
  const nums = pos.filter((a) => /^\d+$/.test(a));
  const words = pos.filter((a) => !/^\d+$/.test(a));
  const limit = clamp(parseInt(nums[0], 10) || 800, 200, 1500);
  // Args: SYMBOL TF CANDLES. In --scan the only word is TF; in --demo the
  // symbol is forced (BTCUSDT) so a lone word is the TF.
  let symbolArg, tf;
  if (scan) { tf = words[0] || "5m"; }
  else if (demo) { symbolArg = "BTCUSDT"; tf = words[0] || "5m"; }
  else { symbolArg = (words[0] || "BTCUSDT").toUpperCase(); tf = words[1] || "5m"; }
  const htfTf = CONFIG.htfMap[tf] || "15m";
  const factor = htfFactor(tf, htfTf);

  const mock = demo ? new MockProvider({ full: true }) : null;
  const getSeries = async (sym) => (demo ? mock.getKlines(sym, tf, limit) : mexc.getKlines(sym, tf, limit));

  // Which symbols to test?
  let symbols;
  if (scan) {
    const tickers = demo ? await mock.get24hr() : await mexc.get24hr();
    symbols = mexc.rankTopPairs(tickers, CONFIG.scanner.topN).map((t) => t.symbol);
  } else {
    symbols = [demo ? "BTCUSDT" : symbolArg];
  }

  console.log(`\nBacktest — ${scan ? `SCAN top-${symbols.length}` : symbols[0]} · ${tf} · ${limit} candles · HTF ${htfTf} (×${factor}) · ${demo ? "synthetic demo" : "MEXC"}`);
  console.log(`Gate: setup + >=${CONFIG.gate.minAgree}/10 aligned, no veto, HTF not counter, R:R>=${CONFIG.gate.minRR}, stop<=${CONFIG.scalper.stopCapPct[tf]}%`);
  console.log(`Sim: half off at TP1 (${CONFIG.gate.tp1R}R), stop->BE, runner to TP2 (${CONFIG.gate.tp2R}R), conservative intrabar\n`);

  const allTrades = [];
  const perPair = {};
  for (const sym of symbols) {
    let candles;
    try { candles = await getSeries(sym); }
    catch (e) { if (!scan) throw e; console.error(`  ${sym}: fetch failed (${e.message})`); continue; }
    if (!candles || candles.length < CONFIG.backtest.warmup + 30) continue;
    const trades = replay(candles, sym, tf, factor);
    perPair[sym] = trades;
    for (const t of trades) allTrades.push(t);
    if (!demo) await sleep(CONFIG.timing.klineStaggerMs); // politeness in real --scan
  }

  if (scan) {
    console.log("BY PAIR");
    reportGroups(perPair, Object.keys(perPair).filter((k) => perPair[k].length));
    console.log("");
  }
  if (allTrades.length === 0) { console.log("No filled trades on this sample."); return finish(); }

  console.log("BY SETUP TYPE");
  reportGroups(groupBy(allTrades, (t) => t.setupName));
  console.log("\nBY TIER");
  reportGroups(groupBy(allTrades, (t) => t.tier), ["A+", "A", "B"]);
  console.log("\nOVERALL");
  reportGroups({ ALL: allTrades });

  const bySetup = groupBy(allTrades, (t) => t.setupId);
  const negatives = Object.entries(bySetup).filter(([, ts]) => mean(ts.map((t) => t.netR)) < 0);
  console.log("");
  if (negatives.length) {
    console.log("⚠ Negative-expectancy setups on this sample:");
    for (const [id, ts] of negatives) console.log(`   - ${id}: expectancy ${fmtR(mean(ts.map((t) => t.netR)))} over ${ts.length} trades -> set CONFIG.setups.${id}.enabled = false`);
  } else {
    console.log("No setup showed negative expectancy on this sample.");
  }
  finish();
}

function finish() {
  console.log("\nSmall single-sample study; conservative fills make results a floor, not a promise. Not financial advice.");
}

// --- Replay one symbol -----------------------------------------------------
function replay(candles, sym, tf, factor) {
  const warmup = CONFIG.backtest.warmup;
  const emitted = [];
  const seen = new Set();
  for (let i = warmup; i < candles.length - 2; i++) {
    const slice = candles.slice(0, i + 1);
    const htfSlice = resampleToHTF(slice, factor);
    const dec = evaluate(slice, htfSlice, { symbol: sym, interval: tf, htfInterval: `${tf}-HTF` });
    if (dec.status !== "ACTIVE") continue; // only LOCKED signals are traded
    const p = dec.plan;
    const key = `${p.id}:${p.triggerIndex}:${p.direction}`;
    if (seen.has(key)) continue;
    seen.add(key);
    emitted.push(p);
  }
  const trades = [];
  for (const plan of emitted) {
    const t = simulateTrade(candles, plan);
    if (t.filled) trades.push({ pair: sym, setupId: plan.id, setupName: plan.name, tier: plan.tier, ...t });
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
    const c = candles[j];
    if (long ? c.low <= plan.entryHigh : c.high >= plan.entryLow) { fillIndex = j; break; }
  }
  if (fillIndex === -1) return { filled: false };

  let tp1 = false, stop = plan.stop, mae = 0;
  for (let k = fillIndex; k < candles.length; k++) {
    const c = candles[k];
    const adverse = long ? (c.low - entry) / R : (entry - c.high) / R;
    if (adverse < mae) mae = adverse;
    if (!tp1) {
      const hitStop = long ? c.low <= stop : c.high >= stop;
      const hitTp1 = long ? c.high >= plan.tp1 : c.low <= plan.tp1;
      if (hitStop) return done(-1, k);
      if (hitTp1) { tp1 = true; stop = entry; }
    } else {
      const hitBE = long ? c.low <= stop : c.high >= stop;
      const hitTp2 = long ? c.high >= plan.tp2 : c.low <= plan.tp2;
      if (hitBE) return done(0.75, k);
      if (hitTp2) return done(2.25, k);
    }
  }
  const lastClose = candles[candles.length - 1].close;
  const mtm = long ? (lastClose - entry) / R : (entry - lastClose) / R;
  return { filled: true, netR: tp1 ? 0.5 * 1.5 + 0.5 * mtm : mtm, open: true, fillIndex, maeR: mae };
  function done(netR, k) { return { filled: true, netR, open: false, fillIndex, exitIndex: k, maeR: mae }; }
}

// --- Reporting -------------------------------------------------------------
function reportGroups(groups, order) {
  const keys = order ? order.filter((k) => groups[k]?.length) : Object.keys(groups);
  console.log("  " + pad("group", 20) + pad("n", 5) + pad("win%", 7) + pad("avgR", 8) + pad("expect", 8) + pad("maxDD(R)", 10) + "open");
  console.log("  " + "-".repeat(64));
  for (const k of keys) {
    const ts = groups[k];
    const n = ts.length;
    const wins = ts.filter((t) => t.netR > 0.0001).length;
    const avg = mean(ts.map((t) => t.netR));
    const dd = maxDrawdownR(ts);
    const open = ts.filter((t) => t.open).length;
    console.log("  " + pad(k, 20) + pad(n, 5) + pad(fmtPct((wins / n) * 100), 7) + pad(fmtR(avg), 8) + pad(fmtR(avg), 8) + pad(fmtR(-dd), 10) + open);
  }
}
function maxDrawdownR(trades) {
  const seq = [...trades].sort((a, b) => a.fillIndex - b.fillIndex);
  let eq = 0, peak = 0, dd = 0;
  for (const t of seq) { eq += t.netR; if (eq > peak) peak = eq; if (peak - eq > dd) dd = peak - eq; }
  return dd;
}
function groupBy(arr, keyFn) { const o = {}; for (const x of arr) (o[keyFn(x)] ||= []).push(x); return o; }

// --- helpers ---------------------------------------------------------------
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }
function pad(s, w) { return String(s).padEnd(w); }
function fmtPct(v) { return Number.isFinite(v) ? v.toFixed(0) + "%" : "—"; }
function fmtR(v) { return Number.isFinite(v) ? (v >= 0 ? "+" : "") + v.toFixed(2) : "—"; }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
