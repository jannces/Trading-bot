// ============================================================================
// tests/fetchdeep.test.js — deep paginated kline fetching (Commit 1).
// Tests the pure stitcher and getKlinesDeep against a synthetic, endTime-paged
// source (no network) — verifies arbitrary --limit is assembled from ~500-row
// pages, seam de-dup, continuity/gap detection, and requested-vs-received.
//   node tests/fetchdeep.test.js
// ============================================================================
import { stitchDeep, getKlinesDeep, KLINES_PAGE } from "../js/mexc.js";

let passed = 0, failed = 0;
const ok = (c, l) => (c ? (console.log(`  ✓ ${l}`), passed++) : (console.error(`  ✗ ${l}`), failed++));
const eq = (a, b, l) => ok(a === b, `${l} (got ${JSON.stringify(a)})`);

const INT = 5 * 60000; // 5m in ms
const T0 = 1_700_000_000_000;
const mkSeries = (n, gapAt = -1) => {
  const out = [];
  let t = T0;
  for (let i = 0; i < n; i++) {
    if (i === gapAt) t += INT; // skip one candle -> a gap
    out.push({ time: t, open: i, high: i, low: i, close: i, volume: 1 });
    t += INT;
  }
  return out;
};

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

// --- getKlinesDeep: FORWARD paging (startTime = lower bound) ----------------
// MEXC's /klines time param is a LOWER bound (returns openTime >= startTime,
// ascending, up to `limit`). These mocks model that observed behavior.
console.log("getKlinesDeep (forward paging, startTime lower bound)");
{
  const full = mkSeries(5000);           // T0 .. T0+4999*INT
  const NOW = full[4999].time + INT;     // "now" = just after the newest candle
  let calls = 0;
  const fetchPage = async (sym, tf, limit, startTime) => {
    calls++;
    const from = startTime == null ? full : full.filter((c) => c.time >= startTime);
    return from.slice(0, limit);         // ascending, oldest-first from the bound
  };
  const res = await getKlinesDeep("BTCUSDT", "5m", 2000, { pageSize: KLINES_PAGE, fetchPage, now: NOW });
  eq(res.received, 2000, "assembled exactly the requested total");
  eq(res.candles[0].time, full[3000].time, "starts `total` back from now (windowStart)");
  eq(res.candles[1999].time, full[4999].time, "ends at the newest candle");
  ok(res.pages >= 4, `paged forward multiple times (${res.pages} pages)`);
  eq(res.requested, 2000, "requested recorded");
  eq(res.gaps.length, 0, "continuous -> no gaps");
  ok(res.stalled === false && res.listedLate === false, "full window: not stalled, not listed-late");
  let mono = true; for (let i = 1; i < res.candles.length; i++) if (res.candles[i].time <= res.candles[i - 1].time) mono = false;
  ok(mono, "final series strictly ascending (de-duped)");
}

// --- Cursor: next startTime = newest openTime + 1ms ------------------------
console.log("getKlinesDeep cursor");
{
  const full = mkSeries(5000);
  const NOW = full[4999].time + INT;
  const starts = [];
  const fetchPage = async (sym, tf, limit, startTime) => {
    starts.push(startTime);
    return (startTime == null ? full : full.filter((c) => c.time >= startTime)).slice(0, limit);
  };
  await getKlinesDeep("BTCUSDT", "5m", 2000, { pageSize: KLINES_PAGE, fetchPage, now: NOW });
  eq(starts[0], full[3000].time, "first startTime = windowStart (now - total*int)");
  // Page 0 returned full[3000..3499]; the cursor steps to full[3499].time + 1.
  eq(starts[1], full[3499].time + 1, "2nd startTime = newest openTime of page 1 + 1ms");
  ok(starts[1] > full[3499].time, "cursor strictly after the last candle (no re-serve)");
}

