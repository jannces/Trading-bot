// ============================================================================
// tests/fetchdeep.test.js — deep windowed kline fetching.
// Tests the pure stitcher and getKlinesDeep against a synthetic source that
// models MEXC's real behavior: startTime AND endTime are required TOGETHER (a
// lone one is ignored -> latest `limit`), the start→end span must be <= 7 days,
// and limit maxes at 1000. Verifies windowed-forward assembly, the 7-day cap on
// coarse TFs, listed-late (pre-listing empties), mid-series gaps, and the
// params-ignored hard error.
//   node tests/fetchdeep.test.js
// ============================================================================
import { stitchDeep, getKlinesDeep, KLINES_MAX, KLINES_WINDOW_MS } from "../js/mexc.js";

let passed = 0, failed = 0;
const ok = (c, l) => (c ? (console.log(`  ✓ ${l}`), passed++) : (console.error(`  ✗ ${l}`), failed++));
const eq = (a, b, l) => ok(a === b, `${l} (got ${JSON.stringify(a)})`);

const INT = 5 * 60000; // 5m in ms
const T0 = 1_700_000_000_000;
const mkSeries = (n, gapAt = -1, step = INT) => {
  const out = [];
  let t = T0;
  for (let i = 0; i < n; i++) {
    if (i === gapAt) t += step; // skip one candle -> a gap
    out.push({ time: t, open: i, high: i, low: i, close: i, volume: 1 });
    t += step;
  }
  return out;
};
// MEXC-honored source: both bounds required; returns openTime in [st, et], up to
// limit (ascending). A window entirely outside the data returns []. `capAt` lets
// a test force the endpoint's real 500 cap regardless of the requested limit.
const honored = (series, capAt = Infinity) => async (sym, tf, limit, st, et) =>
  series.filter((c) => c.time >= st && c.time <= et).slice(0, Math.min(limit, capAt));

// --- stitchDeep: dedupe seam + continuity + keep last N --------------------
console.log("stitchDeep");
{
  const full = mkSeries(1000);
  // Two overlapping pages (seam candle shared).
  const older = full.slice(0, 600);
  const newer = full.slice(599); // shares index 599
  const r = stitchDeep([newer, older], INT, 1000);
  eq(r.uniqueTotal, 1000, "seam candle de-duplicated (1000 unique)");
  eq(r.candles.length, 1000, "keeps all when total >= unique");
  eq(r.candles[0].time, full[0].time, "ascending, starts at oldest");
  eq(r.candles[999].time, full[999].time, "ends at newest");
  eq(r.gaps.length, 0, "no gaps in a continuous series");
}
{
  const r = stitchDeep([mkSeries(50)], INT, 20);
  eq(r.candles.length, 20, "keeps the most recent `total`");
  eq(r.candles[19].time, T0 + 49 * INT, "last kept = newest candle");
}
{
  const r = stitchDeep([mkSeries(100, 40)], INT, 100);
  eq(r.gaps.length, 1, "one continuity gap detected");
  eq(r.gaps[0].missing, 1, "gap reports 1 missing candle");
}

// --- getKlinesDeep: WINDOWED forward (both params required) -----------------
console.log("getKlinesDeep (windowed forward, both params)");
{
  const full = mkSeries(5000);           // T0 .. T0+4999*INT
  const NOW = full[4999].time + INT;     // "now" = just after the newest candle
  const res = await getKlinesDeep("BTCUSDT", "5m", 2000, { fetchPage: honored(full), now: NOW });
  eq(res.received, 2000, "assembled exactly the requested total");
  eq(res.candles[0].time, full[3000].time, "starts `total` back from now (windowStart)");
  eq(res.candles[1999].time, full[4999].time, "ends at the newest candle");
  eq(res.pages, 2, "limit 1000 -> 2000 candles in 2 windows");
  eq(res.gaps.length, 0, "continuous -> no gaps");
  ok(res.stalled === false && res.listedLate === false, "full window: not stalled, not listed-late");
  let mono = true; for (let i = 1; i < res.candles.length; i++) if (res.candles[i].time <= res.candles[i - 1].time) mono = false;
  ok(mono, "final series strictly ascending (de-duped)");
}

// --- Windows: consecutive, both bounds sent, span <= 7 days ----------------
console.log("getKlinesDeep windowing");
{
  const full = mkSeries(5000);
  const NOW = full[4999].time + INT;
  const wins = [];
  const fetchPage = async (sym, tf, limit, st, et) => { wins.push({ st, et }); return honored(full)(sym, tf, limit, st, et); };
  await getKlinesDeep("BTCUSDT", "5m", 2000, { fetchPage, now: NOW });
  ok(wins.every((w) => w.st != null && w.et != null), "every request sends BOTH startTime and endTime");
  ok(wins.every((w) => w.et - w.st <= KLINES_WINDOW_MS), "no window exceeds the 7-day cap");
  eq(wins[0].st, full[3000].time, "first window starts at windowStart (now - total*int)");
  ok(wins[1].st === full[3999].time + INT, "2nd window starts one bar after the last candle received");
}

