# Agents, launching and orchestration

Moved from CLAUDE.md verbatim; read it before touching this area.

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

## CLI check before launch

Every launch (`sessionLifecycle.startForTask`, and the resume path in `ipc.ts`) first runs
`ensureAgentCli`: `<command> --version` through the terminal's own shell with `commandShellArgs`, so
the PATH is the one the launch will see (zsh or `$SHELL` on macOS, Git Bash on Windows). It runs
before anything is written, so a missing CLI refuses the launch with a fix-it message instead of a
"command not found" tab and a task stuck In Progress. Only successes are cached (by platform, shell
and command), so installing the CLI works on the next click. On Windows a non-POSIX shell is refused
without running anything. The pure decision and the per-OS install commands are in
`core/agentCli.ts`; Settings → Agents shows the same check for the unsaved command and shell.

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

`idle` (label "Idle", from `Stop`) means the turn ended with the session still open — never "task complete", which is the task's status. Do not label it Finished.

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

## Task dependencies

`Task.blockedBy` is a list of same-workspace task ids (ids repeat across workspaces, so there is no
cross-workspace form). **Blocked is derived, never stored**: `openBlockers` in `core/blocking.ts`
returns the blockers that are not Done, so nothing is written when one finishes. An unknown id is
ignored (a typo must not hold a task forever; the task dialog warns), an archived blocker that is
not Done still blocks, and only direct blockers are read, so a hand-edited cycle cannot loop — it
just leaves both ends blocked. `taskStore` refuses unknown ids, self-reference and cycles, but only
when the list _changes_, so a task with a hand-made bad list still saves. `markdown.ts` tidies a
hand-written list (case, duplicates) and drops entries that are not ids rather than failing the file.

Orchestrate (`planOrchestration`) skips blocked tasks in every lane and counts them in `blocked`.
Inbox puts them in Up next as kind `blocked` (a task that still needs a spec stays in Needs you);
`buildInbox` takes the full task list as `all` because the board hides Done tasks and search
results. The renderer reads blockers through `TaskLookupContext` (`lib/blockerContext.ts`), fed
from `useTasks().allTasks` — unfiltered by search. A manual launch of a blocked task **warns and
proceeds on confirm**, never refuses (`launchAgent` in `App`); resuming a task that has a chat never
asks. This follows the shortcut rule: warn, do not force the user to undo something first.

## Auto-run

Dispatch's **Auto-run** (`Settings.autoDispatch`, a workspace setting, default off) keeps starting what
"Dispatch now" would start. It is **event-driven, never a timer**: `notifyTasksChanged` and
`notifyAgentsChanged` call `autoDispatch.request()`, which only marks work and arms one ~750ms
trailing timer, so a burst of writes is one pass and an idle app does nothing. Nothing in the plan
depends on elapsed time, so do not add an interval; a future time-based rule would arm a timer for a
known instant. The runner is `core/autoDispatchRunner.ts` behind injected ports (tested with fakes,
wired in `ipc.ts`); the rules are pure in `core/autoDispatch.ts`.

- **Stop is the flag going off.** The flag is read before every launch, so a pass under way starts
  nothing further; running agents are never touched. The limit and failure pauses use the same path
  and report a reason (`AutoDispatchState.paused`, per workspace).
- **Loop guard.** A launch does not always remove a task from the plan (a review leaves it In Review),
  so the runner remembers `workspace:task → lane|status|readiness` in memory and does not start it
  again until that changes. `pruneMemory` runs _before_ the plan is built and its `skip` set keeps
  remembered tasks out of `planOrchestration`: left in, they take the lane's slot and starve the rest.
- **Breaker.** `AUTO_LAUNCH_LIMIT` per rolling hour per workspace, and `AUTO_FAILURE_LIMIT`
  consecutive failed launches, switch Auto-run off with a notification.
- **Startup grace.** 30s after launch before the first pass; an explicit toggle skips it.
- The flag is switched only by `orchestrate:autoSet`; `persistSettings` keeps the on-disk value so an
  open Settings draft cannot undo a Stop, and a new workspace's seed copy starts with it off.
- Auto-launched sessions reach the renderer through `orchestrate:autoStarted` (it adopts them like a
  manual launch). Not built: the tray item and a Settings pane control.

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

Styr does not rely on the agent. The rules are `settleTasks` in `core/landing.ts` — pure over injected
git ports and a `LandingCache`, returning the task-file writes (and any per-task errors, which
`main/landing.ts` logs rather than swallows); `main/landing.ts` only performs them. It runs from
`notifyTasksChanged` (so the watcher covers external merges): an `in_review` worktree task whose branch has landed moves to `done`, and a
`done` task with a `worktreePath` is cleaned up through `cleanupLandedTask` in `core/worktreeLanding.ts`.
`branchLanding` checks the local base and `origin/<base>` — the task's `baseBranch` when set and still present, else the automatic base; "landed" is either zero commits ahead, or
(squash/rebase) every file changed since the merge-base identical on the base. A branch with no
commits of its own is not landed — the reflog tells a never-moved tip from a fast-forward merge.
Cleanup never forces the worktree removal, uses `branch -D` only after that check, deletes the remote
branch only when its tip equals the local one, and reports refusals once (deduped against the task's own latest styr note, so a restart does not repeat it —
the note write retriggers the watcher). `worktreePath` is cleared via `taskStore` once the worktree
is gone. Tasks with `useWorktree: false` are skipped entirely.
