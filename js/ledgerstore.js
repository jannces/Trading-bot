// ============================================================================
// ledgerstore.js — Ledger persistence with a SQLite backend (better-sqlite3)
// and a JSON fallback.
//
// Records are stored as (id TEXT PRIMARY KEY, data TEXT-json) so the schema
// never drifts from the record shape. If better-sqlite3 isn't installed/built,
// it transparently falls back to a JSON file — the app always runs. On first
// use of SQLite, an existing ledger.json is imported once.
//
//   const store = await createLedgerStore({ db: "./ledger.db", json: "./ledger.json" });
//   const rows = store.load();          // array of records
//   store.save(scanner.ledger);         // upsert all
//   store.exportJson("./ledger.json");  // portability export
//   store.backend                        // "sqlite" | "json"
// ============================================================================
import fs from "node:fs";

export async function createLedgerStore({ db, json }) {
  try {
    const mod = await import("better-sqlite3");
    const Database = mod.default || mod;
    return new SqliteStore(Database, db, json);
  } catch {
    return new JsonStore(json);
  }
}

class SqliteStore {
  constructor(Database, dbPath, jsonPath) {
    this.backend = "sqlite";
    this.jsonPath = jsonPath;
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec("CREATE TABLE IF NOT EXISTS ledger (id TEXT PRIMARY KEY, created INTEGER, data TEXT)");
    // Prepare statements BEFORE any import (import calls this.save()).
    this._upsert = this.db.prepare("INSERT OR REPLACE INTO ledger (id, created, data) VALUES (@id, @created, @data)");
    this._saveTx = this.db.transaction((records) => { for (const r of records) this._upsert.run({ id: r.id, created: r.createdAt || 0, data: JSON.stringify(r) }); });
    // One-time import from an existing JSON ledger if the table is empty.
    const count = this.db.prepare("SELECT COUNT(*) c FROM ledger").get().c;
    if (count === 0 && jsonPath && fs.existsSync(jsonPath)) {
      try {
        const rows = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
        if (Array.isArray(rows) && rows.length) { this.save(rows); console.log(`Ledger: imported ${rows.length} records from ${jsonPath} into SQLite`); }
      } catch { /* ignore bad json */ }
    }
  }
  load() { return this.db.prepare("SELECT data FROM ledger ORDER BY created ASC").all().map((r) => JSON.parse(r.data)); }
  save(records) { if (records && records.length) this._saveTx(records); }
  exportJson(path) { fs.writeFileSync(path, JSON.stringify(this.load(), null, 2)); return this.load().length; }
}

class JsonStore {
  constructor(jsonPath) { this.backend = "json"; this.jsonPath = jsonPath; }
  load() {
    try { const rows = JSON.parse(fs.readFileSync(this.jsonPath, "utf8")); return Array.isArray(rows) ? rows : []; }
    catch { return []; }
  }
  save(records) { fs.writeFileSync(this.jsonPath, JSON.stringify(records ?? [], null, 2)); }
  exportJson(path) { const rows = this.load(); fs.writeFileSync(path, JSON.stringify(rows, null, 2)); return rows.length; }
}