// --- 7-day cap governs coarse TFs: 1h windows are ~168 candles, not 1000 ----
console.log("getKlinesDeep 7-day cap (1h)");
{
  const H = 60 * 60000;                        // 1h in ms
  const full = mkSeries(600, -1, H);           // 600 hourly candles
  const NOW = full[599].time + H;
  const wins = [];
  const fetchPage = async (sym, tf, limit, st, et) => { wins.push({ st, et }); return honored(full)(sym, tf, limit, st, et); };
  const res = await getKlinesDeep("BTCUSDT", "1h", 500, { fetchPage, now: NOW });
  eq(res.received, 500, "assembled the requested 1h total");
  ok(wins.every((w) => w.et - w.st <= KLINES_WINDOW_MS), "each 1h window is within 7 days");
  const maxSpanBars = Math.max(...wins.map((w) => Math.round((w.et - w.st) / H)) ) + 1;
  ok(maxSpanBars <= Math.floor(KLINES_WINDOW_MS / H), `1h window carries <= ${Math.floor(KLINES_WINDOW_MS / H)} candles (got <=${maxSpanBars}), capped by 7d not by limit`);
  ok(wins.length >= Math.ceil(500 / 168), `paged in multiple 7-day windows (${wins.length})`);
}

// --- limit=1000 self-adapts: endpoint that caps at 500 still assembles all --
console.log("getKlinesDeep limit self-adapt");
{
  const full = mkSeries(5000);
  const NOW = full[4999].time + INT;
  // Endpoint honors the window but hard-caps returns at 500 regardless of limit.
  const res = await getKlinesDeep("BTCUSDT", "5m", 2000, { fetchPage: honored(full, 500), now: NOW });
  eq(res.received, 2000, "still assembles the full total when the API caps at 500");
  eq(res.gaps.length, 0, "no gaps despite the 500 cap (more requests, same result)");
  ok(res.pages > 2, `made extra requests to cover the 500 cap (${res.pages})`);
}

// --- Listed-late: empty sub-windows before the pair's first candle ----------
{
  const Tlist = T0 + 4200 * INT;
  const series = []; for (let i = 0; i < 800; i++) series.push({ time: Tlist + i * INT, open: i, high: i, low: i, close: i, volume: 1 });
  const NOW = series[799].time + INT;          // windowStart is well before Tlist
  const res = await getKlinesDeep("NEWUSDT", "5m", 2000, { fetchPage: honored(series), now: NOW });
  eq(res.received, 800, "listed-late -> received = all that exists");
  ok(res.received < res.requested, "requested vs received surfaced");
  ok(res.listedLate === true, "flagged listed-late (empty pre-listing windows)");
  ok(res.stalled === false, "listed-late is NOT a stall");
  eq(res.candles[0].time, Tlist, "earliest candle = the listing candle (clean boundary)");
}

// --- Mid-series gap: an empty window BETWEEN data is recorded, not skipped ---
{
  // 100-candle hole in the middle: openTimes for i in [1000,1100) are absent.
  const series = []; let t = T0;
  for (let i = 0; i < 3000; i++) { if (i >= 1000 && i < 1100) { t += INT; continue; } series.push({ time: t, open: i, high: i, low: i, close: i, volume: 1 }); t += INT; }
  const NOW = series[series.length - 1].time + INT;
  const res = await getKlinesDeep("GAPUSDT", "5m", 3000, { fetchPage: honored(series), now: NOW });
  eq(res.received, 2900, "received = the candles that actually exist (3000 - 100 hole)");
  eq(res.gaps.length, 1, "the hole is recorded as ONE gap");
  eq(res.gaps[0].missing, 100, "gap reports the 100 missing candles");
  ok(res.stalled === false, "a genuine hole is a gap, not a stall");
}

// --- Params ignored -> hard error (the real-run symptom) --------------------
// A lone/ignored time param makes MEXC return the latest `limit` regardless of
// the window. For an early window those candles fall OUTSIDE the requested range
// -> we must detect it as a stall, not accept bogus data.
console.log("getKlinesDeep params-ignored hard error");
{
  const full = mkSeries(5000);
  const NOW = full[4999].time + INT;
  let calls = 0;
  const ignoresParams = async (sym, tf, limit /*, st, et IGNORED */) => { calls++; return full.slice(-500); }; // latest 500
  const res = await getKlinesDeep("STALLUSDT", "5m", 2000, { fetchPage: ignoresParams, now: NOW });
  ok(res.stalled === true, "stall flagged when candles fall outside the requested window");
  ok(/ignored/.test(res.stallReason || ""), "stallReason explains start/end were ignored");
  ok(calls <= 2, `bailed almost immediately (no infinite loop, ${calls} calls)`);
}

// --- --debug trace: one line per request, both bounds shown ----------------
console.log("getKlinesDeep --debug");
{
  const full = mkSeries(1200);
  const NOW = full[1199].time + INT;
  const lines = [];
  const res = await getKlinesDeep("BTCUSDT", "5m", 1000, { fetchPage: honored(full), now: NOW, debug: (m) => lines.push(m) });
  ok(lines.length === res.pages, `one debug line per request (${lines.length})`);
  ok(/new-after-merge/.test(lines[0]) && /openTime/.test(lines[0]), "debug line has openTime range + merge count");
  ok(/startTime=\d+/.test(lines[0]) && /endTime=\d+/.test(lines[0]), "debug line shows both start/end query params");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
