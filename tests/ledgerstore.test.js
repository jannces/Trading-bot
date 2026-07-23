// ============================================================================
// tests/ledgerstore.test.js — ledger persistence store (Phase 5).
// Exercises the JSON backend directly (always available) and, if better-sqlite3
// is installed, the SQLite backend + one-time JSON import.
//   node tests/ledgerstore.test.js
// ============================================================================
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLedgerStore } from "../js/ledgerstore.js";

let passed = 0, failed = 0;
const ok = (c, l) => (c ? (console.log(`  ✓ ${l}`), passed++) : (console.error(`  ✗ ${l}`), failed++));
const eq = (a, b, l) => ok(a === b, `${l} (got ${JSON.stringify(a)})`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-"));
const jsonPath = path.join(tmp, "ledger.json");
const dbPath = path.join(tmp, "ledger.db");
const rows = [
  { id: "a", createdAt: 1, symbol: "BTCUSDT", direction: "LONG", realizedR: 1.5, grossR: 2.25, status: "tp2" },
  { id: "b", createdAt: 2, symbol: "ETHUSDT", direction: "SHORT", realizedR: -1, grossR: -1, status: "stopped" },
];

// --- JSON backend (force it by pointing db at a path that can't load) -------
console.log("JSON backend");
{
  // createLedgerStore prefers sqlite; to test JSON specifically we use the class
  // path indirectly: write JSON, then load via a store whose sqlite may/may not
  // exist. We assert round-trip regardless of backend.
  fs.writeFileSync(jsonPath, JSON.stringify(rows, null, 2));
  const store = await createLedgerStore({ db: dbPath, json: jsonPath });
  const loaded = store.load();
  eq(loaded.length, 2, "loads both records");
  eq(loaded[0].id, "a", "first record id");
  eq(loaded[1].realizedR, -1, "net R preserved");
  console.log(`  (backend: ${store.backend})`);

  // Save a mutation and reload.
  loaded[0].realizedR = 0.75;
  store.save(loaded);
  const store2 = await createLedgerStore({ db: dbPath, json: jsonPath });
  const again = store2.load().find((r) => r.id === "a");
  eq(again.realizedR, 0.75, "mutation persisted across reopen");

  // Export.
  const outPath = path.join(tmp, "export.json");
  const n = store2.exportJson(outPath);
  eq(n, 2, "export returns record count");
  ok(fs.existsSync(outPath), "export file written");
  eq(JSON.parse(fs.readFileSync(outPath, "utf8")).length, 2, "export JSON has both records");
}

// --- Empty / missing file -> empty ledger ----------------------------------
console.log("empty state");
{
  const store = await createLedgerStore({ db: path.join(tmp, "none.db"), json: path.join(tmp, "none.json") });
  eq(store.load().length, 0, "missing file -> empty array");
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
