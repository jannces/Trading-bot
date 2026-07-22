// ============================================================================
// backtest.js — Replay recent candles through the confluence engine and measure
// how the "High Quality" signals would have performed at 1.5R / 3R.
//
// It reuses the EXACT same code the dashboard uses (js/strategies, js/confluence,
// js/config), so results reflect your live config.js weights. Nothing here is
// financial advice — it's a tool to make weight/threshold tuning measurable.
//
// USAGE
//   node backtest.js [SYMBOL] [INTERVAL] [LIMIT]
//     e.g.  node backtest.js BTCUSDT 15m 1000
//   node backtest.js --demo            (offline: synthetic candles, no network)
//
// Defaults: BTCUSDT 15m 500.  LIMIT is clamped to 300..1000.
//
// METHOD (no look-ahead)
//   For every bar i (after a warm-up), it runs all 10 strategies on candles[0..i]
//   only, scores the confluence, and — if a trade direction exists — builds the
//   same illustrative plan the UI shows (entry = close of bar i, ATR/swing stop,
//   TP1 = 1.5R, TP2 = 3R). It then walks candles FORWARD to see what got hit.
//
//   Intrabar ordering is CONSERVATIVE: if a candle's range spans both the stop
//   and a target, the STOP is assumed to fill first (pessimistic), so win-rates
//   here are a floor, not an optimistic ceiling.
//
//   Because the plan is threshold-independent, each bar's forward outcome is
//   simulated ONCE and cached, then the High-Quality gate is swept across
//   several (min-agreement × min-composite) settings so you can see whether
//   7-of-10 is too strict (few signals) or too loose (poor win-rate).
// ============================================================================
import { CONFIG } from "./js/config.js";
import { runAll } from "./js/strategies/index.js";
import { computeConfluence, buildTradePlan } from "./js/confluence.js";
import { fetchMarketData } from "./js/api.js";

const WARMUP = 120; // bars of history before the first evaluated signal
const MIN_FORWARD = 8; // require at least this many bars ahead to evaluate a bar

// Threshold grid for the sweep (rows = min agreeing strategies, cols = |composite|).
const AGREE_GRID = [5, 6, 7, 8];
const COMPOSITE_GRID = [50, 60, 70];

main().catch((e) => {
  console.error("Backtest failed:", e.message);
  process.exit(1);
});

