# Styr — working notes

Electron + React kanban board. See README.md for what it does and how to run it.

## Architecture rules

- `src/core/` is the shared, Electron-free layer: types, zod schemas, config, markdown
  serialisation, the filesystem task store and the prompt builder. Both the main process and the MCP
  server import it. **Never import `electron` from `src/core/`** — it would break the MCP server.
- Markdown files under `<workspace folder>/tasks/` are the only source of truth. All writes go through
  `src/core/taskStore.ts`.
- `src/main/taskIndex.ts` is a derived SQLite cache, written only by the main process. It must stay
  reconstructible from the markdown alone — never store anything there that is not in a file. When
  you change its columns, bump `SCHEMA_VERSION`; the index drops and rebuilds itself from the task
  files, so no migration code is needed.
- The main process serves renderer reads from the index (`queryTasks`, `findTask`) and routes writes
  through `taskStore`, then calls `notifyTasksChanged()` to re-index and broadcast.
- External writes (the MCP server, an editor, a `git pull`) are picked up by the chokidar watcher in
  `src/main/watcher.ts`, which runs the same `notifyTasksChanged()`.

## Workspaces

A **workspace** is an isolated board (tasks, ids, agents, index). It is _not_ `Settings.storageDir`,
the folder that holds them — that setting was `workspaceDir` before this concept existed, and
`config.ts` migrates the old key on read. Keep the two words apart in code and UI.

Default is the storage root itself, so a pre-workspaces install needed no file moves; others are
`<storageDir>/workspaces/<id>/` with `tasks/`, `.styr/` and `workspace.json` (`{name}`).
`listWorkspaces` in `core/workspaces.ts` reads the folders — there is no registry to drift from the
disk. Ids never change after creation; rename edits the name only. `Settings.activeWorkspaceId` is
a local preference, and `loadSettings` falls back to Default when it dangles.

`workspaceDir(settings, id?)` in `config.ts` is the only place these paths are built. To act on a
background workspace use `pathsInWorkspace(settings, id)` — a settings copy that resolves paths
there — rather than a new parameter on every function. `pinWorkspace` is a process-wide override used only
by the MCP server (from `STYR_WORKSPACE_ID`, set on every launched agent) and by `inOtherWorkspace`
in `ipc.ts`, which wraps a _synchronous_ write; never leave it set across an `await`. The main
process must not read `STYR_WORKSPACE_ID` from its own environment: `yarn dev` inside an agent
terminal would inherit it.

Sessions carry `workspaceId`; anything that finds "the session of task X" must match both, since
`TASK-0001` exists in every workspace (`findSessionByTask`, the launch gate, the Codex monitor key
`<workspace>:<task>`). The renderer's board, titles and agent map describe only the active
workspace, so `sessionLabel` and the tab dots check the session's workspace before using them.

`switchWorkspace` (`ipc.ts`) saves the preference and `repoint()`s: close the index, restart both
watchers, re-sync. It is synchronous so quick switches apply in order. `settings:save` ignores the
`activeWorkspaceId` a Settings draft carries — only a switch changes it, or a stale dialog would
undo a workspace created or deleted since. The agents watcher covers every workspace's `agents/`
because the tray and notifications span all of them (`readBackgroundAgents`); the tasks watcher,
index, landing and Orchestrate cover the active one only.

### Workspace settings

Every setting is in exactly one of `GLOBAL_SETTING_KEYS` (`storageDir`, `activeWorkspaceId`,
`updates`, `shortcuts` — kept in `~/.styr/config.json`) or `WORKSPACE_SETTING_KEYS` (everything
else — kept in `<workspaceDir>/settings.json`), both in `types.ts`. A test holds `settingsSchema`
to the two lists, so a new key needs a deliberate choice. The file is in the workspace folder, not
`.styr/`, because `.styr/` is a cache that must be safe to delete. `Settings` stays the merged
shape, so consumers never see the split. The workspace keys include machine-specific paths (shell,
CLI commands, `defaultRepoPath`) — the user chose that — so a synced or git-tracked storage folder
carries them. The watchers ignore `settings.json`; an external edit shows on the next load.

