# Safety nets: IPC contract and smoke test

Two tests that catch the wiring breaking. Unit tests miss this kind of break: a dropped handler, a
renamed channel, a main process that throws at start-up.

## IPC contract (`src/main/ipcContract.test.ts`)

A plain vitest test, run by `yarn test`. It reads the source of `src/preload/index.ts` and of
everything under `src/main/` and `src/core/`. It then checks that:

- every `ipcRenderer.invoke('…')` has exactly one `ipcMain.handle('…')`, and every handler has a
  caller;
- every `ipcRenderer.send('…')` has an `ipcMain.on('…')`, and the other way round;
- every `subscribe('…')` in the preload is sent somewhere in main (`broadcast(…)` or
  `webContents.send(…)`), and everything main sends has a subscriber.

The lists come from the source, so there is nothing to update when you add a channel. Add the
handler and the preload call together and the test stays green. The scan only sees string
literals, and a test fails when a channel is named any other way. Keep channel names literal at the
call site.

## Smoke test (`e2e/smoke.e2e.ts`)

Playwright's `_electron` drives the built app in `out/`. It uses a throwaway `HOME`, `STYR_HOME`,
`--user-data-dir`, `ZDOTDIR` and `XDG_*`, so it never reads or writes your boards, settings, agents
or dotfiles. The app needs no test hook for this. One launch runs these steps in order:

1. The board renders.
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

Retries are off (`playwright.config.ts`). A flaky step is a bug in the step or in the app, so fix
it rather than retrying it.
