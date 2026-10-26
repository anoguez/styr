# Renderer UI

Moved from CLAUDE.md verbatim; read it before touching this area.

## Menu bar

`src/main/tray.ts` mirrors agent state into the macOS menu bar, dock badge and notifications.
`notifyAgentsChanged` in `ipc.ts` is the single update point for the agent rows.

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

The menu itself is plain data from `trayMenu` (`src/main/trayMenu.ts`, no `electron` import, tested
in `trayMenu.test.ts`); `tray.ts` keeps its latest inputs and rebuilds the whole menu whenever one
of them changes — the agent model (`updateTray`), the window (`watchWindow`: show, hide, focus,
blur, minimise, restore, closed) and Auto-run (`setTrayAutoRun`). There is no timer.

- **Open Styr** shows only while the window is not in front (`windowInFront`). On macOS that means
  focused: opening the status item's menu leaves the window key. On Windows and Linux, clicking the
  tray takes focus first, so there it means on screen and not minimised. The "N more" row opens
  Styr the same way, or is a disabled pointer to the agents sidebar while the window is in front.
- **Quick add task…** and **Open Inbox** show the window and send `app:command`. The window takes
  the request with `app:takeCommand` on mount and on each `app:command`, so a window the click had
  to create still runs it, exactly once (`runTrayCommand` in `lib/appShell.ts`).
- **Auto-run** is the active workspace's: Start goes straight through the routed
  `orchestrate:autoSet`; Stop… opens `StopAutoRunDialog` in the window (`stopAutoRun`, not the
  toggle, which a just-loaded window would read as off). After the breaker the reason row comes
  from `AUTO_DISPATCH_PAUSE_LABELS`. `index.ts` follows `orchestrate:autoState` and re-reads the
  state through the router on `settings:changed`, `workspaces:changed` and `remote:state`, tapping
  `electronHost.broadcast` (`onBroadcast`), so a remote board behaves as a local one; a board that
  cannot answer drops the section.
- Accelerators come from the bindings through `menuAccelerator` (`core/shortcuts.ts`), set with
  `registerAccelerator: false` so the renderer still handles the keys.

## Board layout

Cards are `shrink-0`. A column body is a flex column, and flex children shrink by default, so
without it a shorter board squeezes the cards and clips their content instead of scrolling the
column.

The card meta row keeps the id and counters `shrink-0 whitespace-nowrap`, and lets only the agent
label truncate. The agent state dot is also `shrink-0` — colour carries the state, so it has to
survive when the label does not.

A task's `orchestrate` flag ("Dispatch can start it") is switchable from the card without opening
the dialog: the paper-plane hover action, the context menu, and the plane in the meta row, which a
task Dispatch may start shows (not when Done, nor while the Dispatching badge carries the same
glyph). All three write `{ orchestrate }` through `tasks.update`; the card re-renders from the file
like any other write. The Agents sidebar row shows the same plane, display only — the row is
itself a button. The glyph lives in `components/dispatchMark.tsx`.

## Settings

`SettingsDialog` is a nav plus one pane per section, driven by the `SECTIONS` array in
`components/settings/sections.ts` — add a section there, give it a `settings/<Name>Section.tsx`
taking `SectionProps` (`draft`, `patch`), and render it from the dialog's `section === '…'` list
rather than lengthening a single scroll. The pure parts — unsaved-change counting, the nav filter,
template and provider edits — live in `sections.ts` and `settings/draft.ts` with tests. `Modal` takes
`flush` to hand its padding and scrolling to a child that manages its own panes.

The dialog is a `Modal` with `bare`: it draws no header or footer of its own, and `SettingsDialog`
supplies the nav (a "Workspace" group headed by the workspace picker and split into Board, Agents
and Environment sub-headings by each section's `sub`, an "All workspaces" group below it, filtered
by each section's `words` from the search box; a section with `live` shows a bolt in the nav and an
"Applies right away" chip because nothing on it waits for Save), a header with the section blurb
and a scope chip, and a footer carrying the dirty status, Discard and Save (⌘↵). Dirty state is
derived by comparing `draft` to the saved settings over each section's `keys`, so a new section must
list the `Settings` keys it edits. Save keeps the dialog open: `useWorkspaceTarget.markSaved` makes what was
written the new baseline (and clears a broken-file notice), so the footer reads "All changes saved"
and later edits count from there. The dialog height is fixed so switching sections does not resize
it. This layout follows the Claude Design file; change the design first, then the dialog.

