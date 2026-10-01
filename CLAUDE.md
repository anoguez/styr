# Styr — working notes

Electron + React kanban board. See README.md for what it does and how to run it.

## Architecture rules

- `src/core/` is the shared, Electron-free layer: types, zod schemas, config, markdown
  serialisation, the filesystem task store and the prompt builder. Both the main process and the MCP
  server import it. **Never import `electron` from `src/core/`** — it would break the MCP server.
- Markdown files under `<workspace>/tasks/` are the only source of truth. All writes go through
  `src/core/taskStore.ts`.
- `src/main/taskIndex.ts` is a derived SQLite cache, written only by the main process. It must stay
  reconstructible from the markdown alone — never store anything there that is not in a file. When
  you change its columns, bump `SCHEMA_VERSION`; the index drops and rebuilds itself from the task
  files, so no migration code is needed.
- The main process serves renderer reads from the index (`queryTasks`, `findTask`) and routes writes
  through `taskStore`, then calls `notifyTasksChanged()` to re-index and broadcast.
- External writes (the MCP server, an editor, a `git pull`) are picked up by the chokidar watcher in
  `src/main/watcher.ts`, which runs the same `notifyTasksChanged()`.

## Worktrees

`src/core/worktree.ts` wraps git. `ensureWorktree` is idempotent so a resume lands in the same
checkout. Worktrees are created beside the repo (`<repo>.worktrees/<taskId>`) — inside it they would
show as untracked files in the user's project.

Worktree failure is never fatal: `workspaceFor` in `launch.ts` falls back to the plain repository
and returns a `warning`, which `ipc.ts` writes to the task activity log. A blocked launch would be
worse than a shared working directory.

`WORKTREE_BRANCH_PREFIX` lives in `types.ts` because `prompt.ts` needs it too, and `prompt.ts` is
imported by the renderer — it must not reach for `worktree.ts`, which uses `node:child_process`.

## Agent providers

Everything that differs between agent CLIs sits behind `AgentProvider` in `src/core/providers/`.
`launch.ts` owns the shared flow — worktree, prompt file, the resume-or-start decision — and asks the
provider only for what it cannot know: the command line, whether a session still exists on disk, when
it was last written, and how to register the MCP server. Claude Code (`providers/claude.ts`) is the
only provider so far. `providerFor` in `providers/index.ts` is the one place a provider is chosen;
callers must never branch on the provider themselves.

Status records are provider-neutral: whatever a CLI's hooks look like, they write
`{taskId, event, at, payload}` into `agentsDir`, with `event` drawn from `EVENT_STATE` (whose names
come from Claude Code). A provider that has no hooks still gets `TerminalExit`.

`sessionEnvKeys` lists the environment variables a CLI uses to mark its own session.
`withoutSessionMarkers` strips every provider's list from each terminal `ptyManager` opens. Without
it, Styr started from inside Claude Code (`yarn dev` in a Claude Code terminal) passes those markers
on, every agent it launches believes it is a child session and turns transcript saving off, and
resume then silently starts a fresh chat. List session markers only — `CLAUDE_CODE_*` settings a user
exports on purpose must still reach the agents.

`Settings.claudeCommand` and `Settings.codexCommand` are per-provider by nature. Task provider state
is `Task.agentSession` (the live pointer) plus `Task.sessions` (history, every entry tagged with a
provider). `claudeSessionId` no longer exists in memory: `core/migrateTask.ts` rewrites it, and
untagged history, on read — before validation, in `parseTaskMarkdown` and the JSON reader.

### Codex

Codex's TUI runs against the shared app-server daemon (`codex --remote unix:// --cd <cwd>`; `--cd`
is mandatory there, the daemon picks a new thread's directory), so its thread is observable. The
daemon broadcasts `thread/started` and `thread/status/changed` for every thread to every connected
client. `main/codexMonitor.ts` is one read-only listener that turns those into the hook-style
events `EVENT_STATE` already knows (active → working, active + `waitingOn*` flag → waiting, idle →
finished, started → ready). The pure half — version policy, mapping, `ThreadBindings`, WebSocket
framing — is in `core/providers/codexProtocol.ts` and is what the tests cover.

