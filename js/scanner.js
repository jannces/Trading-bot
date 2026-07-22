// ============================================================================
// scanner.js — Multi-pair scalper scanner (runs server-side).
//
// Given a data provider (real MEXC REST, or a mock for offline testing), it:
//   - ranks the top-N USDT pairs by 24h quote volume (hourly refresh),
//   - fetches 1m / 5m / 15m klines per pair (politely, with concurrency limit),
//   - runs the SAME evaluate() gate as before on 1m and 5m (15m = HTF bias),
//   - additionally requires 5m agreement for 1m signals,
//   - LOCKS a signal (frozen levels) when the gate passes, tracks its outcome
//     live, and appends immutable records to a persisted ledger.
//
// The scanner is transport-agnostic: server.js drives it and broadcasts results.
// ============================================================================
import { CONFIG } from "./config.js";
import { evaluate, trackOutcome } from "./confluence.js";
import { rankTopPairs } from "./mexc.js";

export class Scanner {
  constructor(provider) {
    this.provider = provider;
    this.top = []; // [{symbol, quoteVolume, ...}]
    this.klines = new Map(); // `${sym}:${tf}` -> candles[]
    this.prices = new Map(); // sym -> last price
    this.signals = new Map(); // `${sym}:${tf}` -> frozen signal record (active)
    this.ledger = []; // immutable records (persisted by server)
    this.feed = []; // current scanner feed (active + forming)
    this.lastScanMs = 0;
    this.cycleMs = 0;
    this.onNewSignal = () => {};
    this.onLedgerChange = () => {};
  }

  setLedger(ledger) { this.ledger = Array.isArray(ledger) ? ledger : []; }

  async refreshTop() {
    const tickers = await this.provider.get24hr();
    this.top = rankTopPairs(tickers, CONFIG.scanner.topN);
    return this.top;
  }

  symbols() { return this.top.map((t) => t.symbol); }

  async updatePrices() {
    try {
      const map = await this.provider.getAllPrices();
      for (const sym of this.symbols()) if (map.has(sym)) this.prices.set(sym, map.get(sym));
    } catch { /* price poll failures are non-fatal */ }
    return this.prices;
  }

  // --- One full scan cycle -------------------------------------------------
  async scan() {
    const t0 = Date.now();
    const syms = this.symbols();
    const tfs = [...CONFIG.scanner.scanTimeframes, CONFIG.scanner.htfTimeframe];

    // Fetch klines for every pair/timeframe with a concurrency cap.
    await runLimited(
      syms.flatMap((sym) => tfs.map((tf) => () => this.ensureKlines(sym, tf))),
      CONFIG.timing.maxConcurrentFetches
    );

    // Evaluate + manage signals.
    const feed = [];
    for (const sym of syms) {
      for (const tf of CONFIG.scanner.scanTimeframes) {
        const item = this.evaluatePair(sym, tf);
        if (item) feed.push(item);
      }
    }
    this.updateActiveSignals();

    // Rank: active first, then forming; each by score desc.
    feed.sort((a, b) => rankKind(a.kind) - rankKind(b.kind) || b.score - a.score);
    this.feed = feed;
    this.cycleMs = Date.now() - t0;
    this.lastScanMs = Date.now();
    return feed;
  }

  async ensureKlines(sym, tf) {
    try {
      const c = await this.provider.getKlines(sym, tf, CONFIG.scanner.klineLimit);
      if (Array.isArray(c) && c.length) this.klines.set(`${sym}:${tf}`, c);
    } catch { /* leave stale data; a later cycle retries */ }
  }

  evaluatePair(sym, tf) {
    const candles = this.klines.get(`${sym}:${tf}`);
    const htf = this.klines.get(`${sym}:${CONFIG.scanner.htfTimeframe}`);
    if (!candles || candles.length < CONFIG.backtest.warmup) return null;

    const decision = evaluate(candles, htf || [], {
      symbol: sym, interval: tf, htfInterval: CONFIG.scanner.htfTimeframe,
    });

    // 1m signals also need 5m direction agreement.
    if (tf === "1m" && CONFIG.scanner.require5mAgreeFor1m && decision.status !== "NONE") {
      const c5 = this.klines.get(`${sym}:5m`);
      if (c5 && c5.length >= CONFIG.backtest.warmup) {
        const d5 = evaluate(c5, htf || [], { symbol: sym, interval: "5m", htfInterval: CONFIG.scanner.htfTimeframe });
        const dir5 = d5.plan?.direction || (d5.htf.bias === "BULL" ? "LONG" : d5.htf.bias === "BEAR" ? "SHORT" : null);
        if (dir5 && decision.plan && dir5 !== decision.plan.direction) return null; // 5m disagrees -> drop
      }
    }

    if (decision.status === "NONE" || !decision.plan) return null;
    const plan = decision.plan;
    const key = `${sym}:${tf}`;

    if (decision.status === "ACTIVE") {
      // Lock a new signal unless one is already active for this pair/tf.
      if (!this.signals.has(key)) this.lockSignal(key, plan);
      const sig = this.signals.get(key);
      return { kind: "active", ...sig, price: this.prices.get(sym) };
    }
    // FORMING (ephemeral preview).
    return { kind: "forming", ...plan, price: this.prices.get(sym), status: "FORMING" };
  }

