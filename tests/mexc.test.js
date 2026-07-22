// ============================================================================
// tests/mexc.test.js — MEXC REST response parsing, against a recorded fixture.
//
// NOTE: the fixture below is constructed from MEXC's *documented* spot v3
// response shapes (Binance-compatible paths), because the build environment
// could not reach api.mexc.com to capture a live response. If MEXC changes its
// schema, update tests/fixtures/mexc.klines.json / mexc.ticker24hr.json.
//   node tests/mexc.test.js
// ============================================================================
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parseKlines, parseTicker24hr, rankTopPairs, mexcInterval } from "../js/mexc.js";

const here = dirname(fileURLToPath(import.meta.url));
const load = (f) => JSON.parse(readFileSync(resolve(here, "fixtures", f), "utf8"));

let passed = 0, failed = 0;
const ok = (c, l) => (c ? (console.log(`  ✓ ${l}`), passed++) : (console.error(`  ✗ ${l}`), failed++));
const eq = (a, b, l) => ok(a === b, `${l} (got ${JSON.stringify(a)})`);

// --- interval mapping ------------------------------------------------------
console.log("MEXC interval mapping");
eq(mexcInterval("1h"), "60m", "1h maps to MEXC '60m'");
eq(mexcInterval("5m"), "5m", "5m stays '5m'");
eq(mexcInterval("1d"), "1d", "1d stays '1d'");

// --- klines ----------------------------------------------------------------
console.log("parseKlines (fixture)");
{
  const raw = load("mexc.klines.json");
  const c = parseKlines(raw);
  eq(c.length, raw.length, "parses every row");
  const f = c[0];
  eq(f.time, 1700000000000, "openTime -> time (number)");
  eq(f.open, 42000.1, "open parsed as number");
  eq(f.high, 42100.5, "high parsed");
  eq(f.low, 41950.0, "low parsed");
  eq(f.close, 42080.7, "close parsed");
  eq(f.volume, 12.5, "volume parsed");
  ok(c.every((x) => typeof x.close === "number" && isFinite(x.close)), "all closes numeric");
  ok(c[1].time > c[0].time, "ascending by time");
}

// --- 24hr ticker + ranking -------------------------------------------------
console.log("parseTicker24hr + rankTopPairs (fixture)");
{
  const raw = load("mexc.ticker24hr.json");
  const t = parseTicker24hr(raw);
  const btc = t.find((x) => x.symbol === "BTCUSDT");
  eq(btc.lastPrice, 42080.7, "lastPrice parsed");
  ok(btc.quoteVolume > 0, "quoteVolume present");

  // Ranking: exclude 3L/3S leveraged tokens and stable-vs-stable, sort by quoteVolume.
  const top = rankTopPairs(t, 10);
  const syms = top.map((x) => x.symbol);
  ok(!syms.includes("BTC3LUSDT"), "excludes leveraged 3L token");
  ok(!syms.includes("USDCUSDT"), "excludes stable-vs-stable");
  ok(syms.every((s) => s.endsWith("USDT")), "only USDT pairs");
  // Highest quote volume should rank first.
  eq(syms[0], "BTCUSDT", "highest quote-volume pair ranks first");
  for (let i = 1; i < top.length; i++) ok(top[i - 1].quoteVolume >= top[i].quoteVolume, `sorted desc @${i}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
