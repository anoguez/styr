# Terminal engine benchmark

How the numbers in `docs/reviews/styr-terminal-readiness.md` are measured, so they can be re-run on
a later engine version. It compares xterm.js and Styr Terminal inside the app, end to end: PTY →
engine → what is drawn. styr-terminal's own `bench/bench.mjs` measures the engine alone on the
same bytes.

## What gets recorded

Start an unpackaged build with `STYR_TERMINAL_BENCH=1` (a packaged app ignores it). Every shell
command then prints one line to the app's output when its output has been drawn:

```text
[terminal-bench] {"engine":"xterm","sessionId":"…","startAt":…,"endAt":…,"drawnAt":…,"totalMs":812,"lagMs":640,"processes":{"Browser":{"cpuPercent":…,"memoryMb":…},"Tab":{…},"GPU":{…}}}
```

- `totalMs`: from the shell's command `start` mark to the output being drawn. This is the number
  to compare. `lagMs`: how far drawing trailed the shell's `end` mark.
- "Drawn" means:
  - xterm.js: the paint after xterm has parsed the `end` mark.
  - Styr Terminal: the frame (or block-list update) sent to the renderer after the engine wrote
    the mark. It does not include the renderer painting one viewport.
- `processes`: CPU% per Electron process type **averaged over that command**, and its working set
  when the command is drawn. `Browser` is the main process, where Styr Terminal runs. `Tab` is the
  renderer, where xterm.js runs. Compare main + renderer.
- Timing needs the shell integration's marks: zsh, bash, fish and PowerShell all send them.
  Commands are not recorded, only their timing.

**Keep the Performance panel closed while measuring.** It reads the same CPU counters, which would
cut a command's CPU window short. Open it only for the memory checkpoints below.

## Setup

```sh
node scripts/terminal-bench/fixture.mjs    # writes burst-50m.txt and trickle-1m.txt to <tmp>/styr-terminal-bench
export STYR_HOME="$(mktemp -d)"            # an empty board and settings, so your own stay untouched

# xterm.js
STYR_TERMINAL_BENCH=1 STYR_EXPERIMENTAL_TERMINAL=0 yarn start | tee bench-xterm.log
# Styr Terminal
STYR_TERMINAL_BENCH=1 STYR_EXPERIMENTAL_TERMINAL=1 STYR_TERMINAL_PATH=<package> yarn start | tee bench-native.log

grep '^\[terminal-bench\]' bench-*.log
```

- **Use `yarn start`, not `yarn dev`.** `yarn start` (`electron-vite preview`) builds production
  bundles and runs them unpackaged, so `STYR_TERMINAL_BENCH` and `STYR_TERMINAL_PATH` still apply.
  `yarn dev` serves React's development build and Vite's unbundled modules. That slows the renderer
  and would skew the comparison, against xterm.js and against the native view's React rows alike.
- `STYR_EXPERIMENTAL_TERMINAL` picks the engine for the whole run, whatever Settings says. Settings
  → Experimental shows the engine and core version to record.
- `<package>` is the unpacked release tarball of the pinned version (`native-terminal.lock.json`).
  Check its binary against the release's `SHA256SUMS` first.
- In PowerShell, set each variable with `$env:NAME = 'value'` before `yarn start`, and pipe through
  `Tee-Object bench.log`. For `STYR_HOME`, use a new empty folder.
- Open a terminal with **+ Shell** in the terminal panel; the panel starts empty.
- **Leave the machine alone while a scenario runs**: no other work, no typing into other windows.
  Other load skews CPU and timing.

Every run uses: a fresh app start, a 120×40 panel (resize the window until the terminal reports
`tput cols; tput lines` = 120 and 40), the default scrollback, zsh on macOS and Linux, PowerShell
on Windows. Repeat each cell 3 times and report the median.

## Scenarios

| #   | Do                                                                                                | Read                                                                                     |
| --- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| S1  | grid session: `cat <tmp>/styr-terminal-bench/burst-50m.txt`                                       | `totalMs`, `lagMs`, CPU and memory of that record                                        |
| S1b | the same in the native block list (zsh, Styr Terminal only)                                       | the same, and whether memory stays flat over 3 runs in one session (finished-block caps) |
| S2  | 10 terminals, each runs `cat` of the burst once (past its scrollback cap)                         | memory of the last record; for Styr Terminal, the `Browser` share                        |
| S3  | one terminal: `for i in {1..60}; do cat <tmp>/styr-terminal-bench/trickle-1m.txt; sleep 60; done` | Performance panel memory at 0, 30 and 60 min; growth from 30 to 60 min must be under 5%  |
| S4  | `htop` for 10 min, then quit it                                                                   | the record for the `htop` command: average CPU over the 10 minutes                       |
| S5  | 10 idle terminals for 5 min: run `sleep 300` in one of them                                       | CPU of the `sleep` record                                                                |
| S6  | a real `claude` task session for an hour or more                                                  | Performance panel memory at start and end, and any `[terminal-engine]` fallback line     |

The PowerShell equivalents are:

- `cat`: `Get-Content -Raw <file>`
- the S3 loop: `1..60 | % { Get-Content -Raw <file>; Start-Sleep 60 }`
- `sleep 300`: `Start-Sleep 300`
- `htop`: not available on Windows; S4 runs on macOS only

Record each target's engine and core version (Settings → Experimental shows them), the Electron
version, the OS version and the machine.
