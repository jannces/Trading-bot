// ============================================================================
// verify-manifest.js — sanity-check a fetch-data.js snapshot before you trust it.
//
//   node verify-manifest.js ./data
//
// Reads <dir>/manifest.json AND the per-pair files, and reports:
//   - requested vs received per pair/TF (flags any series < completeThreshold)
//   - continuity gaps recorded by the deep fetch
//   - the actual date range + candle counts loaded from disk (provenance)
// Exit code is non-zero if any series errored, came back short, or has gaps, so
// it can gate a script. Nothing here fetches or synthesizes data.
// ============================================================================
import fs from "node:fs";
import path from "node:path";

const COMPLETE = 0.95; // received/requested below this is "short"

export function verifyManifest(dir) {
  const manPath = path.join(dir, "manifest.json");
  if (!fs.existsSync(manPath)) throw new Error(`no manifest.json in ${dir} — run fetch-data.js first`);
  const man = JSON.parse(fs.readFileSync(manPath, "utf8"));
  const pairs = Object.keys(man.perPair || {});
  const issues = [];
  const provenance = []; // { sym, tf, count, from, to }

  for (const sym of pairs) {
    const rec = man.perPair[sym];
    // Load the actual file to report true counts + date range from disk.
    let obj = null;
    try { obj = JSON.parse(fs.readFileSync(path.join(dir, `${sym}.json`), "utf8")); } catch { /* missing */ }
    for (const [tf, r] of Object.entries(rec)) {
      const ratio = r.requested ? r.received / r.requested : 0;
      if (r.error) issues.push(`${sym} ${tf}: ERROR ${r.error}`);
      else if (ratio < COMPLETE) issues.push(`${sym} ${tf}: short — received ${r.received}/${r.requested} (${(ratio * 100).toFixed(1)}%)`);
      if (r.gaps > 0) issues.push(`${sym} ${tf}: ${r.gaps} continuity gap(s)`);

      const arr = obj && Array.isArray(obj[tf]) ? obj[tf] : null;
      if (arr && arr.length) {
        const t0 = arr[0].time ?? (Array.isArray(arr[0]) ? arr[0][0] : null);
        const t1 = arr[arr.length - 1].time ?? (Array.isArray(arr[arr.length - 1]) ? arr[arr.length - 1][0] : null);
        provenance.push({ sym, tf, count: arr.length, from: t0, to: t1 });
      }
    }
  }
  return { man, pairs, issues, provenance };
}

function fmtDate(ms) { return Number.isFinite(ms) ? new Date(ms).toISOString().replace("T", " ").slice(0, 16) + "Z" : "?"; }

function main() {
  const dir = process.argv[2] || "./data";
  let res;
  try { res = verifyManifest(dir); } catch (e) { console.error(e.message); process.exit(2); }
  const { man, pairs, issues, provenance } = res;

  console.log(`Manifest: ${dir}/manifest.json`);
  console.log(`  source ${man.source} · fetched ${man.fetchedAt} · primary ${man.primaryTf} · target ${man.target} · TFs ${(man.tfs || []).join("/")}`);
  console.log(`  pairs: ${pairs.length}`);

  // Provenance table (from files on disk).
  console.log(`\nLOADED SERIES (from disk)`);
  console.log("  " + "pair".padEnd(12) + "tf".padEnd(5) + "candles".padEnd(9) + "from".padEnd(19) + "to");
  console.log("  " + "-".repeat(60));
  for (const p of provenance) {
    console.log("  " + p.sym.padEnd(12) + p.tf.padEnd(5) + String(p.count).padEnd(9) + fmtDate(p.from).padEnd(19) + fmtDate(p.to));
  }

  if (issues.length) {
    console.log(`\n⚠ ${issues.length} issue(s):`);
    for (const s of issues) console.log(`   - ${s}`);
    console.log(`\nThese series are incomplete. You can still validate, but treat thin/gapped pairs with skepticism.`);
    process.exit(1);
  }
  console.log(`\n✓ All ${provenance.length} series complete (≥ ${(COMPLETE * 100).toFixed(0)}% received, 0 gaps).`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
