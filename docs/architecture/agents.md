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
client. `host/codexMonitor.ts` is one read-only listener that turns those into the hook-style
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

A multi-repo task passes each extra repo's worktree as `--add-dir <path>` (Claude and Codex alike,
via `ProviderCommandInput.extraDirs`; `launch.ts` never knows the flag). Claude repeats it on
resume. Codex 0.159.3's CLI parser accepts `--add-dir` on the TUI, `resume` and `fork` (checked with
`--help`); that the daemon applies it to the thread's sandbox is, like the network override, not
verified against a live daemon — the prompt names every repo's path either way, so the floor is an
agent that `cd`s there and may be prompted. The prompt (`buildPrompt`) takes `extraRepos` as plain
data and adds a "Repositories" block, placed by `{{repos}}` when a template has it, otherwise
appended with the board protocol; the Done and PR wording is per repo in that mode.

The MCP install command for Codex sets `STYR_MCP_AUTHOR=codex` so board notes are attributed.

## Models

Optional everywhere: with nothing picked, no `--model` flag is passed and the CLI runs its own
default. Models are registered per provider in Settings → Agents (`Settings.agentModels`); a prompt
template (`PromptTemplate.model`, `{provider, name}`) and a task (`Task.model`) pick from that list.
`launchModel` in `core/agentModel.ts` (pure, the renderer shows the inherited one) decides:

- the task's model, only while the launch uses the task's own provider — a Dispatch lane that routes
  the task to the other CLI must not pass it a name that CLI does not know;
- else the template's model, only when the launch sends the template and the template names the
  launching provider. A bare resume sends no template, so only the task's model applies to it.

Both CLIs take `--model` on fresh, resumed and forked launches; the name is quoted with the shell's
syntax. Unregistering a model leaves tasks and templates that use it alone; their dropdowns keep
listing it so the control shows what the file holds.

## CLI check before launch

Every launch (`sessionLifecycle.startForTask`, and the resume path in `ipc.ts`) first runs
`ensureAgentCli`: `<command> --version` through the terminal's own shell with
`TerminalShell.terminalCommandArgs` — for zsh and bash an _interactive_ login shell (`-i -l -c`),
because installers (Claude Code's included) put their PATH in `~/.zshrc`, which a plain `-l -c`
skips. It runs before anything is written, so a CLI the shell does not find refuses the launch with
a fix-it message instead of a "command not found" tab and a task stuck In Progress. Any other
failure of the check (a timeout, a noisy profile) only warns and the launch goes ahead
(`launchRefusal`). Only successes are cached (by platform, shell and command), so installing the CLI
works on the next click. Windows PowerShell 5.1 and cmd are refused without running anything. The
command and install command come from the `AgentProvider`; the pure decision is in
`core/agentCli.ts`; Settings → Agents shows the same check for the unsaved command and shell.

**MCP setup.** Whether a provider has the Styr MCP server is `McpSetupReport` (`registered`,
`stale`, `missing`, `unknown`). Each `AgentProvider` supplies `mcpProbeCommand` (`<cmd> mcp get
styr`, read-only and fast, unlike `mcp list`, which health-checks every server),
`parseMcpRegistration` and `mcpRemoveCommand`; `core/mcpSetup.ts` runs it through the terminal's
interactive login shell and compares the registered script path with this host's `mcpEntry()`
(case-insensitive on Windows; runner and env are ignored). A failed probe is `unknown`, never
`missing`. `mcp get` shows one effective entry, so a project-scoped duplicate is not compared.
Detection only: it never registers or repairs. A registration changed from outside after a
`registered` answer is picked up on Re-check or restart.

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
and hand-off guards. `host/agentsService.ts` builds its ports from the agents service's (see
`host.md`), and `ipc.ts` forwards its handlers. A launch's metadata is
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

The `Notification` hook matches only `permission_prompt|elicitation_dialog`. Claude Code also sends
an `idle_prompt` notification a minute after `Stop`; hooked, it overwrote the `Stop` record (and its
last message), so a finished turn read Idle or Waiting on you depending on when you looked.
`agentStore` still reads an `idle_prompt` record as `idle`, for sessions launched before the matcher.

`shownAgentState` is the label the views use: an idle agent on an In Review task with Dispatch off
(`orchestrate: false`) reads _Waiting on you_, since only you can move it on; a dispatched one stays
_Idle_. It is display only — Dispatch slots, the Create PR / review buttons and the "ask once it
stops" guards keep the hook's state, and the tray and workspace switcher count review separately
(`awaitsReview`).

