# Safety nets: IPC contract, smoke and feature tests

Tests that catch the wiring breaking. Unit tests miss this kind of break: a dropped handler, a
renamed channel, a main process that throws at start-up.

## IPC contract (`src/main/ipcContract.test.ts`)

A plain vitest test, run by `yarn test`. It reads the source of `src/preload/index.ts` and of
everything under `src/main/`, `src/host/` and `src/core/`. It then checks that:

- every `ipcRenderer.invoke('…')` has exactly one `ipcMain.handle('…')`, and every handler has a
  caller;
- every `ipcRenderer.send('…')` has an `ipcMain.on('…')`, and the other way round;
- every `subscribe('…')` in the preload is sent somewhere in main (`broadcast(…)` or
  `webContents.send(…)`), and everything main sends has a subscriber.

The lists come from the source, so there is nothing to update when you add a channel. Add the
handler and the preload call together and the test stays green. The scan only sees string
literals, and a test fails when a channel is named any other way. Keep channel names literal at the
call site.

The shared channel table (`src/host/channelTable.ts`) is counted as handled by the contract test and
held to the server's by `src/server/channels.test.ts`, and the
smoke job also runs `styr serve`'s integration test under plain Node (see `remote.md`).

## Smoke test (`e2e/smoke.e2e.ts`)

Playwright's `_electron` drives the built app in `out/` (or the packaged app, below). It uses a throwaway `HOME`, `STYR_HOME`,
`--user-data-dir`, `ZDOTDIR` and `XDG_*`, so it never reads or writes your boards, settings, agents
or dotfiles. The app needs no test hook for this. One launch runs these steps in order:

0. The fresh profile is welcomed by the setup wizard; Skip setup, then Open board, closes it. (The
   feature tests' harness marks setup as seen with `styr.setup.seen`, so the wizard stays out of
   their way.)
1. The board renders, in a sandboxed renderer (the `Tab` process's `sandboxed` metric, on macOS
   and Windows) whose page has `window.api` and no `require` or `process`.
   1b. The MCP server named in the setup command exists on disk and starts under plain `node`.
2. Create a task, edit it, then move it to In Progress (status menu) and to In Review (drag). The
   file on disk follows each change.
3. A task file written from outside the app appears on the board.
4. A plain terminal runs `echo styr-smoke`, shows the output, and its tab closes.
5. A second workspace gets its own `TASK-0001`, and switching back shows the first board.
6. A status record written to `.styr/agents/` shows in the Agents sidebar as Working.
7. Settings opens, saves a change and its undo, and closes. The settings end up as they started.
8. Quit with a shell open. The app exits 0 and every process it started is gone.

Each step fails on a renderer `console.error`, an uncaught page error, the "externalized for
browser compatibility" blank window, or a failed IPC handler in the main process output. When a
step fails, the report gets the errors, the main process output and a screenshot. CI uploads
`test-results/` as an artifact.

### Running it

```sh
yarn test:smoke     # builds, then runs the smoke test (about 5 s after the build)
```

The test runs under Electron, so the native modules must be built for Electron's ABI. A normal
`yarn install` does that through `postinstall`. In CI the `smoke` job in `.github/workflows/ci.yml`
does the same on ubuntu-latest under `xvfb-run`. Linux adds `--no-sandbox`, because the runner
forbids the user namespaces that Chromium's sandbox needs.

### Running it against the packaged app

`STYR_APP_EXECUTABLE` names a packaged executable (the unpacked app in `dist/`); the smoke and
feature tests then launch it instead of `out/` (`appLaunch` in `e2e/harness.ts`), with the same
throwaway profile. The release jobs do this through `scripts/packaged-smoke.mjs` before they upload
(`releases.md`), so asar and `asarUnpack`, the rebuilt native modules and the signature are all
exercised. The step "the MCP server … is on disk" checks the MCP entry named by the setup command exists, sits under
`app.asar.unpacked` when packaged, and starts under plain `node`. The specs are the same ones; a
step must work in both modes, and `yarn playwright test` (no build) is the way to run it.