A fresh launch cannot know its thread id (the TUI creates it): `ThreadBindings.expect` claims the
first non-ephemeral thread to start in that cwd, and the monitor saves the id as the session.
Resumes bind the stored id up front. `prepareCodex` runs before anything is written and refuses the
launch (CLI < 0.159.3, daemon missing/older) with an error naming the fix. The control socket
speaks WebSocket, not raw JSON lines, so `codex app-server proxy` is of no use as a transport.

The MCP install command for Codex sets `STYR_MCP_AUTHOR=codex` so board notes are attributed.

## Launching Claude

`src/core/launch.ts` builds the command. It lives in core, not `main/`, because it needs no Electron
and is the piece most worth testing directly.

First launch generates a UUID and passes `--session-id`; later launches pass `--resume`. The choice
is made by looking for `~/.claude/projects/*/<session-id>.jsonl` (`providers/claude.ts`), never by
trusting the stored id alone — a user who cleared their Claude history must get a fresh start rather
than a failed resume. Matching on the exact filename avoids depending on how Claude Code encodes the
project directory name.

`planLaunch` takes an optional `homeRoot` purely so tests can point it at a fixture directory.

`terminal:launchAgent` returns an existing session (via `findSessionByTask`) before it plans
anything, so a second launch focuses the open tab instead of spawning a rival agent on the same
task. The renderer dedupes by session id in `adoptSession`, so the same handler covers both cases.

## Menu bar

`src/main/tray.ts` mirrors agent state into the macOS menu bar, dock badge and notifications.
`notifyAgentsChanged` in `ipc.ts` is the single update point.

The icon is inlined as base64 in the generated `src/main/trayIcon.ts` rather than shipped as a file,
so there is no dev-versus-packaged path to get wrong — the asar path bugs earlier in this project
were exactly that. Regenerate it with `yarn icon`; it is a template image, so macOS inverts it for
light and dark menu bars automatically.

The menu is capped at `MENU_LIMIT` and sorted with `compareAgentStatus` from `core/agentState.ts` —
the same comparator the sidebar uses, so a waiting agent is never buried behind finished ones in
either place. Keep the ordering rule in core; it is shared by the main process and the renderer.

Clicking a menu entry broadcasts `tasks:activate`, which the renderer routes to the same
`activateTask` the sidebar rows use — focus the live terminal tab, or resume the chat when there is
none. Keeping one definition of "activate a task" means the menu bar and the sidebar can never drift
apart.

`newlyWaiting` is exported and pure so the notify-once-per-transition rule can be tested without an
Electron runtime.

## Board layout

Cards are `shrink-0`. A column body is a flex column, and flex children shrink by default, so
without it a shorter board squeezes the cards and clips their content instead of scrolling the
column.

The card meta row keeps the id and counters `shrink-0 whitespace-nowrap`, and lets only the agent
label truncate. The agent state dot is also `shrink-0` — colour carries the state, so it has to
survive when the label does not.

## Settings

`SettingsDialog` is a nav plus one pane per section, driven by the `SECTIONS` array — add a section
there and to the `section === '…'` blocks rather than lengthening a single scroll. `Modal` takes
`flush` to hand its padding and scrolling to a child that manages its own panes.

The pane height is fixed (`h-[min(560px,68vh)]`) so switching sections does not resize the dialog.

## Terminal tabs

The terminal is a sibling of the board inside the left column of the main row, not a sibling of that
row — that is what keeps the agents sidebar full height. Expanding hides the board with `hidden`
rather than unmounting it, so column scroll positions survive.

The tab strip is a `SortableContext` using the same dnd-kit setup as the board. Tab order lives in
`App`'s `sessions` state; reordering that array does not remount `TerminalView`, because each is
keyed by session id — remounting would destroy the xterm instance and its scrollback.

