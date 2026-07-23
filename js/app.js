// ============================================================================
// app.js — Browser client (thin). All scanning happens server-side; this just
// renders what the server pushes over SSE and handles the detail view.
// ============================================================================
import { createChartManager } from "./chart.js";
import { mountAdvancedWidget } from "./tvwidget.js";

const stateUI = {
  feed: [],
  prices: {},
  ledger: [],
  summary: null,
  notifications: false,
  seenSignals: new Set(),
  detailChart: null,
  detailFor: null,
  detailTab: "lw",
};

const el = (id) => document.getElementById(id);

init();
function init() {
  el("notifyToggle").addEventListener("click", toggleNotify);
  el("detailClose").addEventListener("click", closeDetail);
  el("detail").addEventListener("click", (e) => { if (e.target === el("detail")) closeDetail(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !el("detail").hidden) closeDetail(); });
  el("tabLw").addEventListener("click", () => detailTab("lw"));
  el("tabAdv").addEventListener("click", () => detailTab("adv"));
  connect();
}

// --- SSE -------------------------------------------------------------------
function connect() {
  const es = new EventSource("/events");
  es.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === "scan") {
      stateUI.feed = msg.feed || [];
      stateUI.ledger = msg.ledger || stateUI.ledger;
      stateUI.summary = msg.summary || stateUI.summary;
      renderStatus(msg.status);
      renderFeed();
      renderLedger();
    } else if (msg.type === "prices") {
      Object.assign(stateUI.prices, msg.prices || {});
      applyPrices();
    } else if (msg.type === "signal") {
      handleNewSignal(msg.signal);
    } else if (msg.type === "ledger") {
      stateUI.ledger = msg.ledger || stateUI.ledger;
      stateUI.summary = msg.summary || stateUI.summary;
      renderLedger();
    }
  };
  es.onerror = () => { el("stWs").textContent = "reconnecting…"; el("stWs").className = "ws err"; };
}

// --- Status line -----------------------------------------------------------
function renderStatus(s) {
  if (!s) return;
  el("stPairs").textContent = `${s.pairs} pairs`;
  el("stCycle").textContent = `${s.cycleMs} ms/cycle`;
  if (s.btcBias) {
    el("stBtc").textContent = `BTC ${s.btcBias}`;
    el("stBtc").className = "ws " + (s.btcBias === "BULL" ? "ok" : s.btcBias === "BEAR" ? "err" : "");
  }
  el("stWs").textContent = s.ws;
  el("stWs").className = "ws" + (String(s.ws).toLowerCase().includes("error") ? " err" : " ok");
  el("stUpdate").textContent = s.lastUpdate ? "updated " + new Date(s.lastUpdate).toLocaleTimeString() : "—";
}

// --- Scanner feed ----------------------------------------------------------
function renderFeed() {
  const feed = stateUI.feed;
  el("feedCount").textContent = `${feed.length} signal${feed.length === 1 ? "" : "s"}`;
  el("feedEmpty").hidden = feed.length > 0;
  const wrap = el("feed");
  wrap.innerHTML = "";
  for (const item of feed) wrap.appendChild(card(item));
}

