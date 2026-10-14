# Terminal engine benchmark data

Raw `[terminal-bench]` records (`src/core/terminalBench.ts`), one JSON object per line, with the
run's `engine`, `scenario` and `label` added. The procedure is in `scripts/terminal-bench/README.md`.
The readiness review (`docs/reviews/styr-terminal-readiness.md`) summarises them.

## 2026-10-14-macos-arm64.jsonl

- Apple M4 Pro, macOS 26.6.2, Electron 44.5, Styr at `2ae5b65` (after the block-list fix in #157),
  styr-terminal 0.4.0, zsh. Production bundles, isolated `STYR_HOME`, fresh app start per run.
- Terminal size at the same window: xterm.js grid 119×35, Styr Terminal block list 113×47.
- `s1`: `cat` of a fixture; the label is the fixture and run (`burst-50m.txt#1`). Three fresh-start
  rounds, then `s1` with three runs in one session (`#1`–`#3` in a row) for memory growth.
- `s2`: 10 terminals, each `cat` of `burst-50m.txt` (`t1`–`t10`), then `after` (a `true` once all
  ten have drawn).
- `s5`: `idle10`, a `sleep 300` with 10 terminals open — xterm.js only. The run was stopped before
  Styr Terminal's S5, S4 (`top`), S3 (long session) and S6 (agent session).
