// ============================================================================
// analyze-results.js — turn a `npm run validate` run into a conservative verdict.
//   node analyze-results.js results/<timestamp>/
//
// Reads the structured JSON a validate run saved (matrix/walk/compare + the
// copied data-manifest + run-meta) and writes VALIDATION.md next to them, plus a
// PROPOSED js/config.js diff printed to stdout for HUMAN review. It NEVER edits
// config.js, and NEVER makes a recommendation from fewer trades than
// backtest.minTradesForVerdict.
//
// Rules:
//   (a) setup×TF with negative net expectancy AND n >= minTradesForVerdict
//       -> proposed for config.disabledSetups.
//   (b) walk-forward OOS-selected parameters adopted ONLY when the aggregate OOS
//       had >= minTradesForVerdict trades AND non-negative net expectancy;
//       otherwise keep current defaults and say so.
//   (c) anything below the trade minimum -> "unresolved: need more history",
//       never a recommendation.
// ============================================================================
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Robust "is this file being run directly?" — the naive
// `import.meta.url === "file://" + process.argv[1]` check silently fails (script
// does nothing, exits 0) when the two paths differ by URL-encoding, a symlink, or
// a relative invocation. Compare real filesystem paths instead.
function isRunDirectly() {
  try { return process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); }
  catch { return false; }
}
import { CONFIG } from "./js/config.js";

// ---- load -----------------------------------------------------------------
export function loadRun(dir) {
  const read = (f) => { const p = path.join(dir, f); return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null; };
  const matrix = read("matrix.json");
  const walk = read("walk.json");
  const compare = read("compare.json");
  const dataManifest = read("data-manifest.json");
  const meta = read("run-meta.json");
  if (!matrix && !walk) throw new Error(`no matrix.json/walk.json in ${dir} — is this a validate results folder?`);
  return { dir, matrix, walk, compare, dataManifest, meta };
}

// ---- verdict (pure) -------------------------------------------------------
export function analyze(run) {
  const minTrades = (run.meta && run.meta.minTradesForVerdict) || CONFIG.backtest.minTradesForVerdict;

  // (a) + (c) from the matrix setup×TF cells.
  const disable = [];       // negative & sufficient -> propose disable
  const keptPositive = [];  // positive & sufficient -> validated, keep
  const unresolved = [];    // insufficient -> need more history
  const bySetupTf = (run.matrix && run.matrix.bySetupTf) || {};
  for (const [combo, s] of Object.entries(bySetupTf)) {
    if (s.n >= minTrades) {
      if (s.netAvg < 0) disable.push({ combo, n: s.n, netAvg: s.netAvg, pf: s.pf, winRate: s.winRate });
      else keptPositive.push({ combo, n: s.n, netAvg: s.netAvg, pf: s.pf, winRate: s.winRate });
    } else {
      unresolved.push({ combo, n: s.n, netAvg: s.netAvg, reason: `n=${s.n} < ${minTrades}` });
    }
  }
  disable.sort((a, b) => a.netAvg - b.netAvg);
  unresolved.sort((a, b) => b.n - a.n);

  // (b) walk-forward parameter adoption.
  const walk = run.walk;
  let walkVerdict;
  if (!walk) walkVerdict = { status: "missing", detail: "no walk.json in this run" };
  else if (walk.insufficient) walkVerdict = { status: "insufficient", detail: walk.reason || "insufficient data for folds" };
  else if (!walk.oos || !walk.oos.n) walkVerdict = { status: "no-oos", detail: `${walk.includedFolds || 0}/${walk.folds} folds contributed OOS trades` };
  else {
    const exp = walk.oos.expectancy ?? walk.oos.netAvg ?? 0;
    const sufficient = walk.oos.n >= minTrades;
    const nonNeg = exp >= 0;
    if (sufficient && nonNeg) {
      walkVerdict = { status: "adopt", oosN: walk.oos.n, exp, params: consensusParams(walk.selectedParams) };
    } else {
      walkVerdict = {
        status: "keep-defaults", oosN: walk.oos.n, exp,
        detail: !sufficient ? `OOS n=${walk.oos.n} < ${minTrades} (insufficient)` : `OOS net ${exp.toFixed(2)}R < 0 (not an edge)`,
      };
    }
  }

  // Was ANY sufficient-sample cell positive (drives the honest bottom line)?
  const anySufficient = disable.length + keptPositive.length > 0;
  const anyPositive = keptPositive.length > 0 || (walkVerdict.status === "adopt");
  const allNegativeGivenData = anySufficient && keptPositive.length === 0 && (!walk || walkVerdict.status !== "adopt");

  return { minTrades, disable, keptPositive, unresolved, walkVerdict, anySufficient, anyPositive, allNegativeGivenData };
}