`SessionStart` maps to `ready`, never `working` — a resume fires it with no turn in flight, and
calling that "Working" is a lie the user will notice immediately. `PreToolUse` is registered purely
so state recovers from `waiting` once a permission prompt is answered; without it a session stays
pinned at the top of the sidebar as waiting for the rest of its turn.

The hook command is deliberately plain POSIX shell: it wraps the hook's stdin payload verbatim as a
`payload` field and lets the app parse it. That keeps `node`/`jq` off the dependency list and means
new payload fields need no hook changes. It writes to a temp file then renames, so the watcher never
reads a partial file, and falls back to `null` when stdin is empty.

`src/host/watcher.ts` runs two independent watchers (tasks, agents). Its `close` helper clears the
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

After recording the exit, `markAgentExited` (`host/agentsService.ts`) runs `archiveOnExit`: a planning run
is archived, and so is an `ask`-tagged task still In Progress when `autoArchiveAsk` is on
(`shouldArchiveOnExit`, see tasks.md → Ask agent). Never git, never a timer.

`AgentsSidebar` lists any task that has an agent status _or_ an `agentSession`, so a chat you can
resume is visible even before its first hook fires. `sortAgentRows` ranks waiting first.

`markAgentExited` in `ipc.ts` records a locally observed terminal exit into the workspace it names.
It writes the same status file the hooks write, so there is no timestamp comparison: the last write
wins. A hook record that lands after the exit replaces it even when its second-precision `at` parses
earlier than the exit's milliseconds; `ipc.test.ts` pins this. Any comparison added later must parse
the dates — a string compare of the two precisions gets the order backwards.

### Subagents

Helpers an agent spawns (Claude Code's Agent tool, a Codex child thread) show as rows on the agent's
sidebar card and as a running count on its terminal tab and context bar. They are part of their
parent: they never add to a count, a badge, the tray, the Inbox, the sort order or Orchestrate.

- **Records.** Subagent events never touch the parent's status file. Each is its own file in
  `<agentsDir>/<taskId>.subagents/` — Claude's hook names it by seconds plus the hook shell's pid,
  so parallel stops cannot collide — in the usual `{taskId, event, at, payload}` shape. Claude hooks
  `SubagentStart`/`SubagentStop` and writes `UserPromptSubmit` there a second time as a turn marker.
  The agents watcher runs at depth 1 to see the folder.
- **Fold.** `readSubagents` in `agentStore.ts` pairs events by `agent_id` in mtime order (the hook's
  `at` is whole seconds). A done row stays until your next turn, then its files and the older turn
  markers are deleted. A `UserPromptSubmit` whose prompt is a `<task-notification>` is Claude Code
  waking the parent because a background subagent finished — not your turn, so it clears nothing.
  A foreground subagent (meta `requestShape`) still running at your next turn was cut off by an
  interrupt that sent no stop, so it is dropped too; a background one or one of unknown shape is not.
  `clearAgentStatus` (every launch) and `TerminalExit` drop the folder. Other workspaces' statuses
  skip the fold (`subagents: false`); only the tray reads them.
- **Labels.** Claude's hook payload has only `agent_type`; the Agent tool's description is in an
  undocumented `subagents/agent-<id>.meta.json` beside the session transcript, read best-effort
  (hits cached, misses retried) along with `requestShape`. Codex gives `agentNickname`/`agentRole` on `thread/started`.
- **Codex.** `ThreadBindings` never claims a thread with a parent (or a `subAgent` source) for a fresh
  launch — it used to take the first thread in the cwd. Helper threads belong to whoever owns their
  parent, at any depth; idle is a stop, active again a start. The task thread going idle → active is
  a new turn (`turnStarted`), written to the folder by `recordCodexUpdate`.
- **Parent state** still comes from the parent's file. A subagent's `PreToolUse` and `Notification`
  carry `agent_id` and still land there (Working, Waiting on you). A background subagent that outlives
  the parent's `Stop` cannot leave it stuck on Working: Claude Code follows its stop with a new
  parent turn and `Stop` (verified on 2.1.289).

## Orchestration

`orchestrate:run` takes the task ids the confirmation dialog showed and intersects them with a
fresh plan, so what starts is what the user agreed to even if the board changed while the dialog was
open. The dialog's order is honoured: ids in the plan launch in the order given (ids not in it are
ignored) and results come back in that order; without ids (Auto-run, MCP) it is plan order. Launches
start in sequence without awaiting each other.