async function main() {
  const args = process.argv.slice(2);
  const demo = args.includes("--demo");
  const positional = args.filter((a) => !a.startsWith("--"));
  // Numeric token = LIMIT (any position); word tokens = symbol then interval.
  const nums = positional.filter((a) => /^\d+$/.test(a));
  const words = positional.filter((a) => !/^\d+$/.test(a));
  const symbol = demo ? "DEMO" : (words[0] || CONFIG.defaultPair).toUpperCase();
  const interval = words[1] || CONFIG.defaultInterval;
  const limit = clamp(parseInt(nums[0], 10) || 500, 300, 1000);

  let candles;
  let source;
  if (demo) {
    candles = synthCandles(limit);
    source = "synthetic demo data";
  } else {
    console.log(`Fetching ${symbol} ${interval} (${limit} candles)…`);
    const md = await fetchMarketData(symbol, interval, limit);
    candles = md.candles;
    source = md.source;
  }

  console.log(`\nBacktest — ${symbol} ${interval} · ${candles.length} candles · source: ${source}`);
  console.log(`Weights: ${JSON.stringify(CONFIG.weights)}`);
  console.log(
    `Live config gate: >=${CONFIG.highQuality.minAgreeing}/10 agree AND |composite|>=${CONFIG.highQuality.minComposite}` +
      `  (stop=ATR${CONFIG.risk.atrPeriod}×${CONFIG.risk.atrStopMultiplier} or swing; TP ${CONFIG.risk.tp1R}R/${CONFIG.risk.tp2R}R)\n`
  );

  if (candles.length < WARMUP + MIN_FORWARD + 5) {
    throw new Error(`need at least ~${WARMUP + MIN_FORWARD + 5} candles, got ${candles.length}`);
  }

  // --- Pass 1: per-bar confluence + cached forward outcome ----------------
  const evaluated = []; // one entry per bar that produced a directional plan
  const lastEval = candles.length - 1 - MIN_FORWARD;
  for (let i = WARMUP; i <= lastEval; i++) {
    const slice = candles.slice(0, i + 1);
    const results = runAll(slice);
    const conf = computeConfluence(results, slice);
    if (conf.composite === 0) continue; // no directional bias -> no trade

    const direction = conf.composite >= 0 ? "BUY" : "SELL";
    const agreeing = direction === "BUY" ? conf.buys : conf.sells;
    const plan = buildTradePlan(direction, slice);
    const entry = slice[i].close;
    const outcome = simulateForward(candles, i, direction, entry, plan.stop, plan.tp1, plan.tp2);

    evaluated.push({
      index: i,
      direction,
      agreeing,
      absComposite: Math.abs(conf.composite),
      outcome,
    });
  }

  console.log(`Evaluated ${evaluated.length} directional bars (of ${lastEval - WARMUP + 1} candidate bars).\n`);

  // --- Pass 2: threshold sweep -------------------------------------------
  console.log("HIGH-QUALITY GATE SWEEP  (how many signals fire, and how they did)");
  console.log("  Each cell reports for signals passing that gate:");
  console.log("    n = signal count · freq = % of evaluated bars · TP1% / TP2% = win-rate reaching 1.5R / 3R");
  console.log("    E1 / E3 = expectancy in R per trade for the 'exit at TP1' and 'exit at TP2' plans\n");

  header();
  for (const agree of AGREE_GRID) {
    for (const comp of COMPOSITE_GRID) {
      const subset = evaluated.filter((e) => e.agreeing >= agree && e.absComposite >= comp);
      const stats = aggregate(subset, evaluated.length);
      const isLive = agree === CONFIG.highQuality.minAgreeing && comp === CONFIG.highQuality.minComposite;
      printRow(agree, comp, stats, isLive);
    }
  }

  // --- Detail for the LIVE config gate -----------------------------------
  const live = evaluated.filter(
    (e) => e.agreeing >= CONFIG.highQuality.minAgreeing && e.absComposite >= CONFIG.highQuality.minComposite
  );
  console.log("\nLIVE CONFIG DETAIL (your current config.js gate)");
  reportDetail(live);

  console.log("\nReading this:");
  console.log("  • Too FEW signals at your gate?  Lower minAgreeing or minComposite in config.js.");
  console.log("  • Plenty of signals but weak TP1%/E1?  The gate is too loose, or weights need work.");
  console.log("  • Compare rows to find the sweet spot BEFORE you trust any single setting.");
  console.log("  • Conservative intrabar rule (stop wins ties) makes these win-rates a floor.");
  console.log("\nNot financial advice. Past behaviour on a small sample does not predict the future.");
}

// ---------------------------------------------------------------------------
// Forward simulation of a single trade (no look-ahead beyond the entry bar).
// Returns a result tag + whether TP1 was reached before the stop.
// ---------------------------------------------------------------------------
function simulateForward(candles, i, dir, entry, stop, tp1, tp2) {
  let tp1Reached = false;
  for (let j = i + 1; j < candles.length; j++) {
    const h = candles[j].high;
    const l = candles[j].low;
    let stopHit, tp1Hit, tp2Hit;
    if (dir === "BUY") {
      stopHit = l <= stop;
      tp1Hit = h >= tp1;
      tp2Hit = h >= tp2;
    } else {
      stopHit = h >= stop;
      tp1Hit = l <= tp1;
      tp2Hit = l <= tp2;
    }
    // Conservative: if the stop is touched this bar, it fills first.
    if (stopHit) {
      return { result: tp1Reached ? "TP1_THEN_STOP" : "STOP", barsHeld: j - i, tp1Reached };
    }
    if (tp2Hit) return { result: "TP2", barsHeld: j - i, tp1Reached: true };
    if (tp1Hit) tp1Reached = true;
  }
  return { result: tp1Reached ? "TP1_OPEN" : "OPEN", barsHeld: candles.length - 1 - i, tp1Reached };
}