### macOS and Windows in CI

`smoke` (ubuntu) runs on every PR. The `changes` job diffs the PR against its base and, when it
touches `package.json`, `yarn.lock`, `electron-builder.yml`, `electron.vite.config.ts`, `scripts/`,
`build/`, `resources/` or `ci.yml`, `smoke-native` runs the same `yarn test:smoke` on macOS and
Windows too (a Dependabot bump of `electron` or a native module always qualifies; a docs-only PR
skips them). `smoke-native` is a separate job so `smoke` stays one stable required check
(`releases.md`); a skipped `smoke-native` is not a failure for branch protection, so do not
require it. Add a path to the `grep` in `changes` when a new file can break only on one OS.

### Adding a step

Add a `test.step` to the one `smoke` test, before the quit step, and end it with
`expectNoErrors()`. Some rules keep it stable:

- Find things by role and accessible name (`getByRole`, `getByLabel`), not by CSS classes. Labels
  that carry a shortcut differ by platform (⌘ or Ctrl), so match them with a prefix regex such as
  `/^Settings/`.
- Wait for state, never for time. Use `expect(…).toBeVisible()`, or `expect.poll` on a task file
  or on a `window.api` call. The one exception is the 100 ms after a card drag: dnd-kit swallows
  every click for 50 ms after a drop, which no person ever hits but a test does.
- Check the result on disk where there is one (the task file, `.styr/agents/`). The markdown is the
  source of truth, not the board.
- Leave the app usable for the next step. Close the dialogs you open.
- Keep it under the CI budget (about 2 minutes). A step that needs a real agent CLI or the network
  does not belong here.

## Feature tests (`e2e/features.e2e.ts`)

Playwright tests of the features behind the host layer, run by `yarn test:smoke` with the smoke
test and in the same CI job. They launch their own app through `e2e/harness.ts` (`launchStyr`: the
same throwaway HOME, error capture and failure attachments as the smoke test) and run in order on
it:

1. A worktree task with a commit shows `View changes: 2 files, +2 −0` on its card; the Changes
   dialog lists both files and shows a file's patch.
2. With the branch pushed to a bare `origin`'s `main` (a PR merged on the host), the palette's
   "Check for merged work" moves the task to Done, notes it in the file, and removes the worktree
   and the local branch.
3. "Show performance" opens the panel with the processes, the task-change timings and the counts.
4. With the Worklog on, a task file with a session (and no transcript) shows in the Worklog.
5. Quick setup (palette) opens titled "Quick setup", applies a Dispatch preset and a theme into the
   saved settings, and offers no rename for the Default workspace. Closing it early, after a choice
   and a confirm, saves nothing.
6. A REST source served by the test itself: the test request is refused with External sources off;
   with them on it reads the items, the preview writes nothing, and applying one item creates only
   that task.

`e2e/nativeTerminal.e2e.ts` runs a shell in a Styr Terminal tab in the same sandboxed window. The
engine is private, so it is skipped unless `STYR_TERMINAL_PATH` names a build of its package
(`terminal-engine.md`); run it locally with that set before changing the preload, the sandbox or
the CSP. `launchStyr(name, env)` takes extra environment for one launch only.

Nothing here needs an agent CLI, a GitHub login or the network: git runs with a fixed identity and
no user config (`git` in the harness), and the REST source is a local HTTP server. Keep it that
way — a feature that needs a provider belongs in a unit test with a fake port.

To add a test, add a `test(…)` to the file (they share one app, `mode: 'serial'`), or a new
`*.e2e.ts` file that calls `launchStyr` in `beforeAll`. End each test with `styr.expectNoErrors()`,
passing a pattern for a handler that is meant to fail. The rules under "Adding a step" apply.

Retries are off (`playwright.config.ts`). A flaky step is a bug in the step or in the app, so fix
it rather than retrying it.
