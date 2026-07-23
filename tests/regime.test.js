// ============================================================================
// tests/regime.test.js — Phase 4: BTC regime filter + exposure guard + ledger
// breakdown dimensions. Drives the Scanner with the mock provider.
//   node tests/regime.test.js
// ============================================================================
import { CONFIG } from "../js/config.js";
CONFIG.timing.klineStaggerMs = 0;
CONFIG.timing.maxConcurrentFetches = 36;
import { Scanner } from "../js/scanner.js";
import { MockProvider } from "../js/mockprovider.js";

let passed = 0, failed = 0;
const ok = (c, l) => (c ? (console.log(`  ✓ ${l}`), passed++) : (console.error(`  ✗ ${l}`), failed++));

async function drive(cfgMutate) {
  const mp = new MockProvider();
  const sc = new Scanner(mp);
  cfgMutate?.();
  await sc.refreshTop();
  for (let c = 820; c < 1000; c++) { mp.setCursor(c); await sc.scan(); }
  return sc;
}

// --- BTC regime filter suppresses counter-BTC alt signals ------------------
console.log("BTC regime filter");
{
  const sc = await drive(() => { CONFIG.regime.btcFilter = "suppress"; CONFIG.exposure.maxSameDirection = 999; });
  ok(["BULL", "BEAR", "NEUTRAL"].includes(sc.btcBias), `btcBias computed (${sc.btcBias})`);
  // Invariant: no alt signal was locked counter to the BTC bias AT ITS OWN time
  // (each record stores r.btcBias captured at lock).
  const alts = sc.ledger.filter((r) => r.symbol !== CONFIG.regime.btcSymbol);
  const counter = alts.filter((r) =>
    (r.btcBias === "BEAR" && r.direction === "LONG") || (r.btcBias === "BULL" && r.direction === "SHORT")
  );
  ok(counter.length === 0, `no counter-BTC alt signals locked while suppress is on (${counter.length} violations of ${alts.length} alts)`);
  // Every ledger record carries the regime + hour dimensions.
  ok(sc.ledger.every((r) => "btcBias" in r && "hourUTC" in r), "ledger records carry btcBias + hourUTC");
  const sum = sc.ledgerSummary();
  ok("byBtcRegime" in sum && "byHour" in sum, "summary exposes byBtcRegime + byHour");
}

// --- Exposure guard flags beyond the same-direction cap --------------------
console.log("exposure guard");
{
  const sc = await drive(() => { CONFIG.regime.btcFilter = "off"; CONFIG.exposure.maxSameDirection = 1; });
  const capped = sc.ledger.filter((r) => r.exposureCapped);
  ok(sc.ledger.every((r) => "exposureCapped" in r), "ledger records carry exposureCapped");
  ok(capped.length > 0, `some signals flagged exposure-capped with cap=1 (${capped.length})`);
}

// restore
CONFIG.regime.btcFilter = "suppress";
CONFIG.exposure.maxSameDirection = 5;

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
