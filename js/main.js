// ============================================================================
// main.js — App state, fetch loop, rendering orchestration.
//
// This build is a trade-plan generator: the hero is either ONE actionable plan
// or an explicit NO-TRADE. Plans persist across refreshes and their outcome is
// tracked live (awaiting entry / running / TP1 / TP2 / stopped / invalidated).
// ============================================================================
import { CONFIG } from "./config.js";
import { fetchMarketData } from "./api.js";
import { evaluate, trackOutcome } from "./confluence.js";
import { createChartManager } from "./chart.js";
import { mountAdvancedWidget } from "./tvwidget.js";

const state = {
  symbol: CONFIG.defaultPair,
  interval: CONFIG.defaultInterval,
  autoRefresh: false,
  timer: null,
  loading: false,
  candles: [],
  htfCandles: [],
  source: null,
  activePlan: null, // persisted plan being tracked
  history: [], // { plan, state, note }
  chartMgr: null,
  activeTab: "lw",
  advMountedFor: null,
  notifications: CONFIG.notifications.enabled,
};

const el = {};
function cacheEls() {
  for (const id of [
    "pairSelect", "pairInput", "intervalSelect", "refreshBtn", "autoToggle", "notifyToggle",
    "price", "change", "sourceTag", "htfTag", "lastUpdate", "statusBar",
    "hero", "strategyGrid", "history",
    "tabLw", "tabAdv", "lwChart", "advChart", "chartNote",
  ]) el[id] = document.getElementById(id);
}

export function init() {
  cacheEls();
  buildControls();
  bindEvents();
  state.chartMgr = createChartManager(el.lwChart);
  refresh();
}

function buildControls() {
  for (const p of CONFIG.pairs) {
    const o = document.createElement("option");
    o.value = o.textContent = p;
    if (p === state.symbol) o.selected = true;
    el.pairSelect.appendChild(o);
  }
  for (const iv of CONFIG.intervals) {
    const o = document.createElement("option");
    o.value = o.textContent = iv;
    if (iv === state.interval) o.selected = true;
    el.intervalSelect.appendChild(o);
  }
  el.autoToggle.textContent = "Auto: OFF";
  el.notifyToggle.textContent = "🔔 Alerts: OFF";
}

function bindEvents() {
  el.pairSelect.addEventListener("change", () => { state.symbol = el.pairSelect.value; el.pairInput.value = ""; onMarketChange(); });
  el.pairInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && el.pairInput.value.trim()) { state.symbol = el.pairInput.value.trim().toUpperCase(); onMarketChange(); }
  });
  el.intervalSelect.addEventListener("change", () => { state.interval = el.intervalSelect.value; onMarketChange(); });
  el.refreshBtn.addEventListener("click", refresh);
  el.autoToggle.addEventListener("click", toggleAuto);
  el.notifyToggle.addEventListener("click", toggleNotify);
  el.tabLw.addEventListener("click", () => switchTab("lw"));
  el.tabAdv.addEventListener("click", () => switchTab("adv"));
}

function onMarketChange() {
  // Symbol/timeframe changed -> the old plan no longer applies.
  state.activePlan = null;
  state.advMountedFor = null;
  if (state.activeTab === "adv") mountAdv();
  refresh();
}

function toggleAuto() {
  state.autoRefresh = !state.autoRefresh;
  el.autoToggle.textContent = `Auto: ${state.autoRefresh ? "ON" : "OFF"}`;
  el.autoToggle.classList.toggle("on", state.autoRefresh);
  if (state.timer) clearInterval(state.timer);
  if (state.autoRefresh) state.timer = setInterval(refresh, CONFIG.autoRefreshSeconds * 1000);
}

async function toggleNotify() {
  state.notifications = !state.notifications;
  el.notifyToggle.textContent = `🔔 Alerts: ${state.notifications ? "ON" : "OFF"}`;
  el.notifyToggle.classList.toggle("on", state.notifications);
  if (state.notifications && "Notification" in window && Notification.permission === "default") {
    try { await Notification.requestPermission(); } catch { /* ignore */ }
  }
}

function switchTab(tab) {
  state.activeTab = tab;
  el.tabLw.classList.toggle("active", tab === "lw");
  el.tabAdv.classList.toggle("active", tab === "adv");
  el.lwChart.hidden = tab !== "lw";
  el.advChart.hidden = tab !== "adv";
  el.chartNote.textContent =
    tab === "lw"
      ? "Programmatic trade-plan levels (entry / SL / TP) are drawn on this Lightweight chart."
      : "Full TradingView tools — but the app's plan levels cannot be drawn on the embedded widget. See the Lightweight tab for those.";
  if (tab === "adv") mountAdv();
}

function mountAdv() {
  const key = `${state.symbol}:${state.interval}`;
  if (state.advMountedFor === key) return;
  state.advMountedFor = key;
  mountAdvancedWidget(el.advChart, state.symbol, state.interval);
}

