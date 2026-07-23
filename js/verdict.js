// ============================================================================
// verdict.js — pure keep/disable verdict for the backtest `--compare` tool.
//
// Given a setup's stats on two timeframes ({ n, netAvg }) and the minimum trade
// count required for a recommendation, returns a one-line verdict. Below the
// threshold on the relevant TF(s) the answer is always "insufficient data" —
// never a recommendation on a thin sample.
// ============================================================================

export function compareVerdict(a, b, tfA, tfB, minV) {
  const okA = a.n >= minV, okB = b.n >= minV;
  if (!okA && !okB) return `insufficient data (n=${a.n}/${b.n})`;
  const posA = okA && a.netAvg > 0, posB = okB && b.netAvg > 0;
  const negA = okA && a.netAvg <= 0, negB = okB && b.netAvg <= 0;
  if (posA && posB) return "keep both";
  if (posB && (negA || !okA)) return okA ? `keep ${tfB} only` : `keep ${tfB} only (${tfA} thin)`;
  if (posA && (negB || !okB)) return okB ? `keep ${tfA} only` : `keep ${tfA} only (${tfB} thin)`;
  if (negA && negB) return "disable both";
  return `insufficient data (n=${a.n}/${b.n})`; // one negative, the other thin
}
