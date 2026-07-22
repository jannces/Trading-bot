// ============================================================================
// backtest.js — Prove the setup + gate logic on historical data.
//
//   node backtest.js SYMBOL TF CANDLES     e.g. node backtest.js BTCUSDT 5m 1000
//   node backtest.js --demo [CANDLES]      offline synthetic data (no network)
//
// It replays candles bar-by-bar through the EXACT SAME evaluate() gate the
// dashboard uses (no look-ahead: only candles[0..i] are visible at bar i). The
// higher-timeframe bias is derived by resampling those same candles, so live
// and backtest share one code path. Each emitted plan is simulated:
//   - limit entry fills when price trades into the zone (else expires),
//   - HALF off at TP1, stop moved to BREAKEVEN, runner to TP2,
//   - conservative intrabar order: stop/BE assumed to fill before a target.
// Reports per SETUP TYPE and per TIER: signals, win rate, avg R, expectancy,
// and max drawdown in R (equity curve).
// ============================================================================
import { CONFIG } from "./js/config.js";
import { evaluate } from "./js/confluence.js";
import { fetchMarketData } from "./js/api.js";
import { resampleToHTF, htfFactor } from "./js/htf.js";

main().catch((e) => { console.error("Backtest failed:", e.message); process.exit(1); });

async function main() {
  const args = process.argv.slice(2);
  const demo = args.includes("--demo");
  const pos = args.filter((a) => !a.startsWith("--"));
  const nums = pos.filter((a) => /^\d+$/.test(a));
  const words = pos.filter((a) => !/^\d+$/.test(a));
  const symbol = demo ? "DEMO" : (words[0] || CONFIG.defaultPair).toUpperCase();
  const interval = words[1] || CONFIG.defaultInterval;
  const limit = clamp(parseInt(nums[0], 10) || 500, 200, 1500);
  const htfInterval = CONFIG.htfMap[interval] || interval;
  const factor = htfFactor(interval, htfInterval);

  let candles, source;
  if (demo) {
    candles = synthCandles(limit);
    source = "synthetic demo data";
  } else {
    console.log(`Fetching ${symbol} ${interval} (${limit} candles)…`);
    const md = await fetchMarketData(symbol, interval, limit);
    candles = md.candles;
    source = md.source;
  }

  console.log(`\nBacktest — ${symbol} ${interval} · ${candles.length} candles · HTF ${htfInterval} (×${factor}) · source: ${source}`);
  console.log(`Gate: setup + >=${CONFIG.gate.minAgree}/10 aligned, no veto (${CONFIG.gate.vetoStrategies.join("/").toUpperCase()}), HTF not counter, R:R>=${CONFIG.gate.minRR}`);
  console.log(`Sim: half off at TP1 (${CONFIG.gate.tp1R}R), stop->BE, runner to TP2 (${CONFIG.gate.tp2R}R), conservative intrabar\n`);

  const warmup = CONFIG.backtest.warmup;
  if (candles.length < warmup + 30) throw new Error(`need >= ${warmup + 30} candles, got ${candles.length}`);

  // --- Replay: collect distinct emitted plans (deduped by trigger) ---------
  const emitted = [];
  const seen = new Set();
  for (let i = warmup; i < candles.length - 2; i++) {
    const slice = candles.slice(0, i + 1);
    const htfSlice = resampleToHTF(slice, factor);
    const decision = evaluate(slice, htfSlice, { symbol, interval, htfInterval });
    if (decision.status !== "ACTIVE") continue;
    const p = decision.plan;
    const key = `${p.id}:${p.triggerIndex}:${p.direction}`;
    if (seen.has(key)) continue;
    seen.add(key);
    emitted.push(p);
  }

  // --- Simulate each plan on the full series -------------------------------
  const trades = [];
  let noFill = 0;
  for (const plan of emitted) {
    const t = simulateTrade(candles, plan);
    if (!t.filled) { noFill++; continue; }
    trades.push({ setupId: plan.id, setupName: plan.name, tier: plan.tier, ...t });
  }

  console.log(`Emitted ${emitted.length} distinct plans · ${trades.length} filled · ${noFill} expired unfilled\n`);
  if (trades.length === 0) {
    console.log("No filled trades to score on this sample. (Widen the sample, or the gate may be too strict for this data.)");
    finish();
    return;
  }

  // --- Report by setup type + by tier --------------------------------------
  console.log("BY SETUP TYPE");
  reportGroups(groupBy(trades, (t) => t.setupName));
  console.log("\nBY TIER");
  reportGroups(groupBy(trades, (t) => t.tier), ["A+", "A", "B"]);
  console.log("\nOVERALL");
  reportGroups({ ALL: trades });

  // --- Negative-expectancy guidance ----------------------------------------
  const bySetup = groupBy(trades, (t) => t.setupId);
  const negatives = Object.entries(bySetup).filter(([, ts]) => expectancy(ts) < 0);
  console.log("");
  if (negatives.length) {
    console.log("⚠ Negative-expectancy setups on this sample:");
    for (const [id, ts] of negatives) console.log(`   - ${id}: expectancy ${fmtR(expectancy(ts))} over ${ts.length} trades -> consider CONFIG.setups.${id}.enabled = false`);
  } else {
    console.log("No setup showed negative expectancy on this sample.");
  }
  finish();
}

function finish() {
  console.log("\nNotes: small single-sample study; conservative fills make results a floor, not a promise.");
  console.log("Not financial advice.");
}