The dialog's reorder and checkboxes are a **one-run override, never stored** — nothing reaches task
files or settings, and Cancel discards it. Unchecking **skips without backfilling**: a skipped task
frees no slot for another, so the list shown is what starts. Reorder is **launch sequence only**:
the list is already capped by lane capacity, so it cannot change which tasks start, just the order
they launch and their tabs open. Auto-run switched on with tasks unchecked warns that it will still
pick them up. The pure merge of a refreshed plan is `lib/dispatchSelection.ts`.

`src/core/orchestrate.ts` is a pure planner: given settings, tasks and the set of task ids holding a
live session, it returns what to start. All the selection rules live there so they can be tested
without launching anything; `src/host/dispatchService.ts` only performs the launches.

A lane's number is a hard ceiling: a task holds a slot in its current lane while its agent is `ready`,
`working` or `waiting`. `ready` counts because a launch starts there and the next Auto-run pass runs
before the agent turns `working`; `idle` and `exited` free the slot. An agent left `ready` forever
holds its slot until stopped.

`laneFor` mirrors `resolveTemplateFor` — readiness outranks status — so a task's lane always matches
the template it will actually run. Change one and change the other.

Only Backlog and In Review are dispatchable. In Progress is deliberately excluded: a dead session
there does not mean the work is free to restart. So a spec run that stops after specifying must hand
the task back to Backlog with `readiness: ready` (the spec template and `boardProtocol` say so);
left in In Progress it is invisible to Orchestrate. For the same reason a failed review hands the
task back to **Backlog** with `readiness: ready` and the fixes listed in an Activity note (the shipped
`code-review` template says so). Backlog's lane is implement, so the fixes are dispatched. Users who
copied the older template, which said `in_progress`, keep their text until they update it.

**Rework resumes the implementer.** `reworkLaunch` in `sessionLifecycle.ts` runs on every launch: an
implement-lane launch on a task whose current `agentSession` is a review run continues the latest
non-review chat in `Task.sessions` (of the requested provider, when the lane names one) if
`provider.sessionExists` finds it, else starts fresh. Either way it sends the prompt, led by
`REWORK_PREFACE` (`LaunchOptions.promptPreface`), which says a review asked for fixes and to read
the latest Activity note. A run is a review when the template it recorded (`TaskSessionRef.templateId`;
older entries: its `label`) is the one In Review routes to — never when a pinned template runs both
lanes. A launch that is `fresh`, names a session or picks another template is left alone.

`Task.sessions` is the append-only chat history; `Task.agentSession` is which of them the next
run continues. They look redundant but are not — Forget clears the pointer while keeping the
history, and a fresh review appends without discarding the implementer's chat.

**A spec hand-off unlinks the chat.** After every re-index, `notifyTasksChanged`
(`host/tasksService.ts`) clears `agentSession` on any task that is Backlog + `readiness: ready`
whose current chat is a spec run (`isSpecHandoff`, `core/specHandoff.ts`): the `Task.sessions` entry
whose `templateId` (older entries: `label`) is the template `needs_spec` routes to. `sessions` is
untouched, so the chat stays in the Agents tab, and the implement run that follows starts fresh with
no manual "Start fresh next run". It is derived and idempotent (nothing qualifies once cleared, so no
watcher loop), runs no git, and lives in the shared service so `styr serve` gets it too. No unlink for
In Progress, In Review, Done, `needs_spec`, implement/review chats, a pointer missing from `sessions`
or a pinned template that runs both lanes.

The status record is left alone, so the sidebar derives the rule instead: `agentRowsFor`
(`renderer/lib/agentRows.ts`) lists a task only with an `agentSession` or an open tab in this
workspace. After an unlink (hand-off or Start fresh next run) the row stays while its tab is open and
goes when the tab closes; palette entries and status-bar counts follow the same rows.

`planLaunch` also takes `resume` to reopen one specific past chat, bare, for reading back.

`planLaunch` takes `withPrompt` and `fresh`. Orchestrate sets `withPrompt` always — `--resume`
alone submits nothing, so a dispatched run would start an agent with no instruction — and `fresh`
for the review lane so the reviewer is not the session that wrote the code. The manual Resume button
passes neither.

The shipped review template's id is `code-review`, not `review`, because an early config shipped a
user-owned `review` template; an id collision silently shadows the shipped one and a reviewer then
gets no instruction on how to record its verdict.

