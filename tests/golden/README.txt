Golden byte-parity fixtures + outputs for the backtest replay.

matrix.out / walk.out are the reference outputs; tests/golden.test.js re-runs
`backtest.js --matrix/--walk` on tests/golden/fixtures and diffs byte-for-byte
(path-normalized). Do NOT regenerate them to "fix" a diff — a diff means a real
behavior change; investigate it. They have been regenerated ONCE deliberately:

  1. replay-perf refactor (evaluateRaw/gateDecision split) — output UNCHANGED;
     goldens were the pre-refactor reference and the split reproduced them exactly.
  2. windowed replay (Stage 1) — output CHANGED ON PURPOSE toward live parity.
     The live scanner evaluates on a rolling window of the last WINDOW_BARS (200)
     candles (its kline cache); the backtest used to pass a growing prefix
     candles.slice(0,i+1), so a replayed bar saw far more history than live ever
     would. Every replay path now evaluates on candles.slice(max(0,i+1-W), i+1),
     W = CONFIG.replay.windowBars (== scanner.klineLimit). Setups/indicators/pivots
     are now computed over the same trailing window as live, so detection shifts
     slightly. Observed on these fixtures: Breakout & Retest 19 -> 21 trades,
     overall net R +0.90 -> +0.66; walk-forward fold selections unchanged (still
     "no selection" — the 800-candle fixture is too small to clear minTrainTrades).
     These matrix.out/walk.out were regenerated from the WINDOWED path and are the
     new reference.
  3. stop floor + stop-distance audit — trade STATS unchanged on these fixtures
     (their structure stops already exceed the floor, so 0/21 trades are floored
     and buildPlan produces identical levels). The regen is purely additive
     output: --matrix gains a STOP-DISTANCE AUDIT section and the corrected pooled
     header ("N pairs pooled · <candles>"); --walk's grid grows 24 -> 48 (the
     floor A/B dimension) and the chosen-params column gains floorK/M. Net R / PF /
     selections are byte-identical to (2) apart from those additions — confirmed by
     diff before regenerating.

fixtures: 5 pairs x 800 5m candles (+ resampled 15m/1h), deterministic
(mulberry32 seeded by symbol). Parity is size-independent, so 800 fully exercises
the replay paths within the sandbox time limit.