A flow that needs the whole window closes Settings rather than stacking a dialog over it: New
workspace → Remote host (from Workspaces or Remote hosts) confirms any unsaved changes, closes
Settings and opens the app's New workspace dialog on Remote host (`remote.md`, Host setup).

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
(a spec run often retitles a task) updates the tab, with the task id as a secondary label. The task
may no longer be on the board, so the title recorded on the session at launch is the fallback — never
print `session.title` directly for a task session. `replay` marks a read-back of a past chat so it
can be told apart from the live tab of the same task.

The active tab scrolls itself into view. Title-width tabs overflow the strip quickly, and a tab
focused from the sidebar or the palette would otherwise be activated off-screen.

Tab dots use `AGENT_TONE` from `renderer/src/lib/agentTone.ts`, shared with the cards and the agents
sidebar. Active is shown by the underline, never by dot colour, so the two meanings never collide.

While the terminal is showing, the agents sidebar highlights the row owning the active tab
(`selectedAgentTaskId` in `lib/agentRows.ts`) with an accent border and tint, distinct from the
hover style, and scrolls it into view when the selection changes — so many tabs stay matchable to
their cards.

### Restoring tabs

After a relaunch Styr offers to reopen the tabs of the last session (`restoreTabs`: `ask` shows a
banner, `always` restores without it, `never` saves and offers nothing). The layout is
`~/.styr/terminal-tabs.json` (under `CONFIG_DIR`, so `STYR_HOME` moves it): machine-local state, so
not a setting, and not in the index, which must be rebuildable from task files. Losing it only means
nothing is offered. `host/terminalTabs.ts` owns it; the pure part (entries, the split of what can
be restored now, skip reasons, banner text) is `core/terminalLayout.ts`.

The file is written synchronously on each tab change — a session created, a session exited, or the
renderer reporting a new order or active tab through `terminal:setLayout` — never on output and with
no timer. A shell is saved where it is now (`TerminalRuntimeState.cwd`), an agent tab by task,
workspace and provider. Remote sessions, `replay` tabs and Ask / fork chats are not saved.
`before-quit` calls `freezeTerminalLayout()` _before_ `killAllSessions()`: exits and reports after
that are ignored, so quitting never saves an empty layout, while a tab closed by hand is removed as
usual.

On start the renderer asks `terminal:pendingLayout` and again whenever the active workspace
changes. The offer counts shells plus the agent tabs of the **active** workspace; another
workspace's agent tabs stay pending (resume needs its workspace active) and are offered when it is
switched to. Pending entries stay in the file, before the live tabs, until answered, so a crash
before answering still offers them. **Restore** (`terminal:restoreLayout`) opens the entries one at
a time in saved order, after the open tabs; **Dismiss** forgets the shells and the workspace's
entries. A shell is created by `createSession` in the current `settings.shell`; an agent tab goes
through `restoreAgent` in `core/sessionLifecycle.ts`: the launch gate, then a bare resume of
`task.agentSession` — no prompt, no status move, no task-file write. Whatever cannot come back (a
folder or task gone, no saved chat, a disabled provider, a missing CLI or repo) is skipped and
listed in the banner; the others still restore. An unparseable file or another version is ignored
and overwritten by the next save.

### Task activity panel

