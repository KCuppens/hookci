## ZeroCI run stats

Window: 2026-03-01T00:00:00Z to 2026-03-15T00:00:00Z (14.0 days).

Baseline: check 512 s, deploy 530 s per run, billed per started minute at $0.008 per minute.

| Kind | Runs | Succeeded | Success rate | Median | p90 | Baseline | Minutes saved | Saved per run | Saved total |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| check | 5 | 4 | 80.0% | 95.0 s | 120.0 s | 512 s | 45 | $0.0720 | $0.36 |
| deploy | 3 | 2 | 66.7% | 50.0 s | 55.0 s | 530 s | 27 | $0.0720 | $0.22 |

Saved in the window: $0.58. Monthly projection: $1.23 (saved / window days x 30).

Durations are the agent's recorded start to finish times; hub queue time is excluded. Median and p90 count successful runs only; minutes and dollars saved count every finished run.