// --- Fetch + evaluate loop -------------------------------------------------
async function refresh() {
  if (state.loading) return;
  state.loading = true;
  el.refreshBtn.disabled = true;
  setStatus(`Loading ${state.symbol} ${state.interval}…`, "loading");

  const htfInterval = CONFIG.htfMap[state.interval] || state.interval;
  try {
    const active = await fetchMarketData(state.symbol, state.interval, CONFIG.candleLimit);
    state.candles = active.candles;
    state.source = active.source;
    renderPrice(active.ticker);
    state.chartMgr.update(active.candles);

    // Higher-timeframe (best-effort; neutral bias if it fails).
    try {
      const htf = await fetchMarketData(state.symbol, htfInterval, CONFIG.htfCandleLimit);
      state.htfCandles = htf.candles;
      el.htfTag.textContent = `HTF: ${htfInterval}`;
    } catch {
      state.htfCandles = [];
      el.htfTag.textContent = `HTF: ${htfInterval} (unavailable)`;
    }

    const decision = evaluate(state.candles, state.htfCandles, {
      symbol: state.symbol, interval: state.interval, htfInterval,
    });
    renderStrategies(decision.strategies);
    reconcilePlan(decision);

    el.sourceTag.textContent = `Source: ${state.source}`;
    el.lastUpdate.textContent = `Updated ${new Date().toLocaleTimeString()}`;
    const warn = state.source.includes("CoinGecko") ? " — volume signals limited on this feed" : "";
    setStatus(`Live · ${state.candles.length} candles via ${state.source}${warn}`, "ok");
  } catch (err) {
    setStatus(`Error: ${err.message}`, "error");
    el.sourceTag.textContent = "Source: none (all feeds failed)";
  } finally {
    state.loading = false;
    el.refreshBtn.disabled = false;
  }
}

/**
 * Reconcile the persisted plan with the fresh decision:
 *  - update the running plan's outcome; finalise it if terminal;
 *  - otherwise adopt a newly-emitted ACTIVE plan (and alert if A/A+).
 */
function reconcilePlan(decision) {
  if (state.activePlan) {
    const outcome = trackOutcome(state.activePlan, state.candles);
    updateHistory(state.activePlan, outcome);
    const done = outcome.state === "invalidated" || outcome.exitTime != null;
    if (done) state.activePlan = null;
    else { state.chartMgr.setPlan(state.activePlan, state.candles); renderActive(state.activePlan, outcome); return; }
  }

  if (decision.status === "ACTIVE") {
    state.activePlan = decision.plan;
    const outcome = trackOutcome(state.activePlan, state.candles);
    pushHistory(state.activePlan, outcome);
    maybeAlert(state.activePlan);
    state.chartMgr.setPlan(state.activePlan, state.candles);
    renderActive(state.activePlan, outcome);
  } else {
    state.chartMgr.clearPlan();
    renderNoTrade(decision.noTrade, decision.htf);
  }
}

// --- Hero rendering --------------------------------------------------------
function renderActive(plan, outcome) {
  const long = plan.direction === "LONG";
  const dirClass = long ? "long" : "short";
  const items = plan.confluences.map((c) => `<li>${escapeHtml(c)}</li>`).join("");
  const trigTime = new Date(plan.triggerTime).toLocaleString();
  const oc = outcomeLabel(outcome);

  el.hero.className = `hero active ${dirClass}`;
  el.hero.innerHTML = `
    <div class="hero-head">
      <div class="hero-dir ${dirClass}">${plan.direction}</div>
      <div class="hero-meta">
        <div class="hero-pair">${plan.symbol} · ${plan.interval}</div>
        <div class="hero-setup">${escapeHtml(plan.name)}</div>
      </div>
      <div class="hero-right">
        <span class="tier tier-${plan.tier.replace("+", "plus")}">${plan.tier}</span>
        <span class="oc oc-${oc.cls}">${oc.text}</span>
      </div>
    </div>
    <div class="hero-levels">
      <div class="lvl entry"><span>Entry zone</span><b>${fmtP(plan.entryLow)} – ${fmtP(plan.entryHigh)}</b></div>
      <div class="lvl stop"><span>Stop-loss</span><b>${fmtP(plan.stop)}</b></div>
      <div class="lvl tp"><span>TP1 (${plan.rr1}R)</span><b>${fmtP(plan.tp1)}</b></div>
      <div class="lvl tp"><span>TP2 (${plan.rr2}R)</span><b>${fmtP(plan.tp2)}</b></div>
      <div class="lvl rr"><span>R:R</span><b>1 : ${plan.rr1} / ${plan.rr2}</b></div>
    </div>
    <div class="hero-confluence">
      <div class="hc-title">${plan.alignedCount}/10 confluences fired</div>
      <ul>${items}</ul>
    </div>
    <div class="hero-foot">
      Triggered on candle @ ${escapeHtml(trigTime)} · ${escapeHtml(outcome.note || "")}
      ${outcome.state === "invalidated" ? '<span class="invalid">INVALIDATED — price closed beyond stop</span>' : ""}
    </div>`;
}