A task session's terminal can show its task's activity log (`TerminalActivity.tsx`) floating over
its right side, newest first — the same entries as the task dialog's Activity tab, read from the
board's `TaskLookupContext`, so it writes nothing. Both views show `taskTimeline` (`lib/taskTimeline.ts`): the
notes plus the events the frontmatter already records (created, each agent run in `sessions`, done,
archived), merged by time and drawn quieter. They are derived, never written; column moves are not
among them, since the file keeps only the current status. One switch in `TerminalPanel` covers every tab:
the Activity button in the context bar (in the tab bar while a full-screen program hides the bar)
and `terminalActivity` (⌘⇧A). While it is closed the button counts entries that arrived since the
task was last in view. The panel does not cover output: `TerminalSurface` gives the terminal a right
margin of the panel's width (`ACTIVITY_RESERVE`), and xterm refits from its resize observer. That
wrapper is always rendered, so toggling the panel never remounts the terminal. A plain shell, or a
session from another workspace, has no task here and shows neither button nor panel.

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
(`lib/taskForm.ts`). Existing tasks keep their saved values, so changing a default never rewrites a
task. Preferences is the first `SECTIONS` entry and the dialog's default section.

## Title bar

The window uses `titleBarStyle: 'hiddenInset'` with `trafficLightPosition` set to centre the lights
in a 44px row, and the header pads left by 86px to clear them. Changing the header height means
re-centring the lights — `y` is `(height / 2) - 7`.

In native full screen the lights are hidden, so the header drops that padding to 12px
(`useFullscreen`, fed by the main process's `window:fullscreen` event from `windowFullscreen.ts`;
comparing window and screen sizes in the renderer misfires).

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

## App shell

`App.tsx` only wires hooks to views. Keep it that way: behaviour goes in a hook or `lib/`, markup in
a component.

- `useAppShell` — which view, sidebar and dialogs are showing: `appShellReducer` (`lib/appShell.ts`)
  plus the remembered view and the reset on workspace switch. Esc, a workspace switch and every
  shortcut command are actions on it, so its rules are tested without rendering `App`. A new dialog
  adds a field and its actions there, not another `useState` in `App`.
- `useBoardView` — the sorted board, shown agents, the task lookup and the tab titles/states.
- `useAgentLauncher` — everything that opens a terminal tab (shells, launches, resumes, Ask review and
  fork, tasks from terminal output and Quick add plans), and `activateTask`.
- `useDispatch` — the Dispatch plan, the run in progress, Auto-run and the header button's state.
- `useCommands` — the keydown chain, `runShortcutCommand` and the palette's entries.
- `usePendingActivation` — menu bar requests that wait for the board to load.

The title bar is `components/header/`: `AppHeader` lays out three slots and mirrors them off macOS,
filled with `BrandMark`, `WorkspaceSwitcher`, `ViewTabs` and `DispatchButton`.

**What's new.** `WhatsNewDialog` (`shell.whatsNew`, `WhatsNewRequest`) opens from four places:
`useWhatsNewOnLaunch` once after a packaged build first runs a newer version (it waits until no other
modal is open), the palette's "What's new in x" (packaged builds only), the title-bar version
(Settings → Updates while an update is pending), and, in Incoming mode, the status bar's "Restart to
update" when release notes were fetched, plus a button in Settings → Updates. Rules in
`docs/architecture/releases.md`.

**Setup wizard.** `components/setup/SetupWizard.tsx` (`shell.setup`, a `SetupMode`) is one dialog in two
modes: "Welcome to Styr" on first run and "Quick setup" from the palette (`view:setup`), which also lets you
pick any workspace. Steps: Workspace, Agents, Dispatch, Theme, Review (`lib/setupWizard.ts` holds the pure
parts: presets, which step a key belongs to, the summary). It edits a draft of the same `Settings` keys as the
Settings dialog, reusing its pieces (`AgentCliStatus`, `McpSetupStatus`, `LaneAgentSelect`, the theme
presets), and writes once on the last step through `save`, then renames the workspace if its name changed;
closing early saves nothing. `useSetupOnLaunch` opens the welcome once, when `styr.setup.seen` is unset, no
repository is chosen and no board has a task; anyone else is just marked as seen. Never put a second list of
settings in the wizard: a new step edits existing keys.

`TaskDialog` is the same shape: it holds the form and composes `components/task/` (`TaskHeader` with the status pill, the
tabs in `TaskTabs`/`BriefTab`, `TaskSidebar` with its Properties, Agent and Workspace groups, `TaskFooter`). It follows the Claude Design file "Styr Task Dialog v3". Its rules are in
`lib/taskForm.ts`. Context files can be dropped anywhere on the Brief tab as well as picked with
Add; both go through `withContextFiles`, and dropped `File`s become paths via the preload's
`pathsForFiles` (`webUtils.getPathForFile`). Shared stroke icons are in `components/icons.tsx`.

