// ============================================================================
// server.js — Local Node backend for the MEXC scalper scanner.
//
//   npm install && node server.js      -> http://localhost:8000
//   MOCK=1 node server.js              -> offline synthetic data (no network)
//
// Responsibilities:
//   - hold the MEXC data connection (REST polling by default; optional WS),
//   - run the scanner loop server-side,
//   - serve the static frontend,
//   - push scanner results / prices / new signals to the browser over SSE,
//   - persist the signal ledger to a JSON file (survives restarts).
//
// Minimal deps: nothing required for the default (poll) path — Node's built-in
// http + global fetch. The optional websocket path uses `ws` (see js/mexcws.js).
// ============================================================================
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG } from "./js/config.js";
import { Scanner } from "./js/scanner.js";
import * as mexc from "./js/mexc.js";
import { MockProvider } from "./js/mockprovider.js";
import { createLedgerStore } from "./js/ledgerstore.js";
import { intervalMinutes } from "./js/htf.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK = process.env.MOCK === "1" || process.argv.includes("--mock");

// --- Data provider ---------------------------------------------------------
const provider = MOCK
  ? new MockProvider()
  : { getKlines: mexc.getKlines, get24hr: mexc.get24hr, getAllPrices: mexc.getAllPrices };

const scanner = new Scanner(provider);
let wsStatus = MOCK ? "mock data" : `REST polling (${CONFIG.timing.pricePollMs}ms)`;

// --- SSE clients (monotonic event ids; snapshot on every (re)connect) -------
const clients = new Set();
let eventId = 0;
function broadcast(obj) {
  const id = ++eventId;
  const line = `id: ${id}\ndata: ${JSON.stringify(obj)}\n\n`;
  for (const res of clients) { try { res.write(line); } catch { /* dropped */ } }
}
/** Full current state (feed + ledger + summary + status + prices). */
function fullSnapshot() {
  const prices = {};
  for (const s of scanner.symbols()) if (scanner.prices.has(s)) prices[s] = scanner.prices.get(s);
  return { type: "scan", ...scanner.snapshot(wsStatus), prices };
}

// --- Ledger persistence (SQLite w/ JSON fallback) --------------------------
const LEDGER_JSON = path.resolve(__dirname, CONFIG.server.ledgerPath);
const LEDGER_DB = LEDGER_JSON.replace(/\.json$/, "") + ".db";
let store = null;
let saveTimer = null;
function saveLedgerDebounced() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { try { store.save(scanner.ledger); } catch (e) { console.error("Ledger save failed:", e.message); } }, 400);
}

scanner.onNewSignal = (sig) => broadcast({ type: "signal", signal: sig });
scanner.onLedgerChange = () => { saveLedgerDebounced(); broadcast({ type: "ledger", ledger: scanner.ledger.slice(-200), summary: scanner.ledgerSummary() }); };

// --- Loops -----------------------------------------------------------------
async function refreshTopSafe() {
  try { await scanner.refreshTop(); wsStatus = MOCK ? "mock data" : `REST polling (${CONFIG.timing.pricePollMs}ms)`; }
  catch (e) { wsStatus = `data source error: ${e.message}`; console.error("Top-list refresh failed:", e.message); }
}
async function runScan() {
  try { await scanner.scan(); broadcast({ type: "scan", ...scanner.snapshot(wsStatus) }); }
  catch (e) { console.error("Scan error:", e.message); }
}
// Candle-close-driven scanning (live): scan just after the FASTEST scanned
// timeframe's close + grace, so evaluation is fresh and we don't waste cycles
// mid-candle. Keys off config.scanner.timeframes — no hardcoded 1m. A slow
// fallback timer guarantees progress if the aligned timer drifts (or in MOCK).
function fastestScanMs() {
  const mins = CONFIG.scanner.timeframes.map(intervalMinutes);
  return Math.max(1, Math.min(...mins)) * 60 * 1000;
}
function scheduleAlignedScan() {
  const int = fastestScanMs();
  const delay = int - (Date.now() % int) + CONFIG.timing.candleCloseGraceMs;
  setTimeout(async () => { await runScan(); scheduleAlignedScan(); }, delay);
}
function startScanning() {
  runScan(); // immediate first scan
  if (MOCK) {
    // Mock time is compressed; a flat timer keeps the demo lively.
    const tick = () => { runScan().finally(() => setTimeout(tick, CONFIG.timing.scanIntervalMs)); };
    setTimeout(tick, CONFIG.timing.scanIntervalMs);
  } else {
    scheduleAlignedScan();
    // Safety net: force a scan if none has happened for 1.5× the fallback window.
    setInterval(() => { if (Date.now() - scanner.lastScanMs > CONFIG.timing.scanIntervalMs * 1.5) runScan(); }, CONFIG.timing.scanIntervalMs);
  }
}
async function priceLoop() {
  try {
    await scanner.updatePrices();
    const prices = {};
    for (const s of scanner.symbols()) if (scanner.prices.has(s)) prices[s] = scanner.prices.get(s);
    broadcast({ type: "prices", prices });
  } catch { /* non-fatal */ }
  setTimeout(priceLoop, CONFIG.timing.pricePollMs);
}