function renderNoTrade(noTrade, htf) {
  el.hero.className = "hero notrade";
  el.hero.innerHTML = `
    <div class="nt-badge">NO TRADE</div>
    <div class="nt-title">No high-probability setup right now</div>
    <div class="nt-reason">${escapeHtml(noTrade.reason)}</div>
    <div class="nt-htf">${escapeHtml(noTrade.htfReason)} · snapshot ${noTrade.snapshot.buys} long / ${noTrade.snapshot.sells} short / ${noTrade.snapshot.neutrals} neutral</div>
    <div class="nt-hint">Standing aside is the correct action most of the time. Waiting for a clean setup.</div>`;
}

function outcomeLabel(o) {
  switch (o.state) {
    case "tp2": return { text: "TP2 HIT ✔", cls: "win" };
    case "tp1": return { text: o.exitTime ? "TP1 (rest BE)" : "TP1 HIT — runner", cls: "win" };
    case "stopped": return { text: "STOPPED", cls: "loss" };
    case "invalidated": return { text: "INVALIDATED", cls: "loss" };
    default: return { text: o.note === "awaiting entry" ? "AWAITING ENTRY" : "RUNNING", cls: "run" };
  }
}

// --- Strategy grid + history ----------------------------------------------
function renderStrategies(results) {
  el.strategyGrid.innerHTML = "";
  for (const r of results) {
    const d = document.createElement("div");
    d.className = "strategy-card " + r.signal.toLowerCase();
    d.innerHTML = `
      <div class="sc-top"><span class="sc-name">${r.name}</span><span class="sc-signal ${r.signal.toLowerCase()}">${r.signal}</span></div>
      <div class="sc-bar"><div class="sc-bar-fill ${r.signal.toLowerCase()}" style="width:${r.strength}%"></div></div>
      <div class="sc-meta"><span class="sc-strength">${r.strength}</span><span class="sc-reason">${escapeHtml(r.reason)}</span></div>`;
    el.strategyGrid.appendChild(d);
  }
}

function pushHistory(plan, outcome) {
  state.history.unshift({ plan, state: outcome.state, note: outcome.note, id: plan.createdAt });
  if (state.history.length > 40) state.history.pop();
  renderHistory();
}
function updateHistory(plan, outcome) {
  const rec = state.history.find((h) => h.id === plan.createdAt);
  if (rec) { rec.state = outcome.state; rec.note = outcome.note; renderHistory(); }
}
function renderHistory() {
  el.history.innerHTML = "";
  if (!state.history.length) { el.history.innerHTML = '<div class="hist-empty">No plans yet this session.</div>'; return; }
  for (const h of state.history) {
    const p = h.plan;
    const oc = outcomeLabel({ state: h.state, note: h.note, exitTime: h.state === "tp1" ? undefined : true });
    const row = document.createElement("div");
    row.className = "hist-row";
    row.innerHTML = `
      <span class="ht-time">${new Date(p.createdAt).toLocaleTimeString()}</span>
      <span class="ht-dir ${p.direction.toLowerCase()}">${p.direction}</span>
      <span class="ht-setup">${escapeHtml(p.name)} <span class="ht-tier">${p.tier}</span></span>
      <span class="ht-lv">@${fmtP(p.entryPrice)} SL ${fmtP(p.stop)}</span>
      <span class="ht-state st-${oc.cls}">${oc.text}</span>`;
    el.history.appendChild(row);
  }
}

// --- Alerts ----------------------------------------------------------------
function maybeAlert(plan) {
  if (!state.notifications) return;
  const order = { "A+": 3, A: 2, B: 1 };
  if ((order[plan.tier] || 0) < (order[CONFIG.notifications.minTierForAlert] || 2)) return;
  beep();
  if ("Notification" in window && Notification.permission === "granted") {
    try { new Notification(`${plan.tier} ${plan.direction} — ${plan.symbol} ${plan.interval}`, { body: plan.rationale }); } catch { /* ignore */ }
  }
}
function beep() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.frequency.value = 880; g.gain.value = 0.05;
    o.start(); o.stop(ctx.currentTime + 0.15);
  } catch { /* ignore */ }
}

// --- Small helpers ---------------------------------------------------------
function renderPrice(ticker) {
  el.price.textContent = fmtP(ticker.lastPrice);
  const pct = ticker.priceChangePercent;
  el.change.textContent = `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`;
  el.change.className = "change " + (pct >= 0 ? "pos" : "neg");
}
function setStatus(msg, kind) { el.statusBar.textContent = msg; el.statusBar.className = "status-bar " + (kind || ""); }
function fmtP(p) {
  if (p == null || !isFinite(p)) return "—";
  if (p >= 1000) return "$" + p.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (p >= 1) return "$" + p.toFixed(2);
  if (p >= 0.01) return "$" + p.toFixed(4);
  return "$" + p.toPrecision(4);
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
else init();