// ---------------------------------------------------------------------------
// Aggregate a subset of evaluated signals into win-rates + expectancy.
//   Plan A ("exit at TP1"): win = TP1 reached before stop (+1.5R), else stop (-1R).
//   Plan B ("exit at TP2"): win = TP2 reached before stop (+3R),  else stop (-1R).
// "Open" trades (neither resolved by data end) are excluded from rates.
// ---------------------------------------------------------------------------
function aggregate(subset, totalEvaluated) {
  let n = subset.length;
  let a_win = 0, a_loss = 0, a_open = 0;
  let b_win = 0, b_loss = 0, b_open = 0;

  for (const e of subset) {
    const r = e.outcome.result;
    // Plan A: exit at TP1.
    if (e.outcome.tp1Reached) a_win++;
    else if (r === "STOP") a_loss++;
    else a_open++; // OPEN without ever reaching TP1

    // Plan B: exit at TP2.
    if (r === "TP2") b_win++;
    else if (r === "STOP" || r === "TP1_THEN_STOP") b_loss++;
    else b_open++; // OPEN / TP1_OPEN — never hit TP2 or stop
  }

  const aResolved = a_win + a_loss;
  const bResolved = b_win + b_loss;
  const tp1Rate = aResolved ? (a_win / aResolved) * 100 : NaN;
  const tp2Rate = bResolved ? (b_win / bResolved) * 100 : NaN;
  const e1 = aResolved ? (a_win * 1.5 + a_loss * -1) / aResolved : NaN;
  const e3 = bResolved ? (b_win * CONFIG.risk.tp2R + b_loss * -1) / bResolved : NaN;

  return {
    n,
    freq: totalEvaluated ? (n / totalEvaluated) * 100 : 0,
    tp1Rate,
    tp2Rate,
    e1,
    e3,
    a_win, a_loss, a_open,
    b_win, b_loss, b_open,
  };
}

// ---------------------------------------------------------------------------
// Pretty printing
// ---------------------------------------------------------------------------
function header() {
  console.log(
    "  agree |comp|    n    freq    TP1%    TP2%     E1(R)   E3(R)"
  );
  console.log("  ----- ------ ----- ------- ------- ------- -------- --------");
}

function printRow(agree, comp, s, isLive) {
  const mark = isLive ? " <= live config" : "";
  console.log(
    `   >=${agree}   >=${comp}  ` +
      `${pad(s.n, 4)}  ${pad(fmtPct(s.freq), 6)} ${pad(fmtPct(s.tp1Rate), 6)} ${pad(fmtPct(s.tp2Rate), 6)}  ` +
      `${pad(fmtR(s.e1), 7)} ${pad(fmtR(s.e3), 7)}${mark}`
  );
}

function reportDetail(subset) {
  if (subset.length === 0) {
    console.log("  No signals passed the live gate on this data — likely TOO STRICT here.");
    console.log("  Try lowering minAgreeing (e.g. 6) or minComposite (e.g. 50) in config.js and re-run.");
    return;
  }
  const s = aggregate(subset, subset.length);
  const longs = subset.filter((e) => e.direction === "BUY").length;
  const shorts = subset.length - longs;
  const avgHold = mean(subset.map((e) => e.outcome.barsHeld));
  console.log(`  Signals: ${subset.length}  (${longs} long / ${shorts} short) · avg hold ${avgHold.toFixed(1)} bars`);
  console.log(`  Plan A (exit 1.5R): ${s.a_win}W / ${s.a_loss}L / ${s.a_open} open · win-rate ${fmtPct(s.tp1Rate)} · expectancy ${fmtR(s.e1)} R/trade`);
  console.log(`  Plan B (exit 3.0R): ${s.b_win}W / ${s.b_loss}L / ${s.b_open} open · win-rate ${fmtPct(s.tp2Rate)} · expectancy ${fmtR(s.e3)} R/trade`);
  const total1 = s.a_win * 1.5 + s.a_loss * -1;
  const total3 = s.b_win * CONFIG.risk.tp2R + s.b_loss * -1;
  console.log(`  Net (resolved only): ${fmtR(total1)} R at 1.5R exit · ${fmtR(total3)} R at 3R exit`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function pad(s, w) { return String(s).padStart(w); }
function fmtPct(v) { return Number.isFinite(v) ? v.toFixed(0) + "%" : "  —"; }
function fmtR(v) { return Number.isFinite(v) ? (v >= 0 ? "+" : "") + v.toFixed(2) : "—"; }
function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }

/**
 * Offline synthetic candles for --demo: a few trend regimes with noise and
 * volume, so the engine has something with real structure to chew on.
 */
function synthCandles(n) {
  const candles = [];
  let p = 100;
  for (let i = 0; i < n; i++) {
    // Alternating trend regimes every ~120 bars.
    const regime = Math.floor(i / 120) % 3;
    const drift = regime === 0 ? 0.18 : regime === 1 ? -0.22 : 0.03;
    p += drift + Math.sin(i / 9) * 0.7 + (Math.random() - 0.5) * 1.1;
    p = Math.max(5, p);
    const o = p - (Math.random() - 0.5) * 0.6;
    const c = p + (Math.random() - 0.5) * 0.6;
    const h = Math.max(o, c) + Math.random() * 0.8;
    const l = Math.min(o, c) - Math.random() * 0.8;
    candles.push({ time: i * 900000, open: o, high: h, low: l, close: c, volume: 120 + Math.random() * 500 });
  }
  return candles;
}