// --- HTTP server -----------------------------------------------------------
const MIME = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml", ".ico": "image/x-icon" };
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://localhost");

  if (u.pathname === "/events") return sse(req, res);
  if (u.pathname === "/api/status") return json(res, scanner.status(wsStatus));
  if (u.pathname === "/api/ledger") return json(res, { ledger: scanner.ledger, summary: scanner.ledgerSummary() });
  if (u.pathname === "/api/snapshot") return json(res, scanner.snapshot(wsStatus));
  if (u.pathname === "/api/klines") {
    const sym = (u.searchParams.get("symbol") || "").toUpperCase();
    const tf = u.searchParams.get("interval") || "5m";
    const limit = Math.min(1000, Math.max(1, parseInt(u.searchParams.get("limit") || "200", 10)));
    // Validate: symbol must be in the current universe; interval whitelisted.
    const universe = scanner.symbols();
    const intervals = Object.keys(CONFIG.exchange.intervalMap);
    if (!intervals.includes(tf)) return json(res, { error: `invalid interval '${tf}'` }, 400);
    if (universe.length && !universe.includes(sym)) return json(res, { error: `symbol '${sym}' not in current universe` }, 400);
    try {
      const cached = scanner.klines.get(`${sym}:${tf}`);
      const candles = cached && cached.length >= limit ? cached.slice(-limit) : await provider.getKlines(sym, tf, limit);
      return json(res, { symbol: sym, interval: tf, candles });
    } catch (e) { return json(res, { error: e.message }, 502); }
  }
  return serveStatic(u.pathname, res);
});

function sse(req, res) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.write("retry: 3000\n\n");
  const lastId = parseInt(req.headers["last-event-id"] || "", 10); // honored: we resync via a full snapshot
  // Always send a full snapshot first so a fresh OR reconnecting client is
  // completely caught up (supersedes any deltas missed during the drop).
  const id = ++eventId;
  if (Number.isFinite(lastId)) res.write(`: resuming after ${lastId} with full snapshot\n\n`);
  res.write(`id: ${id}\ndata: ${JSON.stringify(fullSnapshot())}\n\n`);
  clients.add(res);
  const hb = setInterval(() => { try { res.write(": ping\n\n"); } catch { /* */ } }, 20000);
  req.on("close", () => { clearInterval(hb); clients.delete(res); });
}

function serveStatic(pathname, res) {
  if (pathname === "/") pathname = "/index.html";
  // Restrict to the project directory; block traversal.
  const filePath = path.join(__dirname, path.normalize(pathname));
  if (!filePath.startsWith(__dirname)) return notFound(res);
  fs.readFile(filePath, (err, data) => {
    if (err) return notFound(res);
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(data);
  });
}
function json(res, obj, code = 200) { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); }
function notFound(res) { res.writeHead(404); res.end("Not found"); }

// --- Boot ------------------------------------------------------------------
async function main() {
  store = await createLedgerStore({ db: LEDGER_DB, json: LEDGER_JSON });

  // CLI: `node server.js --export-ledger [path]` dumps the ledger to JSON and exits.
  if (process.argv.includes("--export-ledger")) {
    const out = process.argv[process.argv.indexOf("--export-ledger") + 1] || LEDGER_JSON;
    const n = store.exportJson(path.resolve(__dirname, out.endsWith(".json") ? out : LEDGER_JSON));
    console.log(`Exported ${n} ledger records to ${out} (backend: ${store.backend})`);
    return;
  }

  const loaded = store.load();
  scanner.setLedger(loaded);
  console.log(`Ledger: ${loaded.length} records (backend: ${store.backend})`);

  await refreshTopSafe();
  setInterval(refreshTopSafe, CONFIG.scanner.listRefreshMs);
  server.listen(CONFIG.server.port, () => {
    console.log(`\nScalper scanner on http://localhost:${CONFIG.server.port}  ${MOCK ? "(MOCK data)" : "(live MEXC)"}`);
    console.log(`Scanning top ${scanner.symbols().length} pairs on ${CONFIG.scanner.timeframes.join("/")} · HTF ${CONFIG.scanner.htfTimeframe}`);
  });
  startScanning();
  priceLoop();
}
main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