/** Most-frequent grid combo among the folds that contributed OOS (or null). */
function consensusParams(selected) {
  if (!selected || !selected.length) return null;
  const counts = new Map();
  for (const p of selected) { const k = JSON.stringify(p); counts.set(k, (counts.get(k) || 0) + 1); }
  let bestK = null, bestN = 0;
  for (const [k, n] of counts) if (n > bestN) { bestN = n; bestK = k; }
  return { combo: JSON.parse(bestK), agreeFolds: bestN, totalFolds: selected.length, unanimous: bestN === selected.length };
}

// ---- proposed config diff (text; NEVER applied) ---------------------------
export function proposedConfigDiff(analysis, run) {
  const tf = (run.walk && run.walk.tf) || (run.matrix && run.matrix.tf) || "5m";
  const lines = [];
  const hunk = (label, oldL, newL, why) => lines.push(`  @@ ${label} @@\n-  ${oldL}\n+  ${newL}   // ${why}`);

  // disabledSetups (rule a).
  if (analysis.disable.length) {
    const arr = analysis.disable.map((d) => d.combo);
    hunk("disabledSetups", `disabledSetups: ${JSON.stringify(CONFIG.disabledSetups)},`,
      `disabledSetups: ${JSON.stringify(arr)},`,
      `negative net expectancy at n>=${analysis.minTrades}: ` + analysis.disable.map((d) => `${d.combo} ${d.netAvg.toFixed(2)}R/${d.n}`).join(", "));
  }

  // walk-forward params (rule b) — only when adopted.
  if (analysis.walkVerdict.status === "adopt" && analysis.walkVerdict.params && analysis.walkVerdict.params.combo) {
    const g = analysis.walkVerdict.params.combo;
    const why = `walk OOS net +${analysis.walkVerdict.exp.toFixed(2)}R over ${analysis.walkVerdict.oosN} trades; chosen by ${analysis.walkVerdict.params.agreeFolds}/${analysis.walkVerdict.params.totalFolds} folds`;
    if (g.minAgree != null && g.minAgree !== CONFIG.gate.minAgree) hunk("gate", `minAgree: ${CONFIG.gate.minAgree},`, `minAgree: ${g.minAgree},`, why);
    if (g.recency != null && g.recency !== CONFIG.gate.triggerRecencyBars) hunk("gate", `triggerRecencyBars: ${CONFIG.gate.triggerRecencyBars},`, `triggerRecencyBars: ${g.recency},`, why);
    if (g.expireBars != null && g.expireBars !== CONFIG.scalper.expireBars[tf]) hunk(`scalper.expireBars["${tf}"]`, `"${tf}": ${CONFIG.scalper.expireBars[tf]}`, `"${tf}": ${g.expireBars}`, why);
    if (g.capScale != null) {
      const proposed = +(CONFIG.scalper.stopCapPct[tf] * g.capScale).toFixed(3);
      if (proposed !== CONFIG.scalper.stopCapPct[tf]) hunk(`scalper.stopCapPct["${tf}"]`, `"${tf}": ${CONFIG.scalper.stopCapPct[tf]}`, `"${tf}": ${proposed}`, `${why} (capScale ${g.capScale})`);
    }
  }

  if (!lines.length) return "  (no config changes proposed — see VALIDATION.md for why)";
  return `--- a/js/config.js\n+++ b/js/config.js\n${lines.join("\n")}`;
}