function card(item) {
  const long = item.direction === "LONG";
  const d = document.createElement("div");
  d.className = `card ${item.kind} ${long ? "long" : "short"}`;
  const chips = (item.contributors || []).map((c) => {
    const arrow = c.dir === "LONG" ? '<span class="ca long">▲</span>' : c.dir === "SHORT" ? '<span class="ca short">▼</span>' : "";
    return `<span class="chip">${arrow}${esc(c.name)} · ${c.score}</span>`;
  }).join("");
  const badge = statusBadge(item);
  const age = item.age != null ? `${item.age} bars` : item.kind === "forming" ? "forming" : "—";
  const cap = item.exposureCapped ? '<span class="badge b-exp" title="Beyond the same-direction exposure cap">EXP-CAP</span>' : "";
  const regime = item.regimeDowngraded ? '<span class="badge b-exp" title="Slower HTF regime opposes — tier downgraded">REGIME↓</span>' : "";
  const missing = item.forming && item.missing ? `<div class="card-missing">Waiting: ${esc(item.missing.join(", "))}</div>` : "";
  d.innerHTML = `
    <div class="card-top">
      <div class="card-id">
        <span class="dir ${long ? "long" : "short"}">${item.direction}</span>
        <span class="pair">${esc(item.symbol)}</span>
        <span class="tf">${esc(item.interval)}</span>
      </div>
      ${ring(item.score)}
    </div>
    <div class="card-levels">
      <div><span>Entry</span><b>${fmtP(item.entryLow)}–${fmtP(item.entryHigh)}</b></div>
      <div><span>SL</span><b class="sl">${fmtP(item.stop)}</b></div>
      <div><span>TP1</span><b class="tp">${fmtP(item.tp1)}</b></div>
      <div><span>TP2</span><b class="tp">${fmtP(item.tp2)}</b></div>
    </div>
    <div class="card-chips">${chips}</div>
    ${missing}
    <div class="card-foot">
      <span class="tier tier-${(item.tier || "B").replace("+", "plus")}">${item.tier || "B"}</span>
      ${badge}${cap}${regime}
      <span class="age">${age}</span>
      <span class="live" data-sym="${esc(item.symbol)}">${item.price != null ? fmtP(item.price) : ""}</span>
    </div>`;
  d.addEventListener("click", () => openDetail(item));
  return d;
}

function ring(score = 0) {
  const s = Math.max(0, Math.min(100, score));
  const color = s >= 75 ? "var(--up)" : s >= 55 ? "var(--gold)" : "var(--muted)";
  return `<div class="ring" style="background:conic-gradient(${color} ${s * 3.6}deg, var(--panel-2) 0)"><span>${s}</span></div>`;
}

function statusBadge(item) {
  const st = item.status || (item.kind === "forming" ? "FORMING" : "LOCKED");
  const cls = { LOCKED: "b-lock", FORMING: "b-form", RUNNING: "b-run", "TP1 HIT": "b-win", "TP2 HIT": "b-win", STOPPED: "b-loss", EXPIRED: "b-exp" }[st] || "b-lock";
  return `<span class="badge ${cls}">${st}</span>`;
}

function applyPrices() {
  for (const span of document.querySelectorAll(".live[data-sym]")) {
    const p = stateUI.prices[span.getAttribute("data-sym")];
    if (p != null) span.textContent = fmtP(p);
  }
}

// --- Ledger ----------------------------------------------------------------
function renderLedger() {
  const s = stateUI.summary;
  if (s) {
    const o = s.overall;
    el("ledgerSummary").innerHTML = `
      <div class="ls-row">
        <div><span>Signals</span><b>${o.n}${o.n ? ` <small class="muted">(${o.wins}W/${o.losses}L)</small>` : ""}</b></div>
        <div><span>Win rate</span><b>${o.n ? o.winRate.toFixed(0) + "%" : "—"}</b></div>
        <div><span>Avg R net</span><b class="${pnlCls(o.avgR)}">${o.n ? fmtR(o.avgR) : "—"}</b></div>
        <div><span>Net R (PnL)</span><b class="${pnlCls(o.totalR)}">${o.n ? fmtR(o.totalR) : "—"}</b></div>
      </div>
      <div class="ls-gross">${o.n ? `Gross ${fmtR(o.grossTotalR)}R → Net ${fmtR(o.totalR)}R after fees + slippage` : "Gross → Net after fees + slippage"}</div>
      <div class="ls-setups">${Object.entries(s.bySetup || {}).map(([k, v]) => `<span class="ls-chip">${esc(k)}: <b class="${pnlCls(v.totalR)}">${fmtR(v.totalR)}R</b> net <small class="muted">(gross ${fmtR(v.grossTotalR)})</small> ×${v.n}</span>`).join("")}</div>
      ${Object.keys(s.byBtcRegime || {}).length ? `<div class="ls-setups">${Object.entries(s.byBtcRegime).map(([k, v]) => `<span class="ls-chip">BTC ${esc(k)}: <b class="${pnlCls(v.totalR)}">${fmtR(v.totalR)}R</b> ×${v.n}</span>`).join("")}</div>` : ""}`;
  }
  const rows = [...stateUI.ledger].reverse().slice(0, 60);
  el("ledger").innerHTML = rows.map((r) => {
    const cls = r.status === "open" ? "run" : r.realizedR > 0 ? "win" : r.realizedR < 0 ? "loss" : "muted";
    const out = r.status === "open" ? "open" : `${r.status} ${r.realizedR != null ? fmtR(r.realizedR) + "R" : ""}`;
    return `<div class="lg-row">
      <span class="lg-dir ${r.direction.toLowerCase()}">${r.direction}</span>
      <span class="lg-pair">${esc(r.symbol)} ${esc(r.interval)}</span>
      <span class="lg-setup">${esc(r.setupName || r.setup)} <b>${r.score}</b></span>
      <span class="lg-out ${cls}">${esc(out)}</span>
    </div>`;
  }).join("") || '<div class="feed-empty">No signals recorded yet.</div>';
}