## Shortcuts

`src/core/shortcuts.ts` is the single source of truth for what key does what. Before it, the same
knowledge lived in four places that had to agree by hand — the keydown chain in `App`, the list in
`isAppShortcut`, the `⌘N`-style labels in the UI, and the README table. Binding a key and forgetting
`isAppShortcut` produced a shortcut that worked everywhere _except_ when the terminal had focus,
while also leaking a byte to the shell. Nothing may reintroduce a second list:

- `SHORTCUT_COMMANDS` in `types/settings.ts` is the command set. `runShortcutCommand` (`lib/appShell.ts`)
  switches on it exhaustively, so adding a command is a compile error until it is handled.
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
  stream** (`TerminalMark`, in `types/terminal.ts`) and sends marks beside the data, in `terminal:data` and in
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
A task session's bar also shows the task's board column (`TASK_STATUS_LABELS`, dotted with
`STATUS_DOT` from `lib/statusTone.ts`) beside the agent state, so it reads with the board hidden.

### Shell integration

The marks come from Styr's hooks in the shell (`host/terminals/shellIntegration.ts`), which report
each prompt and command as private `OSC 777;STYR` records. `resolveShell` says which a shell gets
(`TerminalShell.integration`); a shell without one starts unchanged and draws no blocks. Each is
installed without typing anything into the terminal, and the user's own startup files are still
read:

- **zsh**: a private `ZDOTDIR` whose files source the user's, then add `preexec`/`precmd`/`chpwd`.
- **bash** (3.2 and later, Git Bash too): `--init-file`, which reads the login profile as `-l`
  would, then hooks bash-preexec's arrays when the profile loaded it, or else a `DEBUG` trap (chained
  to one the profile set) and `PROMPT_COMMAND` (string or array). The command line comes from
  `history 1`; a line history did not record (`ignorespace`) falls back to its first command.
- **fish** (3 and later): `--init-command` sources hooks on `fish_preexec`, `fish_postexec` and
  `fish_prompt`.
- **PowerShell 7**: `-NoExit -EncodedCommand` (a command, so no execution policy refuses it) wraps
  `prompt` and PSReadLine's `PSConsoleHostReadLine`. A failed cmdlet reports exit 1, not a stale
  `$LASTEXITCODE`. Windows PowerShell 5.1 and cmd get none.
- **Fix with agent** (block menu, failure bar, and the unbound `terminalFixLast` command, which does
  nothing but say so when the last command did not fail) makes a `ready` Backlog task through
  `taskFromTerminal` (`lib/terminalContext.ts`): ANSI-stripped output tail (6000 chars, with a note when
  clipped, in a fence longer than any backtick run), and `repoPath` from the git root of the command's
  directory (`repoForDirectory`, the same `terminal:gitContext` channel remote uses; default repo when
  none). The notice then offers Launch and Open; nothing launches on its own.

## Terminal keys

A terminal sends a bare CR for both Enter and Shift+Enter, so Claude Code cannot tell them apart.
`/terminal-setup` works around this by binding Shift+Enter to send ESC + CR (`\u001b\r`), and
`src/renderer/src/lib/terminalKeys.ts` emits the same sequence from the embedded terminal via
`attachCustomKeyEventHandler`. Keep that logic as a pure function — it is the part worth testing,
and testing it should not require a DOM or an xterm instance.

`isAppShortcut` derives from the user's bindings (see **Shortcuts**) and holds no key list of its own.

## Command palette

`CommandPalette.tsx` renders a flat, pre-ranked list; `buildCommandEntries` (`lib/commandEntries.ts`)
builds the entries from the board and shell state `App` passes in. Every entry is a `CommandEntry`
with a `run`, so the palette never knows what an action does — adding a destination means pushing
one more entry there, not touching the component.