// ---- markdown report ------------------------------------------------------
function fmtDate(ms) { return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") + "Z" : "?"; }
function pct(v) { return Number.isFinite(v) ? v.toFixed(0) + "%" : "—"; }
function R(v) { return Number.isFinite(v) ? (v >= 0 ? "+" : "") + v.toFixed(2) : "—"; }
function pf(v) { return v === null || v === undefined ? "—" : (v === Infinity || v > 1e6 ? "∞" : Number(v).toFixed(2)); }

export function renderMarkdown(analysis, run) {
  const L = [];
  const meta = run.meta || {};
  const dm = run.dataManifest || {};
  L.push(`# VALIDATION — ${meta.generatedAt || dm.fetchedAt || "unknown run"}`);
  L.push("");
  L.push(`> Automated verdict from \`analyze-results.js\`. Conservative by construction: no recommendation rests on fewer than **${analysis.minTrades}** trades (\`backtest.minTradesForVerdict\`). Config is **not** modified — proposed changes are a diff for you to review.`);
  L.push("");

  // Provenance.
  L.push("## Data provenance");
  L.push("");
  L.push(`- Source: **${dm.source || "?"}** · fetched **${dm.fetchedAt || "?"}** · primary fetch TF ${dm.primaryTf || "?"} · target ${dm.target ?? "?"} candles`);
  L.push(`- Pairs (${meta.nPairs ?? (meta.pairs ? meta.pairs.length : "?")}): ${(meta.pairs || Object.keys(dm.perPair || {})).join(", ") || "?"}`);
  L.push(`- Replay window: ${meta.replayWindowBars ?? CONFIG.replay.windowBars} bars (live-parity) · 1m present: ${meta.has1m ? "yes" : "no"}`);
  if (dm.perPair) {
    L.push("");
    L.push("| pair | tf | requested | received | gaps |");
    L.push("|---|---|--:|--:|--:|");
    for (const [sym, rec] of Object.entries(dm.perPair)) for (const [tf, r] of Object.entries(rec)) {
      L.push(`| ${sym} | ${tf} | ${r.requested ?? "?"} | ${r.received ?? (r.error ? "ERR" : "?")} | ${r.gaps ?? 0} |`);
    }
  }
  if (meta.manifestIssues && meta.manifestIssues.length) {
    L.push("");
    L.push(`⚠ ${meta.manifestIssues.length} snapshot issue(s):`);
    for (const s of meta.manifestIssues) L.push(`- ${s}`);
  }
  L.push("");

  // Matrix table.
  if (run.matrix) {
    L.push("## Setup × timeframe (net expectancy)");
    L.push("");
    L.push("| setup@tf | n | win% | net R | PF | verdict |");
    L.push("|---|--:|--:|--:|--:|---|");
    const cells = Object.entries(run.matrix.bySetupTf || {}).sort((a, b) => b[1].n - a[1].n);
    for (const [combo, s] of cells) {
      let v;
      if (s.n < analysis.minTrades) v = `unresolved (n<${analysis.minTrades})`;
      else if (s.netAvg < 0) v = "**negative → propose disable**";
      else v = "positive (keep)";
      L.push(`| ${combo} | ${s.n} | ${pct(s.winRate)} | ${R(s.netAvg)} | ${pf(s.pf)} | ${v} |`);
    }
    L.push("");
    L.push(`Overall: n ${run.matrix.overall?.n ?? 0}, net ${R(run.matrix.overall?.netAvg)}, PF ${pf(run.matrix.overall?.pf)}.`);
    L.push("");

    // Stop-distance audit — the cost-vs-stop diagnostic.
    if (run.matrix.stopAudit && Object.keys(run.matrix.stopAudit).length) {
      const cp = (run.matrix.costPct ?? 0) * 100;
      L.push(`### Stop-distance audit`);
      L.push("");
      L.push(`Round-trip modeled cost ≈ **${cp.toFixed(3)}%** of price. \`costs_in_R ≈ cost% / stop%\` — a stop far below the cost bleeds most of its R to fees/slippage on a loss.`);
      L.push("");
      L.push("| setup | n | p10% | p50% | p90% | costs_in_R @ p50 | floored |");
      L.push("|---|--:|--:|--:|--:|--:|--:|");
      for (const [id, a] of Object.entries(run.matrix.stopAudit)) {
        const cir = a.p50 > 0 ? cp / a.p50 : Infinity;
        L.push(`| ${id} | ${a.n} | ${a.p10?.toFixed(3)} | ${a.p50?.toFixed(3)} | ${a.p90?.toFixed(3)} | ${R(cir)} | ${a.floored}/${a.n} |`);
      }
      L.push("");
    }
  }

  // Walk-forward.
  if (run.walk) {
    L.push("## Walk-forward (out-of-sample)");
    L.push("");
    if (run.walk.insufficient) {
      L.push(`Insufficient data: ${run.walk.reason}. Coverage ${run.walk.coveragePct?.toFixed?.(0) ?? "?"}%.`);
    } else {
      L.push(`- ${run.walk.pairs} pair(s) pooled · usable ${run.walk.usable} · train ${run.walk.trainBars}/test ${run.walk.testBars} · folds ${run.walk.folds} · coverage ${run.walk.coveragePct?.toFixed?.(0)}%`);
      const oos = run.walk.oos || {};
      L.push(`- Aggregate OOS: n **${oos.n ?? 0}**, net **${R(oos.expectancy ?? oos.netAvg)}**, PF ${pf(oos.pf)} (from ${run.walk.includedFolds}/${run.walk.folds} folds)`);
      L.push("");
      L.push("| fold | selectable | chosen (minAgree,capScale,expire,recency) | trainN | trainNet | testN | testNet | note |");
      L.push("|--:|:--:|---|--:|--:|--:|--:|---|");
      for (const f of run.walk.foldRows || []) {
        if (!f.selectable) { L.push(`| ${f.index} | no | — | ${f.trainN} | — | 0 | — | ${f.reason || ""} |`); continue; }
        const g = f.chosen || {};
        L.push(`| ${f.index} | yes | (${g.minAgree},${g.capScale},${g.expireBars},${g.recency}) | ${f.trainN} | ${R(f.trainNet)} | ${f.testN} | ${R(f.testNet)} | ${f.included ? "included" : (f.reason || "excluded")} |`);
      }
    }
    L.push("");
  }

  // Compare (if present and not skipped).
  if (run.compare && !run.compare.skipped) {
    L.push(`## ${run.compare.tfA} vs ${run.compare.tfB}`);
    L.push("");
    L.push(`| setup | ${run.compare.tfA} (netR/PF/n) | ${run.compare.tfB} (netR/PF/n) | verdict |`);
    L.push("|---|---|---|---|");
    for (const s of run.compare.perSetup || []) {
      L.push(`| ${s.name} | ${R(s.a.netAvg)}/${pf(s.a.pf)}/${s.a.n} | ${R(s.b.netAvg)}/${pf(s.b.pf)}/${s.b.n} | ${s.verdict} |`);
    }
    L.push("");
  } else if (run.compare && run.compare.skipped) {
    L.push(`## 1m vs 5m`);
    L.push("");
    L.push(`Skipped — ${run.compare.reason}.`);
    L.push("");
  }

  // Proposed changes.
  L.push("## Proposed config changes");
  L.push("");
  if (analysis.disable.length) {
    L.push(`**Disable (rule a — negative net at n ≥ ${analysis.minTrades}):**`);
    for (const d of analysis.disable) L.push(`- \`${d.combo}\` — net ${R(d.netAvg)} over ${d.n} trades (PF ${pf(d.pf)}, win ${pct(d.winRate)})`);
    L.push("");
  } else {
    L.push("- No setup×TF reached the trade minimum with negative expectancy, so nothing is proposed for `disabledSetups`.");
    L.push("");
  }
  if (analysis.walkVerdict.status === "adopt") {
    const p = analysis.walkVerdict.params;
    L.push(`**Parameters (rule b — walk OOS is sound: n ${analysis.walkVerdict.oosN} ≥ ${analysis.minTrades}, net ${R(analysis.walkVerdict.exp)}):** adopt \`${JSON.stringify(p.combo)}\` (chosen by ${p.agreeFolds}/${p.totalFolds} contributing folds${p.unanimous ? ", unanimous" : ""}).`);
  } else {
    L.push(`**Parameters (rule b):** keep current defaults — ${walkReason(analysis.walkVerdict)}.`);
  }
  L.push("");
  L.push("```diff");
  L.push(proposedConfigDiff(analysis, run));
  L.push("```");
  L.push("");

  // Unresolved.
  L.push("## Unresolved — need more history");
  L.push("");
  if (analysis.unresolved.length) {
    L.push(`These cells did not reach ${analysis.minTrades} trades; **no recommendation is made** for them. Fetch more history / pool more pairs.`);
    L.push("");
    L.push("| setup@tf | n | net R (unreliable) |");
    L.push("|---|--:|--:|");
    for (const u of analysis.unresolved) L.push(`| ${u.combo} | ${u.n} | ${R(u.netAvg)} |`);
  } else {
    L.push("- None — every setup×TF cell reached the trade minimum.");
  }
  L.push("");

  // Bottom line.
  L.push("## Bottom line");
  L.push("");
  L.push(bottomLine(analysis, run));
  L.push("");
  return L.join("\n");
}

function walkReason(v) {
  if (v.status === "missing") return "no walk-forward run in this results folder";
  if (v.status === "insufficient") return `walk-forward had insufficient data (${v.detail})`;
  if (v.status === "no-oos") return `no fold produced enough OOS trades (${v.detail})`;
  if (v.status === "keep-defaults") return v.detail;
  return "no sound out-of-sample edge to adopt from";
}

function bottomLine(analysis, run) {
  const minT = analysis.minTrades;
  if (!analysis.anySufficient && analysis.walkVerdict.status !== "adopt") {
    return `**Inconclusive — not enough data.** No setup×TF cell reached the ${minT}-trade minimum and the walk-forward produced no sound out-of-sample sample, so this run supports **no** config change. This is a data-volume problem, not a strategy verdict: fetch more history (deeper \`--limit\`) and/or pool more pairs, then re-run. Nothing here should be acted on.`;
  }
  if (analysis.allNegativeGivenData) {
    return `**No edge on this data.** Every setup×TF that reached the ${minT}-trade minimum showed **negative** net expectancy, and the walk-forward found no sound out-of-sample edge. Plainly: **no setup showed positive net expectancy on this data, and parameter tuning is not the fix** — the proposed \`disabledSetups\` above only stop the bleeding. Re-validate on more/fresher data before trusting any setup live; if it stays negative, the signal logic (or the cost assumptions) needs rethinking, not re-tuning.`;
  }
  const pos = analysis.keptPositive.map((k) => `\`${k.combo}\` (${R(k.netAvg)}/${k.n})`).join(", ");
  const walkNote = analysis.walkVerdict.status === "adopt"
    ? ` The walk-forward is out-of-sample sound (n ${analysis.walkVerdict.oosN}, net ${R(analysis.walkVerdict.exp)}), so the parameter change above is supported.`
    : ` The walk-forward is **not** yet out-of-sample sound (${walkReason(analysis.walkVerdict)}), so parameters stay at defaults.`;
  return `**Mixed.** With ≥ ${minT} trades, positive net expectancy held for: ${pos || "none"}.${analysis.disable.length ? ` Negative and proposed for disable: ${analysis.disable.map((d) => `\`${d.combo}\``).join(", ")}.` : ""}${walkNote} Treat this as one sample — confirm on fresher data before committing real risk.`;
}

// ---- main -----------------------------------------------------------------
function main() {
  const dir = process.argv[2];
  if (!dir) { console.error("usage: node analyze-results.js results/<timestamp>/"); process.exit(2); }
  let run;
  try { run = loadRun(path.resolve(dir)); } catch (e) { console.error(e.message); process.exit(2); }
  const analysis = analyze(run);
  const md = renderMarkdown(analysis, run);
  const outPath = path.join(path.resolve(dir), "VALIDATION.md");
  fs.writeFileSync(outPath, md);

  console.log(`Wrote ${outPath}\n`);
  console.log("PROPOSED js/config.js CHANGES (review — NOT applied):\n");
  console.log(proposedConfigDiff(analysis, run));
  console.log("\n" + bottomLine(analysis, run).replace(/\*\*/g, ""));
}

if (isRunDirectly()) main();
