// ============================================================================
// tests/timeframes.test.js — config-driven timeframe selection (Task 1).
// Verifies the scanner only fetches klines for the configured timeframes
// (+ HTF bias TF), so dropping "1m" stops fetching 1m entirely.
//   node tests/timeframes.test.js
// ============================================================================
import { CONFIG } from "../js/config.js";
CONFIG.timing.klineStaggerMs = 0;
CONFIG.timing.maxConcurrentFetches = 36;
import { Scanner } from "../js/scanner.js";
import { MockProvider } from "../js/mockprovider.js";

let passed = 0, failed = 0;
const ok = (c, l) => (c ? (console.log(`  ✓ ${l}`), passed++) : (console.error(`  ✗ ${l}`), failed++));

// Provider that records which timeframes were requested.
function spyProvider() {
  const mp = new MockProvider();
  const tfs = new Set();
  const orig = mp.getKlines.bind(mp);
  mp.getKlines = (sym, tf, limit) => { tfs.add(tf); return orig(sym, tf, limit); };
  return { mp, tfs };
}

async function scanOnce(timeframes) {
  const prev = CONFIG.scanner.timeframes;
  CONFIG.scanner.timeframes = timeframes;
  const { mp, tfs } = spyProvider();
  const sc = new Scanner(mp);
  await sc.refreshTop();
  await sc.scan();
  CONFIG.scanner.timeframes = prev;
  return tfs;
}

console.log("5m-only config");
{
  const tfs = await scanOnce(["5m"]);
  ok(tfs.has("5m"), "fetches 5m");
  ok(tfs.has(CONFIG.scanner.htfTimeframe), `fetches HTF bias TF (${CONFIG.scanner.htfTimeframe})`);
  ok(!tfs.has("1m"), "does NOT fetch 1m when it isn't configured");
}

console.log("1m + 5m config");
{
  const tfs = await scanOnce(["1m", "5m"]);
  ok(tfs.has("1m"), "fetches 1m when configured");
  ok(tfs.has("5m"), "still fetches 5m");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