Tab labels come from `sessionLabel` in `renderer/src/lib/sessionLabel.ts`, shared with the command
palette's Terminals group. A task tab shows the task's _current_ title from the board, so a rename
(a spec run often retitles a task) updates the tab, with the task id as a secondary label. The board
is filtered by search, so the title recorded on the session at launch is the fallback — never print
`session.title` directly for a task session. `replay` marks a read-back of a past chat so it can be
told apart from the live tab of the same task.

The active tab scrolls itself into view. Title-width tabs overflow the strip quickly, and a tab
focused from the sidebar or the palette would otherwise be activated off-screen.

Tab dots use `AGENT_TONE` from `renderer/src/lib/agentTone.ts`, shared with the cards and the agents
sidebar. Active is shown by the underline, never by dot colour, so the two meanings never collide.

## Theme

`Field` renders a `div`, never a `label`. A label activates the first control inside it, so a Field
holding several controls (or any button) fires the wrong one on a click anywhere in the group — that
is what made clicking the settings pane open a colour picker.

`useTheme` takes a `ThemeSettings` and writes it onto the document's CSS custom properties. `App`
calls it with `previewTheme ?? settings.theme`, and `SettingsDialog` pushes its draft up through
`onPreviewTheme` — so editing repaints the live app, and closing without saving restores the saved
theme by clearing the preview. Do not point `useTheme` back at the saved settings: that is what made
the theme invisible until save.

Every dropdown is `Select` from `ui.tsx`, never a bare `<select>`. macOS draws the native chevron
flush against the right edge, so `Select` hides it (`appearance-none`) and overlays an SVG chevron
in `text-dim`. It stays a real `<select>`, so the native option menu and keyboard handling are
untouched. A CSS-only fix was tried: gradient tricks can only draw a filled triangle, and an SVG
background image needs a hardcoded colour, which breaks theming.

`ColorInput` is a hand-rolled popover, not `<input type="color">`. The native control opens the
macOS colour panel, which the page cannot dismiss. Tailwind v4 compiles
`bg-accent` to `var(--color-accent)`, so overriding the variable at runtime repaints everything that
uses it — which is why no component should hardcode a colour literal. `Chip`'s warn tone was such a
literal and is now `var(--color-col-review)`.

`renderer/src/lib/palette.ts` derives the surface ramp from the base colour. The lightness ladder is
fixed and measured from the original hand-picked palette — the base only supplies hue, saturation
and a clamped lightness shift, which is why no choice of base can destroy contrast. The ladder was
checked against the original hand-picked palette (worst channel distance 9 of 441) before the
default base moved to `#0d2233`.

The static values in `index.css`'s `@theme` block are only the first paint, before settings load.
They are the ramp `DEFAULT_THEME.base` produces — regenerate them when that base changes, or the
window flashes the old palette on every launch.

Surface translucency and blur were tried and removed. The app's surfaces sit directly on the window
background, so translucency revealed nothing outside of dialogs; making it meaningful needs
`transparent: true` plus `vibrancy`, which risks the traffic lights under `titleBarStyle:
'hiddenInset'`. The window is deliberately opaque. Do not reintroduce either without being able to
see the result on a real window.

Old configs may still carry `surfaceOpacity`/`surfaceBlur`; zod strips unknown keys, so they load
and the fields disappear on the next save.

`DEFAULT_THEME` lives in `core/types.ts`, not `config.ts`, because the Settings dialog needs it for
its reset button and cannot import the node-only config module.

The terminal font **and colours** are applied to live xterm instances in an effect, not by recreating
the terminal — recreating would lose scrollback. `TerminalView` takes the whole `ThemeSettings`
rather than individual props, so adding a theme field needs no new prop through `TerminalPanel`.

`terminalTheme` in `palette.ts` builds xterm's theme: chrome (background, foreground, cursor,
selection) derived from the same ramp as the app, and the 16 ANSI slots passed through as stored.
The ANSI slots cannot be derived — red has to stay red, or a program's output stops meaning what it
said — which is why `terminalPalette` is stored outright while everything else follows the base.

Note what `theme.background` does and does not do: xterm's DOM renderer (the one in use — no WebGL
addon is loaded) leaves default-background cells transparent, so the colour you actually see is the
panel's `bg-chrome` behind it. Setting it keeps the two in step and feeds xterm's own contrast
maths; it is not what paints the panel. A hardcoded background sat there for a long time doing
almost nothing, which is why nobody noticed it was from the old palette.