The agents service's `launch` is shared by the per-task launch and the orchestrator, so both
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
`notifyAgentsChanged` call `requestAutoRun()`, which only marks work and arms one ~750ms
trailing timer, so a burst of writes is one pass and an idle app does nothing. Nothing in the plan
depends on elapsed time, so do not add an interval; a future time-based rule would arm a timer for a
known instant. The runner is `core/autoDispatchRunner.ts` behind injected ports (tested with fakes,
wired in `src/host/dispatchService.ts`); the rules are pure in `core/autoDispatch.ts`.

- **Stop is the flag going off.** The flag is read before every launch, so a pass under way starts
  nothing further; running agents are never touched. The limit and failure pauses use the same path
  and report a reason (`AutoDispatchState.paused`, per workspace).
- **Survives a relaunch.** The guards below are read back from the task files on every pass, so a
  relaunch (or a `styr serve` restart) does not reset them. A launch Auto-run makes records its lane
  on the new history entry (`TaskSessionRef.dispatch`, from `LaunchOptions.dispatchLane`), and
  `launchPatch` marks a review `sentBack` when an implementer is launched over it — the rework run
  resumes the implementer, so it leaves no entry of its own. `orchestrate:autoSet(true)` stamps
  `Settings.autoDispatchSince`. Only the consecutive-failure count and the pause reason stay in
  memory.
- **Loop guard.** A launch does not always remove a task from the plan (a review leaves it In Review).
  `guardedByHistory` skips a task whose current chat Auto-run started in the lane the task is in
  now, until the lane changes or another run takes over. The runner also remembers
  `workspace:task → lane|status|readiness` in memory, for what leaves no entry (a failed launch, the
  moment before the launch is written). `pruneMemory` runs _before_ the plan is built and both go in
  its `skip` set: left in, a guarded task takes the lane's slot and starves the rest.
- **Limits.** The three limits are the workspace setting `autoDispatchLimits`
  (`launchesPerHour` 20, `failures` 3, `reviews` 3; ranges 1-200, 1-20, 1-20, no "no limit"
  value), edited in Settings → Dispatch. The runner reads them through its `limits()` port once at
  the start of each pass, so a change applies from the next pass and, because the hourly count
  and the rework count are derived from the task files, to work already there.
- **Breaker.** `launchesPerHour` per rolling hour per workspace, and `failures`
  consecutive failed launches, switch Auto-run off with a notification. A runner's first pass in a
  workspace starts the hour's count from the `dispatch` entries (`autoLaunchTimes`).
- **Rework cap.** `reworkBounces` (`core/autoDispatch.ts`) walks the task's Auto-run reviews since
  `autoDispatchSince`, newest first: a `sentBack` review, or the current review of a task back in
  Backlog, is a bounce; the first review that is neither passed and ends the count. At
  `reviews` (3) the task joins the plan's `skip` set (`reworkHeld`) and `reworkCapped`
  notifies and notes the task ("TASK-x failed review 3 times; it needs you"). That note, dated after
  the newest bounce, is how a later pass or a relaunched runner knows it was told (`unnotedCap`).
  Manual Dispatch and launches still start it — the Dispatch dialog warns
  (`OrchestrationSummary.reworkHeld`). Only reviews Auto-run started are counted. The hold ends when a review
  passes (as one does before work lands), when Auto-run is switched on again or the task is
  deleted; a Done task is never held, but one dragged to Done by hand and reopened still is.
- **Fetch first.** Each pass awaits `beforePass` (the merged-work check below, at most 5s) before
  it reads the board, so a PR merged while the window was unfocused is Done before the plan is
  built, and what it blocked starts in the same pass.
- **Startup grace.** 30s after launch before the first pass; an explicit toggle skips it.
- Switching Auto-run **on** in the Dispatch dialog is a draft: it is applied on confirm (after the
  listed tasks start, so the first pass does not race them), and Cancel discards it. Stopping is the
  inline confirmation below and takes effect at once.
- The flag is switched only by `orchestrate:autoSet`; `persistSettings` keeps the on-disk value so an
  open Settings draft cannot undo a Stop, and a new workspace's seed copy starts with it off.
- **One button.** A workspace has at most one Auto-run, so it has no button of its own: the header's
  Dispatch button shows its state (`dispatchButton` in `lib/orchestrateHint.ts` — `auto` with the
  running count, `dispatching` only while a manual run's launches are in flight, `paused` after the
  breaker, else plain Dispatch) and opens the dialog that holds the switch. Stopping always asks
  first — inline in the dialog, `StopAutoRunDialog` from the palette — and the dialog cannot be
  confirmed while that question is open. The button is live only while Dispatch itself is acting:
  agents it started keep running after a run or a Stop, but they are not Dispatch "running", so the
  button never stays lit with nothing left to stop. Their cards carry the "Picked up by Dispatch"
  chip (`dispatchingIds`, fed by manual runs and `orchestrate:autoStarted`) until the agent idles.