`loadSettings(id?)` lays the workspace's own file over the config, then the global keys again (no
file can move the storage folder). The workspace is `id`, else the pinned one, else the preference
— so the MCP server and `inOtherWorkspace` get that workspace's templates and providers with no
other change. A workspace without a file runs on the shipped settings; there is no inheritance
between workspaces. `activeWorkspaceId` on the result is the workspace resolved, not necessarily
the preference. `pathsInWorkspace` is **paths only**: it keeps the caller's workspace settings, so
use `loadSettings(id)` for anything behavioural in another workspace.

`core/settingsStore.ts` reads, layers, caches and writes settings; `config.ts` keeps the shipped
defaults and templates, `migrateConfig`, the pin and the path helpers (`tasksDir`/`indexDbPath` sit
in the store because they default to `loadSettings()`). The store imports `config.ts`, never the
reverse, and `settingsMigration.ts` stays apart because it needs `workspaces.ts`, which imports the
store.

`loadSettings` is hot — every agent hook event, every task write, every MCP tool call — so the
store caches the parsed config and each `(storageDir, workspace)` layer, keyed on a
`statSync({ bigint: true })` stamp of each file (inode, size, mtime in ns: an atomic save changes
the inode). A hit reads and parses nothing; `resolveWorkspaceId` still runs on every call, so the
pin and a deleted workspace folder need no key of their own. `writeJsonAtomically` clears the cache,
so a write is visible to the next read whatever the mtime resolution. Cached values are deep-frozen
and shared: spread before changing anything.

A file that cannot be parsed or fails validation is reported by `isSettingsFileBroken` and copied to
`settings.json.bak` before a save overwrites it — the settings form of the rule for broken task
files. Unparseable JSON is left out of that workspace alone; a file that fails validation keeps the
keys that validate on their own against the config (`salvagedSettings`), so one bad value does not
cost the rest.

Every `settings.json` this app writes carries `version: 1` (`WORKSPACE_SETTINGS_VERSION`); a file
without one is version 1. Readers drop it with the other non-workspace keys.

Writes: `saveGlobalSettings(GlobalSettings)` keeps any other key already in the config;
`saveWorkspaceSettings` writes one workspace; `persistSettings(SettingsChange)` is the dialog's
Save, ordered so a failure leaves the app on the folder it was using — target looked up in the
folder being saved (refused before any write if missing), a new folder gets a copy of Default's
file, then the workspace file, `config.json` last. `settings:save` zod-parses the change and
re-points the index and watchers in a `finally`. `workspaces:create` seeds the new workspace with a
copy of the active one's settings; `createWorkspace` requires a seed.

`migrateLegacySettings` (`core/settingsMigration.ts`) runs once at main-process startup: a config
from before the split gives its workspace values to every workspace without a file, and loses them
only after every file is written. Only the main process runs it — it is the only writer — and until
it completes `loadSettings` still layers the legacy values in. Any future step added to
`migrateConfig` in `config.ts` must cover the workspace files too, keyed on their `version`; it
currently runs on `config.json` only.
Downgrading after the migration shows the shipped templates and routing in the older build.

`SettingsDialog` tags each `SECTIONS` entry with `scope`. `useWorkspaceTarget` owns which workspace
it edits: the dropdown swaps only the workspace keys of the draft (app-level edits survive), waits
for Discard or Stay before throwing away unsaved changes, and hands over to the active workspace
with a notice when the edited one is deleted. The theme is previewed by one effect, only while the
active workspace's theme differs from its saved one. `useWorkspaces` is called once, in `App`; the
dialog, `useWorkspaceTarget` and `WorkspacesPane` are handed its result, so opening Settings makes
no extra call. `scopeNoteFor` is the one place a section says where it is stored.

The MCP install commands are built from the _active_ workspace's CLI command, because the server is
registered once per machine; the Integrations hints say so rather than pretending it is per
workspace.

`worktreeKey(workspaceId, taskId)` (in `types.ts`, because `prompt.ts` needs it) names a task's
worktree and branch: bare id for Default so old worktrees still resolve, `<workspace>-<id>` for the
rest. Pass the key wherever `worktree.ts` takes an id.

Codex starts MCP servers with a filtered environment, so a Codex agent's MCP calls follow the
_active_ workspace unless its MCP entry forwards `STYR_WORKSPACE_ID`. Not solved; Claude Code passes
its environment through.

## Worktrees