// ---------------------------------------------------------------------------
// Trade simulation: limit fill -> half at TP1 -> BE -> runner to TP2.
// Returns { filled, netR, resolved, open, fillIndex, exitIndex, maeR, barsHeld }
// ---------------------------------------------------------------------------
function simulateTrade(candles, plan) {
  const long = plan.direction === "LONG";
  const entry = plan.entryPrice;
  const R = Math.abs(entry - plan.stop);
  if (R <= 0) return { filled: false };
  const tp1 = plan.tp1, tp2 = plan.tp2;
  const maxFill = CONFIG.backtest.maxBarsToFill;

  // 1) Fill the limit entry.
  let fillIndex = -1;
  for (let j = plan.triggerIndex + 1; j < candles.length && j <= plan.triggerIndex + maxFill; j++) {
    const c = candles[j];
    if (long ? c.low <= plan.entryHigh : c.high >= plan.entryLow) { fillIndex = j; break; }
  }
  if (fillIndex === -1) return { filled: false };

  // 2) Manage the trade.
  let tp1done = false;
  let stop = plan.stop;
  let mae = 0; // most adverse excursion in R (negative)
  for (let k = fillIndex; k < candles.length; k++) {
    const c = candles[k];
    const adverse = long ? (c.low - entry) / R : (entry - c.high) / R;
    if (adverse < mae) mae = adverse;

    if (!tp1done) {
      const hitStop = long ? c.low <= stop : c.high >= stop;
      const hitTp1 = long ? c.high >= tp1 : c.low <= tp1;
      if (hitStop) return done(-1, true, k); // conservative: stop before TP1
      if (hitTp1) { tp1done = true; stop = entry; } // half booked +1.5R, runner stop -> BE
    } else {
      const hitBE = long ? c.low <= stop : c.high >= stop;
      const hitTp2 = long ? c.high >= tp2 : c.low <= tp2;
      if (hitBE) return done(0.5 * 1.5 + 0.5 * 0, true, k); // conservative: BE before TP2
      if (hitTp2) return done(0.5 * 1.5 + 0.5 * 3, true, k);
    }
  }
  // 3) Unresolved at data end -> mark to market.
  const lastClose = candles[candles.length - 1].close;
  const mtm = long ? (lastClose - entry) / R : (entry - lastClose) / R;
  const netR = tp1done ? 0.5 * 1.5 + 0.5 * mtm : mtm;
  return { filled: true, netR, resolved: false, open: true, fillIndex, exitIndex: candles.length - 1, maeR: mae, barsHeld: candles.length - 1 - fillIndex };

  function done(netR, resolved, k) {
    return { filled: true, netR, resolved, open: false, fillIndex, exitIndex: k, maeR: mae, barsHeld: k - fillIndex };
  }
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------
function reportGroups(groups, order) {
  const keys = order ? order.filter((k) => groups[k]) : Object.keys(groups);
  console.log("  " + pad("group", 20) + pad("n", 5) + pad("win%", 7) + pad("avgR", 8) + pad("expect", 8) + pad("maxDD(R)", 10) + "open");
  console.log("  " + "-".repeat(64));
  for (const k of keys) {
    const ts = groups[k];
    const n = ts.length;
    const wins = ts.filter((t) => t.netR > 0.0001).length;
    const winRate = (wins / n) * 100;
    const avg = mean(ts.map((t) => t.netR));
    const dd = maxDrawdownR(ts);
    const open = ts.filter((t) => t.open).length;
    console.log(
      "  " + pad(k, 20) + pad(n, 5) + pad(fmtPct(winRate), 7) + pad(fmtR(avg), 8) + pad(fmtR(avg), 8) + pad(fmtR(-dd), 10) + open
    );
  }
}

function maxDrawdownR(trades) {
  // Equity curve in R, ordered by fill index.
  const seq = [...trades].sort((a, b) => a.fillIndex - b.fillIndex);
  let equity = 0, peak = 0, dd = 0;
  for (const t of seq) {
    equity += t.netR;
    if (equity > peak) peak = equity;
    if (peak - equity > dd) dd = peak - equity;
  }
  return dd;
}

function expectancy(trades) { return mean(trades.map((t) => t.netR)); }
function groupBy(arr, keyFn) {
  const out = {};
  for (const x of arr) { const k = keyFn(x); (out[k] ||= []).push(x); }
  return out;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }
function pad(s, w) { return String(s).padEnd(w); }
function fmtPct(v) { return Number.isFinite(v) ? v.toFixed(0) + "%" : "—"; }
function fmtR(v) { return Number.isFinite(v) ? (v >= 0 ? "+" : "") + v.toFixed(2) : "—"; }

/** Offline synthetic candles with trend regimes + injected sweeps/pullbacks. */
function synthCandles(n) {
  const candles = [];
  let p = 100;
  for (let i = 0; i < n; i++) {
    const regime = Math.floor(i / 90) % 4; // up, down, chop, up
    const drift = regime === 0 || regime === 3 ? 0.16 : regime === 1 ? -0.2 : 0.0;
    p += drift + Math.sin(i / 8) * 0.7 + (Math.random() - 0.5) * 1.0;
    p = Math.max(5, p);
    let o = p - (Math.random() - 0.5) * 0.5;
    let c = p + (Math.random() - 0.5) * 0.5;
    let h = Math.max(o, c) + Math.random() * 0.7;
    let l = Math.min(o, c) - Math.random() * 0.7;
    // Every ~37 bars inject a liquidity-sweep wick then reversal close.
    if (i % 37 === 0 && i > 5) {
      const sweepDown = regime === 0 || regime === 3;
      if (sweepDown) { l -= 2.2; c = Math.max(o, c) + 0.4; }
      else { h += 2.2; c = Math.min(o, c) - 0.4; }
    }
    candles.push({ time: i * 300000, open: o, high: h, low: l, close: c, volume: 120 + Math.random() * 500 });
  }
  return candles;
}