// --- Short history (pair listed later than the window; API CLAMPS) ---------
{
  const Tlist = T0 + 4200 * INT;
  const series = []; for (let i = 0; i < 800; i++) series.push({ time: Tlist + i * INT, open: i, high: i, low: i, close: i, volume: 1 });
  const NOW = series[799].time + INT;
  // Clamp behavior: startTime before listing still returns from the earliest.
  const fetchPage = async (sym, tf, limit, startTime) => (startTime == null ? series : series.filter((c) => c.time >= startTime)).slice(0, limit);
  const res = await getKlinesDeep("NEWUSDT", "5m", 2000, { pageSize: KLINES_PAGE, fetchPage, now: NOW });
  eq(res.received, 800, "listed-late -> received = all that exists");
  ok(res.received < res.requested, "requested vs received surfaced");
  ok(res.listedLate === true, "flagged listed-late (earliest candle after window start)");
  ok(res.stalled === false, "listed-late is NOT a stall");
  eq(res.candles[0].time, Tlist, "earliest candle = the listing candle (clean boundary)");
}

// --- Short history (API returns EMPTY before listing -> window steps fwd) ---
{
  const Tlist = T0 + 5000 * INT;
  const series = []; for (let i = 0; i < 800; i++) series.push({ time: Tlist + i * INT, open: i, high: i, low: i, close: i, volume: 1 });
  const NOW = Tlist + 1000 * INT;        // windowStart = NOW - 2000*INT = Tlist - 1000*INT
  // Non-clamp behavior: empty for any startTime strictly before the listing.
  const fetchPage = async (sym, tf, limit, startTime) => (startTime != null && startTime < Tlist ? [] : series.filter((c) => c.time >= startTime)).slice(0, limit);
  const res = await getKlinesDeep("LATEUSDT", "5m", 2000, { pageSize: KLINES_PAGE, fetchPage, now: NOW });
  eq(res.received, 800, "empty-before-listing: recovers the full available history");
  ok(res.listedLate === true, "empty first window -> listed-late");
  ok(res.stalled === false, "listed-late (empty window) is not a stall");
  eq(res.candles[0].time, Tlist, "earliest recovered candle = listing candle (no skip)");
}

// --- STALL: API ignores startTime and re-serves the same page --------------
// Reproduces the real-run symptom (a non-advancing cursor) and asserts we DETECT
// it as a stall, not silently report it as success/short-history.
console.log("getKlinesDeep stall detection");
{
  const full = mkSeries(5000);
  const NOW = full[4999].time + INT;
  let calls = 0;
  const fetchPage = async (sym, tf, limit /*, startTime IGNORED */) => { calls++; return full.slice(0, limit); };
  const res = await getKlinesDeep("STALLUSDT", "5m", 2000, { pageSize: KLINES_PAGE, fetchPage, now: NOW });
  ok(res.stalled === true, "stall flagged when a page merges to zero new candles");
  eq(res.pages, 2, "stops after the first non-advancing page (no infinite loop)");
  eq(res.received, KLINES_PAGE, "received is just the one served page (500)");
  ok(calls === 2, "made exactly 2 requests then bailed");
}

// --- --debug trace: one line per request, forward format -------------------
console.log("getKlinesDeep --debug");
{
  const full = mkSeries(1200);
  const NOW = full[1199].time + INT;
  const fetchPage = async (sym, tf, limit, startTime) => (startTime == null ? full : full.filter((c) => c.time >= startTime)).slice(0, limit);
  const lines = [];
  const res = await getKlinesDeep("BTCUSDT", "5m", 1000, { pageSize: KLINES_PAGE, fetchPage, now: NOW, debug: (m) => lines.push(m) });
  ok(lines.length === res.pages, `one debug line per request (${lines.length})`);
  ok(/new-after-merge/.test(lines[0]) && /openTime/.test(lines[0]), "debug line has openTime range + merge count");
  ok(/startTime=\d+/.test(lines[0]), "first debug line shows the startTime query param");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