## Title bar

The window uses `titleBarStyle: 'hiddenInset'` with `trafficLightPosition` set to centre the lights
in a 44px row, and the header pads left by 86px to clear them. Changing the header height means
re-centring the lights — `y` is `(height / 2) - 7`.

The browser harness has no traffic lights, so that left gap looks empty there. Alignment can only be
judged in the real app.

`-webkit-app-region: no-drag` goes on the controls themselves, never on a layout wrapper around
them. A wrapper that opts out turns its empty space into a dead zone, which kills macOS's
double-click-to-zoom on that part of the title bar.

## Status bar

`StatusBar` owns the panel toggles and Settings. Its icons are inline SVG rather than text glyphs —
symbol characters like ⚙ render at wildly different weights across fonts and were nearly invisible
at 11px.

The terminal opens at `TERMINAL_OPEN_RATIO` of the window height, but `manuallyResized` in `App`
latches on the first drag so a user's chosen height is never reset by a later toggle.

## Shortcuts

`src/core/shortcuts.ts` is the single source of truth for what key does what. Before it, the same
knowledge lived in four places that had to agree by hand — the keydown chain in `App`, the list in
`isAppShortcut`, the `⌘N`-style labels in the UI, and the README table. Binding a key and forgetting
`isAppShortcut` produced a shortcut that worked everywhere _except_ when the terminal had focus,
while also leaking a byte to the shell. Nothing may reintroduce a second list:

- `SHORTCUT_COMMANDS` in `types.ts` is the command set. `App.runCommand` switches on it exhaustively,
  so adding a command is a compile error until it is handled.
- The palette's Actions group is generated from the same list, so a new command is reachable by name
  without being bound to anything.
- Every `⌘…` label comes from `shortcutHint`. No component types an accelerator as a string literal.
- `isAppShortcut` takes the bindings and asks `commandForEvent`, so the terminal's pass-through list
  cannot drift from what the app actually claims.

Core is compiled without the DOM lib, so `ShortcutKeyEvent` is spelled out rather than picked from
`KeyboardEvent`; the renderer's `ModifierKeyEvent` extends it with `type`.

`SHORTCUT_SCOPES` says where each binding applies. A `terminal` command answers only while an
embedded terminal has focus (⌘T, New terminal tab), so its key stays free elsewhere. `commandForEvent`
takes a required `ShortcutContext` for this — required so no caller can forget scope exists. `App`
derives it with `isTerminalTarget`: inside `.xterm` (xterm types into a hidden textarea there) or
anywhere in the terminal panel, whose root is focusable (`tabIndex={-1}`, `data-terminal-panel`) so
the empty state counts — without that, ⌘T could not open the first tab. `isAppShortcut` always passes `terminalFocused: true`. Scope gates only the key; the palette runs
every command from anywhere.

A binding is a list, not a string, because the terminal panel answers to both ``⌃` `` and ``⌘` ``,
and because unbinding is then an empty list rather than a sentinel. `RESERVED` cannot be bound —
binding `⌃C` would remove the only way to interrupt a program in the panel, from inside the panel.

`TerminalView` reads bindings through a ref rather than a dependency, so a rebind does not remount
xterm and discard its scrollback.

Conflicts are warned about, never refused: refusing would force a user to unbind one command before
giving its key to another. `commandForEvent` resolves a clash by `SHORTCUT_COMMANDS` order.

## Terminal keys

A terminal sends a bare CR for both Enter and Shift+Enter, so Claude Code cannot tell them apart.
`/terminal-setup` works around this by binding Shift+Enter to send ESC + CR (`\u001b\r`), and
`src/renderer/src/lib/terminalKeys.ts` emits the same sequence from the embedded terminal via
`attachCustomKeyEventHandler`. Keep that logic as a pure function — it is the part worth testing,
and testing it should not require a DOM or an xterm instance.

