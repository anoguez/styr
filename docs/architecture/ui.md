# Renderer UI

Moved from CLAUDE.md verbatim; read it before touching this area.

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

`SettingsDialog` is a nav plus one pane per section, driven by the `SECTIONS` array in
`components/settings/sections.ts` — add a section there, give it a `settings/<Name>Section.tsx`
taking `SectionProps` (`draft`, `patch`), and render it from the dialog's `section === '…'` list
rather than lengthening a single scroll. The pure parts — unsaved-change counting, the nav filter,
template and provider edits — live in `sections.ts` and `settings/draft.ts` with tests. `Modal` takes
`flush` to hand its padding and scrolling to a child that manages its own panes.

The dialog is a `Modal` with `bare`: it draws no header or footer of its own, and `SettingsDialog`
supplies the nav (a "Workspace" group headed by the workspace picker, an "All workspaces" group
below it, filtered by each section's `words` from the search box), a header with the section blurb
and a scope chip, and a footer carrying the dirty status, Discard and Save (⌘↵). Dirty state is
derived by comparing `draft` to the saved settings over each section's `keys`, so a new section must
list the `Settings` keys it edits. Save keeps the dialog open: `useWorkspaceTarget.markSaved` makes what was
written the new baseline (and clears a broken-file notice), so the footer reads "All changes saved"
and later edits count from there. The dialog height is fixed so switching sections does not resize
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
(`lib/taskForm.ts`). Existing tasks keep their saved values, so changing a default never rewrites a
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
filled with `BrandMark`, `WorkspaceSwitcher`, `SearchBox`, `ViewTabs` and `DispatchButton`.

`TaskDialog` is the same shape: it holds the form and composes `components/task/` (`TaskHeader`, the
tabs in `TaskTabs`/`BriefTab`, `TaskSidebar` with its field groups, `TaskFooter`). Its rules are in
`lib/taskForm.ts`. Shared stroke icons are in `components/icons.tsx`.

## Shortcuts

`src/core/shortcuts.ts` is the single source of truth for what key does what. Before it, the same
knowledge lived in four places that had to agree by hand — the keydown chain in `App`, the list in
`isAppShortcut`, the `⌘N`-style labels in the UI, and the README table. Binding a key and forgetting
`isAppShortcut` produced a shortcut that worked everywhere _except_ when the terminal had focus,
while also leaking a byte to the shell. Nothing may reintroduce a second list:

- `SHORTCUT_COMMANDS` in `types.ts` is the command set. `runShortcutCommand` (`lib/appShell.ts`)
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

The header's Board/Inbox switch (`⌘1`/`⌘2`, the `viewBoard`/`viewInbox` commands) swaps the board for
`Inbox.tsx`: the same tasks regrouped as Needs you / Running / Up next / Done. The grouping is
`buildInbox` in `core/inbox.ts` — pure, derived from tasks, agent states and the Orchestrate queue,
and it writes nothing, so the two views cannot disagree. A working agent outranks `needs_spec`.
Actions reuse the board's own handlers (launch, activate, changes, status update, archive); the
inbox cannot answer a permission prompt, so a waiting agent's action is "Open terminal". The view
is `App` state remembered in the renderer's `localStorage` (`styr:view`) — a per-machine convenience, not a setting, so it stays out of the config files — and the search box filters both views.