`lib/fuzzy.ts` is pure and testable: `fuzzyScore` returns `null` for a non-match, so filtering and
ranking are the same pass. Scores favour prefixes and word boundaries over scattered matches.

Settings entries work because `SECTIONS` (`components/settings/sections.ts`) is shared and
`SettingsDialog` takes `initialSection` — the palette lists the real sections rather than a parallel
list that would drift.

`⌘P`/`⌘K` are in `isAppShortcut` (`lib/terminalKeys.ts`), or the embedded terminal would swallow
them and send them to the shell.

## Inbox

The header's Board/Inbox/Worklog switch (`⌃1`/`⌃2`/`⌃3`, the `viewBoard`/`viewInbox`/`viewWorklog` commands) swaps the board for
`Inbox.tsx`: the same tasks regrouped as Needs you / Running / Up next / Done. The grouping is
`buildInbox` in `core/inbox.ts` — pure, derived from tasks, agent states and the Orchestrate queue,
and it writes nothing, so the two views cannot disagree. A working agent outranks `needs_spec` and a review, but not a waiting agent or an open question
(`kind: 'question'`, see "MCP verbs" in `tasks.md`); a question has Send answer fields in the item and in
the task dialog's Brief tab (`OpenQuestions`).
Actions reuse the board's own handlers (launch, activate, changes, status update, archive); the
inbox cannot answer a permission prompt, so a waiting agent's action is "Open terminal". The view
is `App` state remembered in the renderer's `localStorage` (`styr:view`) — a per-machine convenience,
not a setting, so it stays out of the config files — and task search is available from the command
palette.

## Worklog

Experimental, behind `experimental.worklog`: off, the tab, the palette entry and `⌃3`
(`commandEnabled` in `core/shortcuts.ts`) are gone, and a remembered Worklog view shows the board.
It has no settings: weeks start on Monday, and the period and grouping are view state.

The third view (`components/worklog/`) shows the agent work each task took, per day: the tokens its
sessions used and how many sessions ran. Nothing about it is stored — it is derived on each load,
like the Inbox:

- `core/worklogSources.ts` (node) reads each of a task's `sessions` through its provider:
  `AgentProvider.transcriptPath` finds the transcript and `AgentProvider.transcriptUsageReader`
  parses it into model calls (`TranscriptUsage`: time, tokens, message id). `transcriptSources`
  keeps each transcript read in memory between loads: its path is looked up once (finding a Claude
  transcript scans every folder under `~/.claude/projects`), and since a transcript only grows, a
  later load parses just the complete lines added past the stored byte offset; a file shorter than
  that offset is read again from the start. Nothing of it is written to disk. A
  session whose transcript is gone still counts on the day it started, with no tokens; a message id
  already seen in an earlier session of the task (a fork's copied history) is not counted again.
  Tasks Done before the span are not read. `worklog:load` runs it on demand only, yielding between
  tasks — never from `notifyTasksChanged`.
- A session's tokens include its subagents'. `AgentProvider.subagentTranscripts` lists their
  transcripts again on every load (more appear while the session runs), and each is read the same
  incremental way with its own reader, keyed by its real path so a symlinked one and its target are
  parsed once; their calls count under the session that started them, on the days they ran. Claude
  Code keeps them in `<session-id>/subagents/agent-*.jsonl` beside the session's transcript (the
  Agent tool's `toolUseResult.usage` summary in the main transcript is not counted). Codex child
  threads (guardian reviews, spawned agents, and theirs) are separate rollouts found by the
  `parent_thread_id` in their first `session_meta` line; only the date folders from the parent's
  onward are walked, and each file's first line is read once per process.
- Tokens are input + output + cache writes; cache reads are left out, or every long conversation
  would read as millions of tokens. Claude Code writes one assistant message as several records
  sharing a `message.id`, so a message counts once. Codex reports running totals in `token_count`
  events (cached input inside `input_tokens`), so each call is what the total grew by.
- `core/worklog.ts` (pure, renderer-safe) does the rest: `worklogFrame` lays out the day/week/month
  columns and the span to fetch, `buildWorklog` counts tokens and distinct sessions into them (a
  session spanning two days is one session in a week), and `worklogTable` + `formatTable` produce
  the copied TSV and the exported CSV, with exact token counts.
- `useWorklog` refetches whenever the board's tasks change, so today's numbers grow as agents work.

Terminal activity outside an agent session is not a source: nothing records it to disk.

Project colours come from theme tokens in a fixed order over the sorted project names, so a project
keeps its colour across periods. Tasks without a `project` group under "No project".

## Changes review

The Changes dialog (`ChangesDialog`, `DiffPane`, the file list in `ChangesFileList`) takes review
comments on diff lines, as on a GitHub PR, and sends them to the task's agent with Request changes.
The review UI lives in `components/review/` (`CommentComposer`, `ReviewThread`,
`ReviewCommentList`, `RequestChangesSheet`, `ReviewFooter`, `ReviewSentToast`, `useDiffPaneReview`,
`useCommentJump`) and `hooks/useTaskReview.ts`.

- **Finding comments.** The file list's Comments tab (beside List and Tree, also opened by the
  footer's pending count) lists every pending comment by path and line, then the last sent batch
  under "Sent 14:20". Clicking one, or a comment in the Request changes sheet, opens its file and
  scrolls to it (`useCommentJump`: the card carries `data-cmt-id`; a comment inside a fold loads
  the whole file first); J / K walk the comments while the tab is open. Which comments are
  outdated in files not on screen comes from `review:prepare`.
- **After Send.** The Changes dialog closes and `ReviewSentToast` (App level, 8 s, held while
  hovered) says what went where, with Show terminal and Reopen changes. A resumed or started agent's
  tab takes focus; a live agent keeps its place.

- **Storage.** One file per task, `<workspace>/.styr/reviews/<TASK-id>.json` (`TaskReview`: the
  `pending` comments and the `lastSent` batch), written atomically by `host/reviewService.ts`. It is
  draft UI state: not in the task markdown, not in the index, not watched. A file that fails
  `taskReviewSchema` reads as empty, logs a warning and is left alone until the next save. Every
  add, edit and delete saves the whole pending list (`review:save`, last write wins); deleting a
  task removes its file.
- **Anchoring.** A comment stores its `path` (the new one for a rename), `side` (`old` only for a
  deleted row), `line` and the line's `text` (`commentAnchor` in `core/review.ts`, pure).
  `placeComments` puts it back on a refreshed diff: same side, line and text; else the fold hiding
  that line ("Show N unchanged lines · 1 comment"); else the nearest row on that side with the same
  text within 50 lines; else it is outdated, pinned in a band above the rows and marked "(outdated: the line has
  changed)" in the message. The
  last sent batch is drawn, dimmed, only where it places on its exact line.
- **Delivery.** `review:requestChanges(taskId, summary)` builds the message (`reviewMessage`, which
  the sheet's preview shows verbatim) from the stored comments, never from the caller's, and hands
  it to `deliverReview` in `core/sessionLifecycle.ts`. Its route (`reviewRoute`, which
  `review:prepare` shows in the sheet): a live terminal running the agent gets it as a prompt the way
  Styr Terminal's input sends one (`core/agentPrompt.ts`: the inbox or Codex's channel, else one
  bracketed paste and Enter), and a busy agent queues it itself; otherwise the task's chat is resumed
  with the message as its whole prompt (`LaunchOptions.prompt`), or with no chat the implement
  lane's template runs with the message as `promptPreface`. The terminal counts as the agent's only while
  the shell integration reports an agent CLI running (`agentProgramProvider` or the configured
  command): a conversation file left behind proves nothing. Its shell at a prompt gets the launch
  typed in; another program running there, or a shell that reports nothing, refuses with what is
  in the way. Only after delivery, pinned to the workspace it was sent from, do the comments move to `lastSent`, an In Review or
  Done task go back to In progress, a `styr` note record the counts and `review:changed` refresh open
  dialogs; a failed delivery changes nothing, and a record that fails after it is a warning on a sent review. A tab the launch opened comes back in the result for the
  renderer to adopt. Remote workspaces route the four `review:*` channels to their server like any
  board call.
