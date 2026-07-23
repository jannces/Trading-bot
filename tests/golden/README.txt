Golden byte-parity fixtures + outputs for the backtest replay.

matrix.out / walk.out were generated from the PRE-refactor code (per-bar
evaluate(), no precompute) — they are the reference the replay-perf refactor must
reproduce EXACTLY. tests/golden.test.js re-runs `backtest.js --matrix/--walk` on
tests/golden/fixtures and diffs against them (path-normalized).

fixtures: 5 pairs x 800 5m candles (+ resampled 15m/1h), deterministic
(mulberry32 seeded by symbol). 800 was chosen so the pre-refactor
O(bars x combos x folds) code could regenerate the goldens inside the sandbox
time limit; parity is size-independent, so it still fully exercises the refactor.
Do NOT regenerate the .out files to "fix" a diff — a diff means a real behavior
change; investigate it.