`isAppShortcut` now derives from the user's bindings — see **Shortcuts** above. It must never grow
a key list of its own again.

## Agent state

Split across two files on purpose:

- **`src/core/agentState.ts` is pure** — types, labels, and the event→state map. The renderer imports
  this. It must never import `node:*`.
- **`src/core/agentStore.ts` is node-only** — filesystem reads and writes of status records. Only
  the main process and core's launch/provider modules import it. Hook-command generation is
  provider-specific and lives in `providers/claude.ts`.

Vite replaces `node:*` in renderer code with a stub that throws at runtime, so this mistake ships as
a blank window rather than a build error. `scripts/build.mjs` wraps the build and fails it on Vite's
"has been externalized for browser compatibility" warning; `yarn build` runs it.

Launches register Claude Code hooks via `--settings` (documented as
loading _additional_ settings, so the user's own hooks survive). Hooks write
`<workspace>/.styr/agents/<taskId>.json`; a chokidar watcher re-reads and broadcasts.

`SessionStart` maps to `ready`, never `working` — a resume fires it with no turn in flight, and
calling that "Working" is a lie the user will notice immediately. `PreToolUse` is registered purely
so state recovers from `waiting` once a permission prompt is answered; without it a session stays
pinned at the top of the sidebar as waiting for the rest of its turn.

The hook command is deliberately plain POSIX shell: it wraps the hook's stdin payload verbatim as a
`payload` field and lets the app parse it. That keeps `node`/`jq` off the dependency list and means
new payload fields need no hook changes. It writes to a temp file then renames, so the watcher never
reads a partial file, and falls back to `null` when stdin is empty.

`src/main/watcher.ts` runs two independent watchers (tasks, agents). Its `close` helper clears the
handle **synchronously** before awaiting the close — an async teardown that nulls its handle after
the await will tear down a replacement watcher started in between, which silently killed the agents
watcher while leaving the tasks watcher running.

`agentStatuses` in `ipc.ts` tags each record with `branch`, read by `readGitBranch` from
`.git/HEAD` — no subprocess, so it is safe to call on every agent refresh, including the frequent
`PreToolUse` events. It resolves the `gitdir:` pointer file that a worktree uses instead of a
`.git` directory.

`isAgentArchived` in `core/agentState.ts` decides what drops out of the agent lists: Done, full
stop. It deliberately ignores agent state — a finished session leaves a `Notification` behind while
it idles at a prompt, so a state-aware rule leaves completed work reading _Waiting on you_. The
sidebar, the tray and the status-bar counts all derive from the same filtered rows; counting from
the raw agent map instead is how the badge kept showing archived agents.

Terminal exits are written to the agent file (`TerminalExit`) rather than held in memory, so a dead
session does not come back as whatever it was doing when the app last closed.

`AgentsSidebar` lists any task that has an agent status _or_ a `claudeSessionId`, so a chat you can
resume is visible even before its first hook fires. `sortAgentRows` ranks waiting first.

`markAgentExited` in `ipc.ts` records a locally observed terminal exit, and only wins over a hook
record if its timestamp is newer (compared as parsed dates — the hook writes second precision and
this writes milliseconds, so a string compare gets it backwards) — a hook write always beats a stale override.

## Orchestration

`orchestrate:run` takes the task ids the confirmation dialog showed and intersects them with a
fresh plan, so what starts is what the user agreed to even if the board changed while the dialog was
open.

`src/core/orchestrate.ts` is a pure planner: given settings, tasks and the set of task ids holding a
live session, it returns what to start. All the selection rules live there so they can be tested
without launching anything; `ipc.ts` only performs the launches.

`laneFor` mirrors `resolveTemplateFor` — readiness outranks status — so a task's lane always matches
the template it will actually run. Change one and change the other.

Only Backlog and In Review are dispatchable. In Progress is deliberately excluded: a dead session
there does not mean the work is free to restart.

`Task.sessions` is the append-only chat history; `Task.claudeSessionId` is which of them the next
run continues. They look redundant but are not — Forget clears the pointer while keeping the
history, and a fresh review appends without discarding the implementer's chat.

`planLaunch` also takes `resume` to reopen one specific past chat, bare, for reading back.

`planLaunch` takes `withPrompt` and `fresh`. Orchestrate sets `withPrompt` always — `--resume`
alone submits nothing, so a dispatched run would start an agent with no instruction — and `fresh`
for the review lane so the reviewer is not the session that wrote the code. The manual Resume button
passes neither.

The shipped review template's id is `code-review`, not `review`, because an early config shipped a
user-owned `review` template; an id collision silently shadows the shipped one and a reviewer then
gets no instruction on how to record its verdict.

`launchSessionForTask` in `ipc.ts` is shared by the per-task launch and the orchestrator, so both
advance the board and record the session identically.

## Prompt routing

`src/core/prompt.ts` picks which template runs, in this order:

1. an explicit override passed to the launch call,
2. `task.promptTemplateId` (the task pinned one),
3. `settings.promptRouting` — `needsSpec` if `readiness === 'needs_spec'`, otherwise
   `byStatus[task.status]`,
4. `settings.defaultPromptTemplateId`, then the first template, then a hardcoded fallback.

`terminal:launchClaude` moves a Backlog task to In Progress itself rather than trusting the agent
to do it — the board should reflect that work started even if the session never writes the file.
Only Backlog advances; In Review is a review and Done is a follow-up.

Readiness deliberately outranks status, so unspecified work is specced before it is built. Steps 4+
exist because routing entries can point at templates the user has since deleted — resolution must
never throw.

`buildPrompt` renders two sections — `contextFiles` and `board` — that are appended when the
template does not place them with a placeholder. Both are guarantees rather than conveniences: a
template that omits the board protocol produces an agent that finishes work and leaves the task in
the wrong column, and stored templates are user data that older configs still carry.

`resolveTemplateFor` takes `TemplateRouteInput` (status + readiness + optional pin), not a full
`Task`, so the renderer can resolve against unsaved form state. It is shared by the main process and
the renderer — keep it free of Node imports.

## Hand-edited task files

Task markdown is edited by humans and by Claude sessions, not just by this app. Two rules protect it:

- `parseTaskMarkdown` normalises `status`, `priority` and `readiness` (lowercase, spaces and hyphens
  to underscores) before validation, so `In Review` parses. Normalisation happens in `markdown.ts`,
  never in the zod schemas — programmatic callers (IPC, MCP) stay strict.
- `readTaskAtPath` only adopts a file that has **no** frontmatter. A file that has frontmatter but
  fails validation is recorded in `brokenTaskFiles()` and skipped, never rewritten. Rewriting it
  would destroy the very fields that failed to parse.

`parseActivity` keeps any `- ` bullet it cannot parse as an entry with empty `at`/`author`, and
`renderActivity` writes those back bare. That is what makes a hand-written note survive a later
programmatic write.

## Command palette

`CommandPalette.tsx` renders a flat, pre-ranked list; `App.tsx` owns the entries. Every entry is a
`CommandEntry` with a `run`, so the palette never knows what an action does — adding a destination
means pushing one more entry into the `commandEntries` memo, not touching the component.

`lib/fuzzy.ts` is pure and testable: `fuzzyScore` returns `null` for a non-match, so filtering and
ranking are the same pass. Scores favour prefixes and word boundaries over scattered matches.

Settings entries work because `SettingsDialog` exports `SECTIONS` and takes `initialSection` — the
palette lists the real sections rather than a parallel list that would drift.

`⌘P`/`⌘K` are in `isAppShortcut` (`lib/terminalKeys.ts`), or the embedded terminal would swallow
them and send them to the shell.

## Types

`src/core/types.ts` holds every domain type; `src/core/taskSchema.ts` holds the zod schemas that
validate anything crossing a process boundary. Extend these rather than declaring new shapes — the
renderer, preload, IPC layer and MCP server all share them.

## Build specifics

- electron-vite v5 emits ESM (`.mjs`). `package.json#main`, the preload path in
  `src/main/index.ts` and the MCP path in `src/main/ipc.ts` all reference `.mjs` — keep them in sync
  if entry points move.
- `electron`, `better-sqlite3` and `node-pty` are externalised in `electron.vite.config.ts`. Both
  native modules are compiled against Electron's ABI by `electron-builder install-app-deps`, so the
  MCP server (plain `node`) must never import them.
- After changing dependencies, re-run `yarn postinstall` to rebuild the native modules.
- `out/main/**` is in `asarUnpack`. The MCP server is launched by plain `node`, which cannot read
  inside an asar archive, so `app:mcpCommand` resolves it under `app.asar.unpacked` when packaged.
  Anything else that must be run by a non-Electron process needs the same treatment.
- Anything that builds a shell command from a path must run it through `shellQuote`.
  `app:mcpCommand` is copy-pasted by the user into a terminal, and a path with a space (an
  install location, a home folder) silently splits into two arguments without it.
- `resources/icon.svg` is the icon source of truth; `resources/icon.icns` is derived by
  `yarn icon`. Never hand-edit the `.icns`.
- Releases are signed with the Developer ID and notarised: electron-builder finds the identity in
  the keychain locally or decodes `CSC_LINK` on CI, and notarises whenever the `APPLE_*` variables
  are set. `yarn package:adhoc` (`mac.identity` `"-"`) is the fallback without a certificate. Never
  set `mac.identity` to `null`: that skips signing entirely, leaving the bundle's resources unsealed,
  and macOS then reports the app as _damaged_ with no right-click-to-open escape.
- The entitlements file is mandatory: the hardened runtime enforces library validation, which
  blocks `node-pty` and `better-sqlite3` under an ad-hoc signature.

## Updates

`src/main/updater.ts` wraps electron-updater against this repo's GitHub Releases and mirrors its
`UpdateState` to the renderer (`updates:*` IPC, `useUpdates`). It downloads automatically but never
installs on its own: `autoInstallOnAppQuit` applies it at the next quit, and `updates:install`
relaunches only after asking whenever a terminal is open, because a relaunch kills every agent
running in the app. Keep it that way — an app that restarts itself mid-turn loses work.

A dev build reports `unsupported` and never checks. A release without `latest-mac.yml` (published
by hand, or older than the updater) is reported as current, not as an error.

electron-updater defines `autoUpdater` through a getter, which Node's ESM loader cannot see as a
named export, so it is imported as the default export.

## Releases

`.github/workflows/release.yml` runs release-please on every push to `main`. It keeps a release PR
open that bumps `package.json` and writes `CHANGELOG.md` from conventional commits; merging it tags
the release as a **draft** (`draft` + `force-tag-creation` in `release-please-config.json`), and a
macOS job then builds, signs, notarises, verifies, attaches the files and only then publishes it.
Never publish before the files are attached: a public release without `latest-mac.yml` is one the
updater sees but cannot install. Commit
messages must therefore be conventional (`feat:`, `fix:`, `docs:` …) or they are left out of the
changelog. `scripts/setup-signing-secrets.sh <p12>` sets the five signing secrets on the repo from a
`.p12` exported in Keychain Access — never from `security export`, which cannot reach the
data-protection keychain where the Developer ID key lives and silently exports other identities.

The release job imports the certificate into its own keychain together with Apple's Developer ID
intermediates (fingerprint-pinned), passes the Developer ID identity by name as `CSC_NAME`, and fails
at import if there is none. Each of those fixed a real failure: electron-builder's own temporary
keychain cannot set its partition list on the runners, and without a named identity it signs with
any other identity in the `.p12`, which notarisation then rejects.

Before 1.0, `feat` bumps the minor version and everything else the patch.

## Checks

```sh
yarn lint           # ESLint
yarn format:check   # Prettier
yarn build          # typechecks tsconfig.node.json + tsconfig.web.json, then builds
```

CI runs all three on every PR. The pre-commit hook runs lint-staged (ESLint and Prettier on staged
files) and the typecheck.

TypeScript 7 (`@typescript/native`) is the compiler; the `typescript` package name is the TS 6
compatibility build (`@typescript/typescript6`), because typescript-eslint needs the compiler API
that TS 7 no longer ships.
