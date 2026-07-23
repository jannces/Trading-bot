// ============================================================================
// mexc.js — MEXC spot v3 REST client (Binance-style paths, MEXC intervals).
//
// The PURE parse/rank functions (parseKlines, parseTicker24hr, rankTopPairs)
// are exported separately so they can be tested against a recorded fixture
// without any network. The networked functions (getKlines, get24hr,
// getAllPrices) wrap fetch with a timeout and clear errors.
//
// Endpoints used:
//   GET /api/v3/klines?symbol=&interval=&limit=   -> array of kline arrays
//   GET /api/v3/ticker/24hr                        -> array of ticker objects
//   GET /api/v3/ticker/price                       -> array of {symbol, price}
// ============================================================================
import { CONFIG } from "./config.js";
import { intervalMinutes } from "./htf.js";

const BASE = CONFIG.exchange.rest;

// MEXC's spot /klines needs startTime AND endTime TOGETHER, with the window
// spanning at most 7 days; a lone startTime or lone endTime is ignored and the
// latest `limit` rows are returned (this is why every earlier paging attempt
// re-served the newest 500). Deep history is assembled by walking consecutive
// bounded sub-windows forward — see getKlinesDeep. limit default 500, max 1000.
export const KLINES_PAGE = 500;
export const KLINES_MAX = 1000;
export const KLINES_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // MEXC's max start→end span

/** Map our timeframe name to a MEXC interval string (1h -> "60m"). */
export function mexcInterval(tf) {
  return CONFIG.exchange.intervalMap[tf] || tf;
}

// --- Pure parsers (unit-tested against a fixture) --------------------------

/**
 * MEXC kline row: [ openTime, open, high, low, close, volume, closeTime,
 * quoteVolume ] (8 fields; Binance-compatible on the first six).
 * @returns [{ time, open, high, low, close, volume }] ascending by time.
 */