// --- Detail view -----------------------------------------------------------
async function openDetail(item) {
  stateUI.detailFor = item;
  el("detail").hidden = false;
  el("detailTitle").innerHTML = `<span class="dir ${item.direction.toLowerCase()}">${item.direction}</span> ${esc(item.symbol)} · ${esc(item.interval)} · <span class="tier tier-${(item.tier || "B").replace("+", "plus")}">${item.tier || "B"}</span> · score ${item.score}`;
  el("detailChecklist").innerHTML = (item.confluences || []).map((c) => `<li>${esc(c)}</li>`).join("");
  detailTab("lw");

  if (!stateUI.detailChart) stateUI.detailChart = createChartManager(el("detailChart"));
  try {
    const r = await fetch(`/api/klines?symbol=${encodeURIComponent(item.symbol)}&interval=${encodeURIComponent(item.interval)}&limit=200`);
    const data = await r.json();
    if (data.candles) {
      stateUI.detailChart.update(data.candles);
      stateUI.detailChart.setPlan(item, data.candles);
    }
  } catch { /* chart optional */ }
}
function detailTab(tab) {
  stateUI.detailTab = tab;
  el("tabLw").classList.toggle("active", tab === "lw");
  el("tabAdv").classList.toggle("active", tab === "adv");
  el("detailChart").hidden = tab !== "lw";
  el("detailAdv").hidden = tab !== "adv";
  el("chartNote").textContent = tab === "lw"
    ? "Frozen entry / SL / TP lines are drawn on this Lightweight chart."
    : "Full TradingView tools — frozen plan levels aren't drawn on the embedded widget (see the Signal chart tab).";
  if (tab === "adv" && stateUI.detailFor) mountAdvancedWidget(el("detailAdv"), stateUI.detailFor.symbol, stateUI.detailFor.interval);
}
function closeDetail() { el("detail").hidden = true; stateUI.detailFor = null; }

// --- Alerts ----------------------------------------------------------------
async function toggleNotify() {
  stateUI.notifications = !stateUI.notifications;
  el("notifyToggle").textContent = `🔔 Alerts: ${stateUI.notifications ? "ON" : "OFF"}`;
  el("notifyToggle").classList.toggle("on", stateUI.notifications);
  if (stateUI.notifications && "Notification" in window && Notification.permission === "default") {
    try { await Notification.requestPermission(); } catch { /* */ }
  }
}
function handleNewSignal(sig) {
  if (!sig || stateUI.seenSignals.has(sig.signalId)) return;
  stateUI.seenSignals.add(sig.signalId);
  const order = { "A+": 3, A: 2, B: 1 };
  if (stateUI.notifications && (order[sig.tier] || 0) >= 2) {
    beep();
    if ("Notification" in window && Notification.permission === "granted") {
      try { new Notification(`${sig.tier} ${sig.direction} — ${sig.symbol} ${sig.interval}`, { body: `${sig.name} · score ${sig.score}` }); } catch { /* */ }
    }
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
  } catch { /* */ }
}

// --- format helpers --------------------------------------------------------
function fmtP(p) {
  if (p == null || !isFinite(p)) return "—";
  if (p >= 1000) return p.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (p >= 1) return p.toFixed(3);
  if (p >= 0.01) return p.toFixed(5);
  return p.toPrecision(4);
}
function fmtR(v) { return Number.isFinite(v) ? (v >= 0 ? "+" : "") + v.toFixed(2) : "—"; }
function pnlCls(v) { return v > 0 ? "pnl-pos" : v < 0 ? "pnl-neg" : ""; }
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
