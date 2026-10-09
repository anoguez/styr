# Workspaces

Moved from CLAUDE.md verbatim; read it before touching this area.

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

`core/workspaceSession.ts` holds the switch / delete / after-settings-save ordering behind injected ports (tested with a call log), and `buildTrayModel`, the pure tray list and label policy; `ipc.ts` only wires the real ports. `switchWorkspace` saves the preference and `repoint()`s: close the index, restart both
watchers, re-sync. It is synchronous so quick switches apply in order. `settings:save` ignores the
`activeWorkspaceId` a Settings draft carries — only a switch changes it, or a stale dialog would
undo a workspace created or deleted since. The agents watcher covers every workspace's `agents/`
because the tray and notifications span all of them (`readBackgroundAgents`); the tasks watcher,
index, landing and Orchestrate cover the active one only.

### Workspace status in the switcher

The navbar switcher shows two things, fed two ways on purpose:

- **Live agent rollup** — the trigger badge (background waiting/working) and each row's glyph.
  `workspaceActivity` (`core/workspaceSession.ts`) rolls up `TrayModel.statuses`, which
  `notifyAgentsChanged` already builds for every workspace with archived/Done agents dropped, so
  it adds no disk reads to the hook path and the switcher can never disagree with the menu bar.
  It is pushed on `workspaces:activity` — not `workspaces:changed`, which refetches the whole
  overview (a readdir per workspace) and would run on every `PreToolUse`. The `workspaces:activity`
  invoke serves the last value for a window's first paint. The payload carries the `activeId` it
  was computed against, and the badge excludes by that, so the broadcast that a switch sends before
  `workspaces:changed` never counts the new board's agents as background. `top` follows
  `AGENT_STATE_ORDER` (the tray's order), ignoring `exited`. The badge also counts tasks ready
  for review (`awaitsReview` in `core/inbox.ts`, the Inbox's own rule): `buildTrayModel` and
  `readBackgroundAgents` already hold each agent's task, so they mark `awaitingReview` keys at no
  extra cost. Specs are left out of the badge — no agent event marks them, so counting them would
  mean reading task files on every hook event; they show in the open menu. When something needs
  you, it shows as a pill beside the switcher (`elsewhereNotice`) that switches to that workspace,
  or opens the menu when several need you; working-only shows as a hollow ring on the button.
- **Board counts** — each row's needs / running / up next. `workspaces:boardSummary` runs only when
  the menu opens (a user action, so no timer and nothing on the hook path). The active workspace
  comes from the index, the others from `readWorkspaceTasks`, which parses task files read-only and
  skips broken ones. Both go through `buildInbox` + `summariseInbox`, so the switcher matches the
  Inbox. Agents come from `readAllAgentStatuses` (not `agentStatuses()`): the Inbox never reads the
  branch, and it saves a git call per task. A workspace that fails to read is left out, and its row
  shows the agent glyph only. The reader never adopts, so a background workspace's plain `.md`
  note (no frontmatter) or `.json` task is not counted until you switch there and the index picks
  it up.

A stale `working` record after a crash shows as working, as it does in the tray — both read the
same records, with no cross-check against live terminals. The wording lives in
`renderer/lib/workspaceStatus.ts`: `idle` is "turn ended", never finished.

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
rest. Pass the key as `Checkout.key` (see Worktrees).

Codex starts MCP servers with a filtered environment, so a Codex agent's MCP calls follow the
_active_ workspace unless its MCP entry forwards `STYR_WORKSPACE_ID`. Not solved; Claude Code passes
its environment through.