  lockSignal(key, plan) {
    const id = `${plan.symbol}-${plan.interval}-${plan.direction}-${plan.triggerTime}`;
    const sig = {
      ...plan,
      signalId: id,
      status: "LOCKED",
      realizedR: 0,
      lockedAt: Date.now(),
    };
    this.signals.set(key, sig);
    // Append an open ledger record (immutable identity; outcome filled later).
    this.ledger.push({
      id, symbol: plan.symbol, interval: plan.interval, direction: plan.direction,
      score: plan.score, tier: plan.tier, setup: plan.id, setupName: plan.name,
      contributors: plan.contributors.length,
      entryLow: plan.entryLow, entryHigh: plan.entryHigh, entryPrice: plan.entryPrice,
      stop: plan.stop, tp1: plan.tp1, tp2: plan.tp2,
      createdAt: plan.triggerTime, status: "open", realizedR: null, closedAt: null,
    });
    this.onNewSignal(sig);
    this.onLedgerChange();
  }

  updateActiveSignals() {
    for (const [key, sig] of this.signals) {
      const candles = this.klines.get(`${sig.symbol}:${sig.interval}`);
      if (!candles) continue;
      const oc = trackOutcome(sig, candles);
      sig.status = statusLabel(oc.state);
      sig.realizedR = oc.realizedR;
      sig.age = oc.barsSinceTrigger;
      sig.note = oc.note;
      if (oc.done) {
        const rec = this.ledger.find((r) => r.id === sig.signalId);
        if (rec) { rec.status = oc.state; rec.realizedR = oc.realizedR; rec.closedAt = Date.now(); }
        this.signals.delete(key);
        this.onLedgerChange();
      }
    }
  }

  ledgerSummary() {
    const closed = this.ledger.filter((r) => r.status !== "open" && r.realizedR != null && r.status !== "expired");
    const summary = (rows) => {
      const n = rows.length;
      const wins = rows.filter((r) => r.realizedR > 0).length;
      const avg = n ? rows.reduce((a, r) => a + r.realizedR, 0) / n : 0;
      return { n, winRate: n ? (wins / n) * 100 : 0, avgR: avg, expectancy: avg };
    };
    const perSetup = {};
    for (const r of closed) (perSetup[r.setupName || r.setup] ||= []).push(r);
    return {
      overall: summary(closed),
      bySetup: Object.fromEntries(Object.entries(perSetup).map(([k, v]) => [k, summary(v)])),
      total: this.ledger.length,
      open: this.ledger.filter((r) => r.status === "open").length,
    };
  }

  status(wsStatus) {
    return {
      pairs: this.symbols().length,
      cycleMs: this.cycleMs,
      lastUpdate: this.lastScanMs,
      ws: wsStatus,
      active: this.signals.size,
      forming: this.feed.filter((f) => f.kind === "forming").length,
    };
  }

  snapshot(wsStatus) {
    return { feed: this.feed, ledger: this.ledger.slice(-200), summary: this.ledgerSummary(), status: this.status(wsStatus) };
  }
}

// --- helpers ---------------------------------------------------------------
function rankKind(k) { return k === "active" ? 0 : 1; }
function statusLabel(state) {
  return { waiting: "LOCKED", running: "RUNNING", tp1: "TP1 HIT", tp2: "TP2 HIT", stopped: "STOPPED", expired: "EXPIRED" }[state] || "LOCKED";
}

/** Run an array of thunks with a concurrency limit. */
async function runLimited(thunks, limit) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, thunks.length) }, async () => {
    while (i < thunks.length) {
      const idx = i++;
      await thunks[idx]();
      if (CONFIG.timing.klineStaggerMs) await sleep(CONFIG.timing.klineStaggerMs);
    }
  });
  await Promise.all(workers);
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
