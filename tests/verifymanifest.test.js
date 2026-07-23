// ============================================================================
// tests/verifymanifest.test.js — verify-manifest.js snapshot checks.
//   node tests/verifymanifest.test.js
// ============================================================================
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { verifyManifest } from "../verify-manifest.js";

let passed = 0, failed = 0;
function ok(name, cond) { if (cond) { console.log(`  ✓ ${name}`); passed++; } else { console.error(`  ✗ ${name}`); failed++; } }

function mkdir() { return fs.mkdtempSync(path.join(os.tmpdir(), "vm-")); }
function candles(n, t0 = 1600000000000, step = 300000) {
  const out = []; for (let i = 0; i < n; i++) out.push({ time: t0 + i * step, open: 1, high: 1, low: 1, close: 1, volume: 1 });
  return out;
}
function writeSnap(dir, perPair, files) {
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
    fetchedAt: "2026-01-01T00:00:00Z", source: "mexc", primaryTf: "5m", target: 20000, tfs: ["5m", "15m", "1h"], perPair,
  }));
  for (const [sym, obj] of Object.entries(files)) fs.writeFileSync(path.join(dir, `${sym}.json`), JSON.stringify(obj));
}

console.log("verify-manifest");

// 1. A clean snapshot -> no issues, provenance reflects file contents.
{
  const dir = mkdir();
  writeSnap(dir,
    { BTCUSDT: { "5m": { requested: 800, received: 800, pages: 2, gaps: 0 } } },
    { BTCUSDT: { symbol: "BTCUSDT", "5m": candles(800) } });
  const { issues, provenance } = verifyManifest(dir);
  ok("clean snapshot -> 0 issues", issues.length === 0);
  ok("provenance count matches file", provenance[0].count === 800);
  ok("provenance date range from candles", provenance[0].from === 1600000000000);
}

// 2. Short + gapped series -> both flagged.
{
  const dir = mkdir();
  writeSnap(dir,
    { ETHUSDT: { "5m": { requested: 20000, received: 500, pages: 1, gaps: 3 } } },
    { ETHUSDT: { symbol: "ETHUSDT", "5m": candles(500) } });
  const { issues } = verifyManifest(dir);
  ok("short series flagged", issues.some((s) => /short/.test(s)));
  ok("gaps flagged", issues.some((s) => /gap/.test(s)));
}

// 3. Errored series -> flagged as ERROR.
{
  const dir = mkdir();
  writeSnap(dir, { XRPUSDT: { "1h": { requested: 100, received: 0, error: "boom" } } }, { XRPUSDT: { symbol: "XRPUSDT" } });
  const { issues, badPairs } = verifyManifest(dir);
  ok("errored series flagged", issues.some((s) => /ERROR boom/.test(s)));
  ok("errored pair in badPairs", badPairs.includes("XRPUSDT"));
}

// 3b. Pagination stall -> flagged distinctly + badPairs + surfaces manifest.stalls.
{
  const dir = mkdir();
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
    source: "mexc", primaryTf: "5m", target: 20000, tfs: ["5m"], stalls: 1,
    perPair: { SOLUSDT: { "5m": { requested: 20000, received: 500, pages: 2, gaps: 0, stalled: true, error: "pagination stall — endTime not advancing" } } },
  }));
  fs.writeFileSync(path.join(dir, "SOLUSDT.json"), JSON.stringify({ symbol: "SOLUSDT", "5m": candles(500) }));
  const { issues, badPairs, stalls } = verifyManifest(dir);
  ok("stall flagged as PAGINATION STALL", issues.some((s) => /PAGINATION STALL/.test(s)));
  ok("stalled pair in badPairs", badPairs.includes("SOLUSDT"));
  ok("manifest stalls surfaced", stalls === 1);
}

// 3c. Clean multi-pair -> badPairs empty.
{
  const dir = mkdir();
  writeSnap(dir,
    { AAAUSDT: { "5m": { requested: 500, received: 500, pages: 1, gaps: 0 } }, BBBUSDT: { "5m": { requested: 500, received: 500, pages: 1, gaps: 0 } } },
    { AAAUSDT: { symbol: "AAAUSDT", "5m": candles(500) }, BBBUSDT: { symbol: "BBBUSDT", "5m": candles(500) } });
  const { badPairs } = verifyManifest(dir);
  ok("clean multi-pair -> no bad pairs", badPairs.length === 0);
}

// 4. Missing manifest -> throws.
{
  const dir = mkdir();
  let threw = false;
  try { verifyManifest(dir); } catch { threw = true; }
  ok("missing manifest throws", threw);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
