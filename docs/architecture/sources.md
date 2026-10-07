# External sources

Moved from CLAUDE.md verbatim; read it before touching this area.

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

An imported task takes `Settings.taskDefaults` (`useWorktree`, `orchestrate`), passed to `planSync`.
"Blocked by" at the source (`RemoteItem.blockedBy`, read by one GraphQL call per 100 issues, best
effort) becomes `Task.blockedBy` in a second pass, `planBlockers`, once the tasks exist: it only
adds, skips blockers with no linked task, and a refused relation (cycle) is noted, not fatal.

`checkGh` reports `missing | outdated | unauthenticated | ready`; the Integrations pane shows it
first and disables adding, testing and syncing until ready. `gh` is run with a PATH widened by
Homebrew's directories because a Finder-launched app has a bare one.

Settings has an **Integrations** nav group (`group: 'integrations'` on a `SECTIONS` entry; the
Claude/Codex section is `agents`). The pane is one switch, an access control and the detected
repositories, with no list to maintain. Sync acts on the saved, active workspace's settings, so the
pane disables it while there are unsaved changes. A bare `#12` in the task dialog's Issue row means
the task's own repository; a pasted URL names its own. The MCP server has `list_sources` and a
guarded `comment_on_source_item` (which takes the repository).
