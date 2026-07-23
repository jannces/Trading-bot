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

// --- getKlinesDeep: assemble an arbitrary total from capped pages ----------
console.log("getKlinesDeep (synthetic paged source)");
{
  const full = mkSeries(2300); // more than 4 pages of 500
  let calls = 0;
  // endTime-paged source: returns up to `limit` candles with time <= endTime.
  const fetchPage = async (sym, tf, limit, endTime) => {
    calls++;
    const upto = endTime == null ? full : full.filter((c) => c.time <= endTime);
    return upto.slice(-limit); // ascending, newest chunk
  };
  const res = await getKlinesDeep("BTCUSDT", "5m", 2000, { pageSize: KLINES_PAGE, fetchPage });
  eq(res.received, 2000, "assembled exactly the requested total");
  eq(res.candles.length, 2000, "candles length matches");
  eq(res.candles[0].time, full[2300 - 2000].time, "starts 2000 back from newest");
  eq(res.candles[1999].time, full[2299].time, "ends at the newest candle");
  ok(res.pages >= 4, `paged backward multiple times (${res.pages} pages)`);
  eq(res.requested, 2000, "requested recorded");
  eq(res.gaps.length, 0, "continuous -> no gaps");
  // Monotonic ascending, no dupes.
  let mono = true; for (let i = 1; i < res.candles.length; i++) if (res.candles[i].time <= res.candles[i - 1].time) mono = false;
  ok(mono, "final series strictly ascending (de-duped)");
}
{
  // History shorter than requested -> received < requested (surfaced), no hang.
  const full = mkSeries(300);
  const fetchPage = async (sym, tf, limit, endTime) => (endTime == null ? full : full.filter((c) => c.time <= endTime)).slice(-limit);
  const res = await getKlinesDeep("X", "5m", 5000, { pageSize: KLINES_PAGE, fetchPage });
  eq(res.received, 300, "short history -> received = available");
  ok(res.received < res.requested, "requested vs received surfaced");
  ok(res.stalled === false, "genuine short history is NOT a stall");
}

// --- Cursor: next endTime = oldest openTime - 1ms (openTime-inclusive) ------
console.log("getKlinesDeep cursor");
{
  const full = mkSeries(2300);
  const ends = [];
  const fetchPage = async (sym, tf, limit, endTime) => {
    ends.push(endTime);
    const upto = endTime == null ? full : full.filter((c) => c.time <= endTime);
    return upto.slice(-limit);
  };
  await getKlinesDeep("BTCUSDT", "5m", 2000, { pageSize: KLINES_PAGE, fetchPage });
  eq(ends[0], undefined, "first request has no endTime (latest)");
  // Page 0 returned full[1800..2299]; the cursor must step to full[1800].time - 1.
  eq(ends[1], full[1800].time - 1, "2nd endTime = oldest openTime of page 1 minus 1ms");
  ok(ends[1] < full[1800].time, "cursor strictly before the seam candle (no re-serve)");
}

// --- STALL: API ignores endTime and re-serves the same latest page ---------
// Reproduces the real-run symptom (2 pages, 500 received) and asserts we DETECT
// it as a stall (error), not silently report it as success/short-history.
console.log("getKlinesDeep stall detection");
{
  const full = mkSeries(5000);
  let calls = 0;
  const fetchPage = async (sym, tf, limit /*, endTime IGNORED */) => { calls++; return full.slice(-limit); };
  const res = await getKlinesDeep("STALLUSDT", "5m", 2000, { pageSize: KLINES_PAGE, fetchPage });
  ok(res.stalled === true, "stall flagged when a page merges to zero new candles");
  eq(res.pages, 2, "stops after the first non-advancing page (no infinite loop)");
  eq(res.received, KLINES_PAGE, "received is just the one served page (500)");
  ok(calls === 2, "made exactly 2 requests then bailed");
}

// --- --debug trace: one line per request, with the merge count -------------
console.log("getKlinesDeep --debug");
{
  const full = mkSeries(1200);
  const fetchPage = async (sym, tf, limit, endTime) => (endTime == null ? full : full.filter((c) => c.time <= endTime)).slice(-limit);
  const lines = [];
  const res = await getKlinesDeep("BTCUSDT", "5m", 1000, { pageSize: KLINES_PAGE, fetchPage, debug: (m) => lines.push(m) });
  ok(lines.length === res.pages, `one debug line per request (${lines.length})`);
  ok(/new-after-merge/.test(lines[0]) && /openTime/.test(lines[0]), "debug line has openTime range + merge count");
  ok(/endTime=\(latest\)/.test(lines[0]), "first debug line shows endTime=(latest)");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