`src/core/worktree.ts` wraps git. `ensureWorktree` is idempotent so a resume lands in the same
checkout. Worktrees are created beside the repo (`<repo>.worktrees/<taskId>`) — inside it they would
show as untracked files in the user's project.

A new worktree branch starts, after a best-effort `git fetch`, from the remote tip of the branch the
main checkout is on (its upstream, else `origin/<current>`, else `origin/<base>`) — so `main` and
`release/x.y.z` checkouts both advance. The remote is used only when HEAD is strictly behind it;
unpushed commits or divergence keep HEAD, as does a failed fetch (offline). See `startPointFor`.

`Task.baseBranch` (the New task dialog's Base branch select, fed by `listBranches` over `git:branches`)
overrides that automatic choice: the worktree starts from the fetched `origin/<baseBranch>`, else the
local branch, and a branch that has since vanished falls back to the automatic start. Unset means
automatic. It is fixed once `worktreePath` exists, since the branch is already cut.

Worktree failure is never fatal: `checkoutFor` in `launch.ts` falls back to the plain repository
and returns a `warning`, which `ipc.ts` writes to the task activity log. A blocked launch would be
worse than a shared working directory.

`WORKTREE_BRANCH_PREFIX` lives in `types.ts` because `prompt.ts` needs it too, and `prompt.ts` is
imported by the renderer — it must not reach for `worktree.ts`, which uses `node:child_process`.

## Agent providers

Everything that differs between agent CLIs sits behind `AgentProvider` in `src/core/providers/`.
`launch.ts` owns the shared flow — worktree, prompt file, the resume-or-start decision — and asks the
provider only for what it cannot know: the command line, whether a session still exists on disk, when
it was last written, and how to register the MCP server. Claude Code (`providers/claude.ts`) and Codex
are the providers. `providerFor` in `providers/index.ts` is the one place a provider is chosen;
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

Fresh and fork launches pass `-c sandbox_workspace_write.network_access=true`: the sandbox has network off
by default, which made `gh` report an invalid token and `git push` fail. Resumed threads keep the sandbox
they started with. Whether the daemon honours the override is unverified against a real daemon.

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

`src/core/sessionLifecycle.ts` owns the launch lifecycle behind injected `SessionPorts` (the task
store, index lookups, pty manager, Codex monitor, `pinWorkspace`): start for a task, the Codex thread
handoff (`pendingTemplates`), the workspace-changed-during-await guard, the ask PR / review / fork
and hand-off guards. `ipc.ts` builds the real ports and forwards its handlers. A launch's metadata is
written by one function for the active and for a background workspace (`recordCodexUpdate`); keep it
that way. Add new launch behaviour there with a fake-port test, not in `ipc.ts`.

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

The dialog is a `Modal` with `bare`: it draws no header or footer of its own, and `SettingsDialog`
supplies the nav (a "Workspace" group headed by the workspace picker, an "All workspaces" group
below it, filtered by each section's `words` from the search box), a header with the section blurb
and a scope chip, and a footer carrying the dirty status, Discard and Save (⌘↵). Dirty state is
derived by comparing `draft` to the saved settings over each section's `keys`, so a new section must
list the `Settings` keys it edits. The dialog height is fixed so switching sections does not resize
it. This layout follows the Claude Design file; change the design first, then the dialog.

Reusable form pieces live in `ui.tsx`: `Card`/`CardRow`, `Eyebrow`, `Hint`, `Switch`/`SwitchRow`,
`Stepper`, `Segmented`. Reach for these before writing a new control.

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
literal and is now `var(--color-col-review)`. Error text is `text-danger` (`--color-danger` in
`index.css`), not a Tailwind red with its own opacity in each file.

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

## Preferences

`Settings.taskDefaults` (`orchestrate`, `useWorktree`) only seeds the new-task form in `toForm`
(`TaskDialog`). Existing tasks keep their saved values, so changing a default never rewrites a
task. Preferences is the first `SECTIONS` entry and the dialog's default section.

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

## Terminal command blocks

A shell's commands are drawn as **blocks over xterm**, never instead of it: xterm still renders every
character, so ANSI, TUIs, selection and scrollback are untouched. The pipeline, in order:

- `ptyManager` stamps each `COMMAND_STARTED`/`COMMAND_FINISHED` with its **offset in the output
  stream** (`TerminalMark`, in `types.ts`) and sends marks beside the data, in `terminal:data` and in
  the backlog (`TerminalOutput`). Marks are kept as absolute offsets and trimmed with the backlog, so a
  reload rebuilds the same blocks.
- `lib/terminalOutput.ts` writes the data in pieces and calls `mark` between them; the empty
  `terminal.write('', cb)` it uses is queued behind the data, so `cb` runs when the cursor is exactly
  where the shell was. Never write a block's position from a runtime-state event instead: IPC order
  does not say where in a chunk the event happened.
- `lib/blockTracker.ts` turns marks into xterm **markers** (the command's own row is the one above
  the cursor at start; the end is the cursor's row, plus one if the output had no final newline) and
  reports `BlockLayout` — buffer lines, viewport top, cell height — per frame. Markers follow
  scroll, resize reflow and scrollback trimming, and a disposed marker drops its block.
- `TerminalBlocks.tsx` is a `pointer-events-none` layer positioned from that layout. Only its buttons
  take the pointer, and hover comes from the host's `mousemove` (`lineAt`), so selecting text is
  unaffected. The strip on a block's command row has to stay `pointer-events-auto` (it tracks enter and
  leave so the controls do not vanish when the pointer reaches them).

Not blocks: agent sessions (a task session, or a shell running `claude`/`codex` — one long command)
and the alternate screen. `TerminalSurface` skips both; the bar reports agent state instead.

## Terminal keys

A terminal sends a bare CR for both Enter and Shift+Enter, so Claude Code cannot tell them apart.
`/terminal-setup` works around this by binding Shift+Enter to send ESC + CR (`\u001b\r`), and
`src/renderer/src/lib/terminalKeys.ts` emits the same sequence from the embedded terminal via
`attachCustomKeyEventHandler`. Keep that logic as a pure function — it is the part worth testing,
and testing it should not require a DOM or an xterm instance.

`isAppShortcut` derives from the user's bindings (see **Shortcuts**) and holds no key list of its own.

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

`isAgentArchived` in `core/agentState.ts` decides what drops out of the agent lists: Done or archived
(`archivedAt`), full stop. It deliberately ignores agent state — a finished session leaves a `Notification` behind while
it idles at a prompt, so a state-aware rule leaves completed work reading _Waiting on you_. The
sidebar, the tray and the status-bar counts all derive from the same filtered rows; counting from
the raw agent map instead is how the badge kept showing archived agents.

Terminal exits are written to the agent file (`TerminalExit`) rather than held in memory, so a dead
session does not come back as whatever it was doing when the app last closed.

`AgentsSidebar` lists any task that has an agent status _or_ an `agentSession`, so a chat you can
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
there does not mean the work is free to restart. So a spec run that stops after specifying must hand
the task back to Backlog with `readiness: ready` (the spec template and `boardProtocol` say so);
left in In Progress it is invisible to Orchestrate.

`Task.sessions` is the append-only chat history; `Task.agentSession` is which of them the next
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

`terminal:launchAgent` moves a Backlog task to In Progress itself rather than trusting the agent
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

## Done means landed

The shipped `code-review` template (`config.ts`) and `boardProtocol` (`prompt.ts`) tell the agent
that `done` means the work is on the base branch, not that it was approved: a passing review with
commits still unlanded stays `in_review` and notes branch/base/count. The prompt never assumes a PR
or host — `gh` only when there is a GitHub remote.

Styr does not rely on the agent. `main/landing.ts` runs from `notifyTasksChanged` (so the watcher
covers external merges): an `in_review` worktree task whose branch has landed moves to `done`, and a
`done` task with a `worktreePath` is cleaned up through `cleanupLandedTask` in `core/worktree.ts`.
`branchLanding` checks the local base and `origin/<base>` — the task's `baseBranch` when set and still present, else the automatic base; "landed" is either zero commits ahead, or
(squash/rebase) every file changed since the merge-base identical on the base. A branch with no
commits of its own is not landed — the reflog tells a never-moved tip from a fast-forward merge.
Cleanup never forces the worktree removal, uses `branch -D` only after that check, deletes the remote
branch only when its tip equals the local one, and reports refusals once (deduped against the task's own latest styr note, so a restart does not repeat it —
the note write retriggers the watcher). `worktreePath` is cleared via `taskStore` once the worktree
is gone. Tasks with `useWorktree: false` are skipped entirely.

## Diagnostics

Command palette → "Show performance" opens `PerformanceDialog`: per-process CPU and memory
(`app.getAppMetrics`), main event-loop delay, recent `notifyTasksChanged` durations, renderer heap,
DOM nodes and long tasks, with a "Copy report" button. Sampling lives in `main/diagnostics.ts`; the
shapes, buffer and text formatter are pure in `core/diagnostics.ts`. Everything is memory-only —
never written to a task file, config or the index — and costs nothing while the panel is closed:
the timer, the long-task observer and the event-loop histogram all stop on close. Dev builds read
higher than a packaged app, so judge speed on a packaged one.

The main process is single-threaded and git calls there are synchronous (`execFileSync`), so each
costs the whole UI. Anything that runs on every task write (`notifyTasksChanged`) must be cheap in
the steady state: `main/landing.ts` skips a task whose status, worktree and branch/base ref tips
are unchanged (`LandingCache`, 5-minute expiry), and `git:diffStats` yields between tasks and runs
one pass at a time. Check the panel's "Task change handling" line after touching either.

## Hand-edited task files

Task markdown is edited by humans and by Claude sessions, not just by this app. Two rules protect it:

- `parseTaskMarkdown` normalises `status`, `priority` and `readiness` (lowercase, spaces and hyphens
  to underscores) before validation, so `In Review` parses. Normalisation happens in `markdown.ts`,
  never in the zod schemas — programmatic callers (IPC, MCP) stay strict.
- `readTaskAtPath` only adopts a file that has **no** frontmatter. A file that has frontmatter but
  fails validation is recorded in `brokenTaskFiles()` and skipped, never rewritten. Rewriting it
  would destroy the very fields that failed to parse.

The activity block starts at `<!-- styr:activity -->`; with no marker, a line that is exactly
`## Activity` starts it instead (so an agent's bare heading is not read as description). The marker
wins when both exist, and serialising always writes the marker.

`parseActivity` keeps any `- ` bullet it cannot parse as an entry with empty `at`/`author`, and
`renderActivity` writes those back bare. That is what makes a hand-written note survive a later
programmatic write.

## Ask agent

"Ask agent" (✦ button, selection toolbar, `terminalAskAgent`) opens `AskPrompt` first; nothing is
created until a question is sent. The terminal context is captured when the prompt opens, because
focusing its field can clear the xterm selection. In a shell it creates a `ready`, `ask`-tagged,
non-worktree task titled from the question (`taskFromTerminal`) and launches it. In a task session
`terminal:askFork` (`askFork` in `ipc.ts`) creates the same kind of task but starts its agent as a
copy of the source chat (`forkFrom` on `planLaunch`/`AgentProvider.buildCommand`: Claude
`--resume <src> --fork-session --session-id <new>`, Codex `codex fork`), in the source's own
directory since Claude keys transcripts by directory. It returns null when the source has no saved
chat and the renderer falls back to the shell behaviour. The Codex fork path reuses
`ThreadBindings.expect` and is untested against a real daemon.

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

## Done cap and archive

`Settings.doneCap` (`maxCount`, `maxAgeDays`, 0 = off; a workspace setting) hides old Done tasks from the board. The rule
is `applyDoneCap` in `core/doneCap.ts` — pure, shared by the renderer, applied in `useTasks`. The Done column is ordered by `finishedAt`, newest first (`sortDoneNewestFirst`), never by manual `order`; the board skips reorder drops there. The cap only
**hides**: nothing is written, "Show all" in the Done column brings them back. Recency decides who is
hidden, using `Task.doneAt` (stamped by `taskStore` when a task enters Done, dropped on leaving) and
falling back to `updatedAt` for hand-edited files.

Archive is `Task.archivedAt` in the frontmatter, set only through `setArchived` (the `tasks:archive`
IPC) — it is deliberately not in `TaskPatch`. It is orthogonal to status, drops the task from the
board, `isAgentArchived` and Orchestrate, and keeps the file. The Archive dialog (palette: "View
archive") lists archived tasks and unarchives them. The age cap does not auto-archive, so the board
never rewrites files on a timer.

## Inbox

The header's Board/Inbox switch (`⌘1`/`⌘2`, the `viewBoard`/`viewInbox` commands) swaps the board for
`Inbox.tsx`: the same tasks regrouped as Needs you / Running / Up next / Done. The grouping is
`buildInbox` in `core/inbox.ts` — pure, derived from tasks, agent states and the Orchestrate queue,
and it writes nothing, so the two views cannot disagree. A working agent outranks `needs_spec`.
Actions reuse the board's own handlers (launch, activate, changes, status update, archive); the
inbox cannot answer a permission prompt, so a waiting agent's action is "Open terminal". The view
is `App` state remembered in the renderer's `localStorage` (`styr:view`) — a per-machine convenience, not a setting, so it stays out of the config files — and the search box filters both views.

## External sources

External sources are **experimental**: `Settings.experimental.externalSources` (a global setting, Settings →
Experimental) gates them. Off, `activeSources(settings)` is empty, so sync, polling, mirroring,
`writableSource` and the MCP tools all do nothing, and the GitHub page, its palette entry and the
task dialog's Issue row are hidden (`flag` on a `SECTIONS` entry). Existing links stay in the task
files and the card badge still shows. A new experimental feature adds a key to `ExperimentalSettings`
and a `flag` on its section.

A **source** is an optional external system (GitHub Issues first) whose items are imported as tasks
and linked by `Task.externalRef` (`provider`, `id`, `url`, plus `sourceId`, `target`,
`remoteUpdatedAt` and `syncedHash`). Sources are the workspace setting `Settings.sources`
(`SourceConfig`): one per provider (`id` is the provider), switched on and given an access level —
there is no repository in it. The repositories are **detected** from the tasks' own `repoPath`s and
`Settings.defaultRepoPath` (`adapter.detectTarget`, the git remote; `sourceTargets` dedupes), so an
item's identity is source + `target` + id: issue numbers repeat across repositories. Imported tasks
get the checkout's `repoPath`. The task
markdown stays the only source of truth: a sync copies an item into a task file through
`taskStore`, and nothing renders from the remote live.

Everything provider-specific sits behind `SourceAdapter` in `src/core/sources/` (`adapterFor` is the
one place one is chosen; `github.ts` shells out to the `gh` CLI, so Styr stores no token). The pure
rules are in `sync.ts` — `planSync` (create / update / note) and `planPush` (what a status change
should do remotely) — and are what the tests cover. Adapters take an injected `CommandRunner`; every call also takes the `target` repository.

**Read-only is structural.** An adapter has no write methods of its own; `SourceAdapter.writer`
returns them, and the only caller is `writableSource(sourceId, target)`, which looks the source up again
on every call and throws `SourceReadOnlyError` unless it is `read_write` and enabled. Never call
`adapter.writer` anywhere else, and never add a write method to the read half. Sync, linking and
refreshing only read. `mirrorStatus` / `commentOnReview` do nothing without `read_write`.

`main/sourceSync.ts` owns the main-process side: poll timers for the active workspace's enabled
sources, `syncSource`, link/unlink/refresh, and `observeTasks`, called from `notifyTasksChanged`,
which pushes a linked task's status change (so an MCP or hand edit mirrors too). The first call only
records a baseline, and a status a sync itself set is not pushed back (`fromSync`). A push that
fails is noted on the task and not retried. A remote edit never overwrites a title or description
the user changed since the last import (`syncedHash`); a remote close moves a task to Done unless it
is In Progress.

`checkGh` reports `missing | outdated | unauthenticated | ready`; the Integrations pane shows it
first and disables adding, testing and syncing until ready. `gh` is run with a PATH widened by
Homebrew's directories because a Finder-launched app has a bare one.

Settings has an **Integrations** nav group (`group: 'integrations'` on a `SECTIONS` entry; the
Claude/Codex section is `agents`). The pane is one switch, an access control and the detected
repositories, with no list to maintain. Sync acts on the saved, active workspace's settings, so the
pane disables it while there are unsaved changes. A bare `#12` in the task dialog's Issue row means
the task's own repository; a pasted URL names its own. The MCP server has `list_sources` and a
guarded `comment_on_source_item` (which takes the repository).