export function parseKlines(raw) {
  if (!Array.isArray(raw)) throw new Error("klines: expected an array");
  return raw.map((k) => ({
    time: Number(k[0]),
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
}

/**
 * Parse /ticker/24hr objects into a compact shape.
 * `quoteVolume` is 24h volume in the quote asset (USDT) — the ranking key.
 * Falls back to volume*lastPrice if quoteVolume is missing.
 */
export function parseTicker24hr(raw) {
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr.map((t) => {
    const lastPrice = parseFloat(t.lastPrice);
    const volume = parseFloat(t.volume);
    let quoteVolume = t.quoteVolume != null ? parseFloat(t.quoteVolume) : NaN;
    if (!Number.isFinite(quoteVolume)) quoteVolume = (volume || 0) * (lastPrice || 0);
    return {
      symbol: t.symbol,
      lastPrice,
      priceChangePercent: parseFloat(t.priceChangePercent),
      quoteVolume,
    };
  });
}

/**
 * Rank tradable USDT pairs by 24h quote volume and take the top N, excluding
 * leveraged tokens (…3L/3S) and stablecoin-vs-stablecoin pairs.
 */
export function rankTopPairs(tickers, n = CONFIG.scanner.topN) {
  const { excludeLeveraged, stableBases } = CONFIG.scanner;
  const usdt = tickers.filter((t) => {
    if (!t.symbol || !t.symbol.endsWith("USDT")) return false;
    if (excludeLeveraged.test(t.symbol)) return false;
    const base = t.symbol.slice(0, -4); // strip "USDT"
    if (stableBases.includes(base)) return false; // stable-vs-stable
    return Number.isFinite(t.quoteVolume) && t.quoteVolume > 0;
  });
  usdt.sort((a, b) => b.quoteVolume - a.quoteVolume);
  return usdt.slice(0, n);
}

// --- Networked (Node 18+ global fetch) -------------------------------------

async function getJSON(path, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}${path}`, { signal: controller.signal, headers: { Accept: "application/json" } });
    if (res.status === 429 || res.status === 418) { const e = new Error(`rate limited (${res.status})`); e.rateLimited = true; throw e; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    if (e.name === "AbortError") throw new Error("request timed out");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export async function getKlines(symbol, tf, limit = 200) {
  const raw = await getJSON(`/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${mexcInterval(tf)}&limit=${limit}`);
  const candles = parseKlines(raw);
  // A single request is capped at ~KLINES_PAGE; surface silent truncation so a
  // consumer that asked for more than one page's worth isn't misled.
  if (limit > KLINES_PAGE && candles.length < limit) warnCapOnce(symbol, tf, limit, candles.length);
  return candles;
}

const _capWarned = new Set();
function warnCapOnce(symbol, tf, requested, received) {
  const k = `${symbol}:${tf}`;
  if (_capWarned.has(k)) return;
  _capWarned.add(k);
  console.warn(`[mexc] ${symbol} ${tf}: requested ${requested} klines, received ${received} (single-request cap ~${KLINES_PAGE}). Use getKlinesDeep / fetch-data.js for deep history.`);
}

// --- Deep history via backward pagination ----------------------------------

/**
 * Stitch fetched pages (each ascending by open time) into one continuous,
 * de-duplicated ascending series and keep the most recent `total`. Pure so it
 * can be unit-tested. Records continuity gaps (missing candles) — never fatal.
 * @returns { candles, gaps:[{after,before,missing}], uniqueTotal }
 */
export function stitchDeep(pages, intervalMs, total) {
  const map = new Map();
  for (const page of pages) for (const c of page) map.set(c.time, c); // dedupe by open time
  const all = [...map.values()].sort((a, b) => a.time - b.time);
  const gaps = [];
  for (let i = 1; i < all.length; i++) {
    const d = all[i].time - all[i - 1].time;
    if (d !== intervalMs) gaps.push({ after: all[i - 1].time, before: all[i].time, missing: Math.max(0, Math.round(d / intervalMs) - 1) });
  }
  return { candles: total > 0 ? all.slice(-total) : all, gaps, uniqueTotal: all.length };
}

/**
 * Assemble the latest `total` candles by walking consecutive BOUNDED sub-windows
 * forward. Every request sends symbol, interval, limit, AND both startTime and
 * endTime — MEXC ignores a lone time param (returning the latest `limit`) and
 * rejects a start→end span over 7 days. So we tile `[now - total*int, now]` into
 * sub-windows of `min(limit, floor(7d/int))` candles and step forward, continuing
 * from the last candle each honored window returns.
 *
 * Interval-aware: for a coarse TF the 7-day cap bounds the window, not `limit`
 * (1h: floor(7d/1h) = 168 candles/window regardless of limit=1000).
 *
 * Failure modes:
 *   - PARAMS IGNORED -> a window returns candles OUTSIDE its requested range (the
 *     "latest 500" symptom): `stalled:true`, an error. (This is the stall check
 *     now that the cursor is a bounded window, not a lone timestamp.)
 *   - LISTED LATE -> empty sub-windows before the pair's first candle are normal
 *     (pre-listing): we skip forward and set `listedLate`. Empty windows BETWEEN
 *     populated ones leave the candles missing, which stitchDeep records as gaps
 *     (never silently filled).
 *
 * `opts.fetchPage(symbol, tf, limit, startTime, endTime) -> candles ascending` is
 * injectable for testing; `opts.now` overrides Date.now(); `opts.listingDate`
 * clamps the window start; `opts.pageSize` overrides the request limit (default
 * KLINES_MAX=1000, self-adapting: if the endpoint caps at 500 the range check
 * still passes and we simply make more requests); `opts.debug` (true|fn) traces.
 * @returns { candles, requested, received, uniqueTotal, pages, gaps, stalled, listedLate }
 */
export async function getKlinesDeep(symbol, tf, total, opts = {}) {
  const reqLimit = opts.pageSize || KLINES_MAX;
  const maxRetries = opts.maxRetries ?? 4;
  const onProgress = opts.onProgress || (() => {});
  const debug = opts.debug ? (typeof opts.debug === "function" ? opts.debug : (m) => console.error(m)) : null;
  const fetchPage = opts.fetchPage || ((sym, itf, limit, st, et) => fetchKlinePage(sym, itf, limit, st, et, maxRetries));
  const intMs = intervalMinutes(tf) * 60000;
  const now = opts.now ?? Date.now();

  // Candles per window: the smaller of the request limit and what fits in 7 days.
  const perWindow = Math.max(1, Math.min(reqLimit, Math.floor(KLINES_WINDOW_MS / intMs)));
  const windowSpanMs = (perWindow - 1) * intMs; // start→end span, strictly < 7 days
  const windowStart = Math.max(0, now - total * intMs);
  let cursor = opts.listingDate != null ? Math.max(windowStart, opts.listingDate) : windowStart;

  const pages = [];
  const seen = new Set();
  let stalled = false, stallReason = null, listedLate = false, hasData = false;
  const maxIters = Math.ceil((total * intMs) / (windowSpanMs || intMs)) + 50; // safety bound
  for (let p = 0; p < maxIters && cursor < now; p++) {
    const startTime = cursor;
    const endTime = Math.min(cursor + windowSpanMs, now);
    const page = await fetchPage(symbol, tf, reqLimit, startTime, endTime);
    const count = page ? page.length : 0;
    let newAdded = 0, oldest = Infinity, newest = -Infinity;
    if (count) for (const c of page) { if (!seen.has(c.time)) newAdded++; if (c.time < oldest) oldest = c.time; if (c.time > newest) newest = c.time; }
    if (debug) {
      debug(`[deep] ${symbol} ${mexcInterval(tf)} req#${p + 1}: symbol=${symbol} interval=${mexcInterval(tf)} limit=${reqLimit}`
        + ` startTime=${startTime} [${isoMs(startTime)}] endTime=${endTime} [${isoMs(endTime)}] -> returned ${count}`
        + (count ? `, openTime ${isoMs(oldest)}..${isoMs(newest)}, new-after-merge ${newAdded}` : ""));
    }
    if (!count) {
      if (!hasData) listedLate = true; // pre-listing empty window: skip forward
      cursor = endTime + intMs;         // (empty windows AFTER data leave a stitchDeep gap)
      continue;
    }
    // Params-honored check: candles must fall inside the window we asked for. If
    // any land outside (tolerance 1 bar), MEXC ignored start/end and served the
    // latest batch -> hard error.
    if (oldest < startTime - intMs || newest > endTime + intMs) {
      stalled = true;
      stallReason = `window [${isoMs(startTime)}..${isoMs(endTime)}] returned openTime ${isoMs(oldest)}..${isoMs(newest)} — startTime/endTime ignored`;
      if (debug) debug(`[deep] ${symbol} ${mexcInterval(tf)}: ✗ ${stallReason}`);
      break;
    }
    pages.push(page);
    for (const c of page) seen.add(c.time);
    hasData = true;
    onProgress({ pages: pages.length, received: seen.size, total });
    if (newAdded === 0) { stalled = true; stallReason = "window added no new candles"; break; }
    cursor = newest + intMs; // continue from just after the last candle we received
  }
  const { candles, gaps, uniqueTotal } = stitchDeep(pages, intMs, total);
  if (candles.length && candles[0].time > windowStart + intMs) listedLate = true;
  return { candles, requested: total, received: candles.length, uniqueTotal, pages: pages.length, gaps, stalled, stallReason, listedLate };
}

function isoMs(ms) { return Number.isFinite(ms) ? new Date(ms).toISOString() : String(ms); }

async function fetchKlinePage(symbol, tf, limit, startTime, endTime, maxRetries) {
  // BOTH bounds are always sent (MEXC ignores a lone one); the caller keeps the
  // start→end span under 7 days.
  const q = `/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${mexcInterval(tf)}&limit=${limit}`
    + `${startTime != null ? `&startTime=${startTime}` : ""}${endTime != null ? `&endTime=${endTime}` : ""}`;
  for (let attempt = 0; ; attempt++) {
    try { return parseKlines(await getJSON(q)); }
    catch (e) {
      if (e.rateLimited && attempt < maxRetries) { await sleep(CONFIG.timing.backoffBaseMs * 2 ** attempt); continue; }
      throw e;
    }
  }
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

export async function get24hr() {
  return parseTicker24hr(await getJSON(`/api/v3/ticker/24hr`));
}

/** All-symbol last prices in one call -> Map(symbol -> price). */
export async function getAllPrices() {
  const raw = await getJSON(`/api/v3/ticker/price`);
  const map = new Map();
  for (const t of raw) map.set(t.symbol, parseFloat(t.price));
  return map;
}