- Auto-launched sessions reach the renderer through `orchestrate:autoStarted` (it adopts them like a
  manual launch). The tray can start and stop Auto-run too (stopping still asks, in the window; `ui.md`, Menu
  bar). The switch itself stays in the Dispatch dialog and the tray; Settings → Dispatch holds the limits.

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

Styr does not rely on the agent. The rules are `settleTasks` in `core/landing.ts` — pure over the
`CheckoutGit` adapter (`checkoutGit` from `core/taskCheckout.ts`, faked in `landing.test.ts`) and a `LandingCache`, returning the task-file writes (and any per-task errors, which
`host/landing.ts` logs rather than swallows); `host/landing.ts` only performs them. Every
`notifyTasksChanged` _requests_ a pass (`requestLanding`, so the watcher covers external merges) and
returns without waiting; a fetch (below) requests one too. An `in_review` worktree task whose branch has landed moves to `done`, and a
`done` task with a `worktreePath` is cleaned up through `cleanupLandedTask` in `core/worktreeLanding.ts`.

**Off the main thread.** A pass's git is asynchronous: `CheckoutGit` returns promises, and the git
conversations in `worktreeLanding.ts` are generators over `GitCall`s (`gitExec.ts`) that
`runGitAsync` runs in child processes — one repository's conversations one after another, different
repositories side by side — while `runGitSync` runs the same generators for the synchronous callers
(the Changes dialog). A merged PR used to freeze the window for seconds: the fetch moves
`origin/<base>`, so every In Review task in the repository is re-measured, and `git worktree remove`
deletes a whole worktree (`landing.integration.test.ts` measures 1.5s of stall done synchronously).
`createLanding` runs one pass at a time; requests made during a pass fold into a single queued pass,
their repositories merged. The cleanup reuses the landing it was handed rather than measuring the
branch twice. Before writing, a pass drops everything if the active workspace changed, and skips
(without caching) a task whose `status` or `worktreePath` changed while git ran; the next pass
measures it again. When a pass wrote, it runs `notifyTasksChanged` (`landingRequests`).
`branchLanding` checks the local base and `origin/<base>` — the task's `baseBranch` when set and still present, else the automatic base; "landed" is either zero commits ahead, or
(squash/rebase) every file changed since the merge-base identical on the base, or — once the base
has changed those files again — one base commit whose patch id equals the branch's whole diff
(`squashLanded`: whole commits via `--full-diff`, or renames break the id; patches go to `patch-id`
through `gitPipeStep`; answers cached by commit
ids). A branch with no commits of its own is not landed — the reflog tells a never-moved tip from a
fast-forward merge — but a Done task's cleanup still removes it, since nothing on it can be lost.
Cleanup never forces the worktree removal, deletes the local branch only after that check and only
while it is at the tip that was measured (`Landing.tip`, `update-ref -d <old>`), never touches a remote
(no push, no remote branch deletion — it could close an open PR), and reports refusals once (deduped against the task's own latest styr note, so a restart does not repeat it —
the note write retriggers the watcher). `worktreePath` is cleared via `taskStore` once the worktree
is gone. Tasks with `useWorktree: false` are skipped entirely.

**Merged on the host.** `branchLanding` reads only local refs, so a PR merged on GitHub is invisible
until `origin` is fetched. `checkForMergedWork` (`mergedWorkCheck`, wired in `ipc.ts`) → `fetchAndSettle` (`host/landing.ts`)
fetches every repository with an In Review worktree task (`reposAwaitingLanding`), then requests a
pass over the repositories it fetched and, if that wrote, runs `notifyTasksChanged`. Triggers, all
events and never an interval: a Styr window gaining focus (`browser-window-focus`), each Dispatch run
and Auto-run pass (both wait at most 5s, then go ahead without it), and the palette's _Check for
merged work_. `RemoteFetcher` (`core/landing.ts`) throttles to one fetch per repository per 60s and
joins a trigger to a fetch already in flight. The fetch is `fetchOrigin` (`core/worktree.ts`): an
asynchronous child process with `GIT_TERMINAL_PROMPT=0`, never the synchronous runners and never
inside `notifyTasksChanged`. Failures (offline, no `origin`, auth) are logged once per repository
per session and resolve as "nothing fetched"; they never block a launch or a dispatch.
