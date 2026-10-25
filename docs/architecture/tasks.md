# Tasks, diagnostics and housekeeping

Moved from CLAUDE.md verbatim; read it before touching this area.

## Task writes from the renderer

`src/host/taskWrites.ts` owns every renderer-driven task mutation (create, update, note, reorder,
archive, delete, forget session, remove agent, remove worktree): it parses the input
(`taskDraftSchema`, `taskPatchSchema`), writes through `taskStore` and then notifies — tasks once,
plus agents for archive and remove agent. The tasks service (`src/host/tasksService.ts`) gives it
the store and its own `notifyTasksChanged` as `TaskWritePorts`, and `ipc.ts` maps each channel to
one operation, so a new write handler goes through it rather than calling `notifyTasksChanged`
itself.

## Extra repositories

`extraRepos` is frontmatter next to `repoPath` and is read by `normaliseExtraRepos` in `markdown.ts`
(see `worktrees.md`, Multi-repo tasks). It is stored in one JSON index column and rebuilt from the
files like every other field. `TaskPatch` may change which repositories a task has only before the
first launch; `updateTask` throws once a worktree exists.

**Pull requests.** The primary repository's is the top-level `prUrl`, an extra's is its own
`extraRepos[].prUrl`. Anything that shows or counts a task's pull requests asks
`taskPullRequests` / `hasAllPullRequests` (`core/taskPullRequests.ts`, pure): the card (a plain link
for one, a menu labelled `#100 - repo` for several), the Inbox's "PRs ready" count, and the
terminal's Create PR button, which stays while any repository still lacks one.
An agent records them over MCP with `update_task` or `request_review`, both passing
`extraRepos: [{ repoPath, prUrl }]` to `mergeExtraPrUrls` (`core/taskPullRequests.ts`): entries match
an existing extra by `repoPath` (trailing slashes ignored), only `prUrl` is applied, an unknown path
is ignored and an empty `prUrl` clears it. The list itself is never replaced through either tool.

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

## Diagnostics

Command palette → "Show performance" opens `PerformanceDialog`: per-process CPU and memory
(`app.getAppMetrics`), main event-loop delay, recent `notifyTasksChanged` durations, the slowest
recent git calls (≥100 ms, each marked `blocking` when it ran synchronously; `core/gitTiming.ts`
records every call with two clock reads), renderer heap, DOM nodes and long tasks, with a "Copy
report" button. Sampling lives in `host/diagnostics.ts` (main supplies the process metrics); the
shapes, buffer and text formatter are pure in `core/diagnostics.ts`. Everything is memory-only —
never written to a task file, config or the index — and costs nothing while the panel is closed:
the timer, the long-task observer and the event-loop histogram all stop on close. Dev builds read
higher than a packaged app, so judge speed on a packaged one.

The main process is single-threaded, and a synchronous git call (`git()`/`gitRaw()`, `execFileSync`)
costs the whole UI for its duration. Nothing triggered by a task write, a watcher, window focus or a
timer runs git synchronously: `notifyTasksChanged` runs none (it only requests the landing pass),
the landing pass and `git:diffStats` run their git through `runGitAsync` (`gitExec.ts`), and diff
stats count untracked files from disk rather than with one git process each. The landing pass still
skips a task whose status, worktree and branch/base ref tips are unchanged (`LandingCache`, 5-minute
expiry), and both run one pass at a time. The remaining synchronous git answers an explicit action
(a launch's worktree, the Changes dialog). Check the panel's "Slow git calls" list after touching
any of it: a `blocking` entry is a freeze the user felt.

The renderer subscribes once to `terminal:data` and `terminal:exit` and routes each event to its
session's view (`lib/terminalEvents.ts`), so an agent's output crosses the preload bridge once,
not once for every open tab.

### `notifyTasksChanged` baseline

Measured on 2026-10-14 for the main-process refactor (TASK-0130) to compare against, by
`src/main/notifyTasks.perf.test.ts`: the real SQLite index and source observer (and, before
TASK-0145, the landing pass, which is now requested rather than run inline) over a
200-task board (three notes each, no worktrees), timing the duration `ipc.ts` passes to
`recordNotifyDuration` — the panel's number. 200 runs per row, milliseconds, Apple M4 Pro, macOS
26.6, Node 24 under vitest (not Electron: compare like with like, on the same machine).

| Case                                       | p50     | p95     | max     |
| ------------------------------------------ | ------- | ------- | ------- |
| Cold: index file deleted (first start)     | 7.3–7.9 | 8.2–9.3 | 10–12   |
| Reopen: index closed (workspace switch)    | 1.6–1.8 | 1.9–2.1 | 2.3–3.2 |
| Warm: nothing changed on disk              | 1.3     | 1.5–1.6 | 1.7–1.9 |
| Warm: one task file written (a board edit) | 1.4–1.5 | 1.7–1.8 | 3.0–6.2 |

After TASK-0145 (2026-10-21, same machine, one run): cold 7.2 / 9.1 / 11.0, reopen 1.3 / 1.6 / 3.0,
warm unchanged 1.0 / 1.2 / 1.5, warm one write 1.1 / 1.4 / 2.2 (p50 / p95 / max), all within or
under the ranges above.

Ranges span three runs. Re-run with `STYR_BENCH=1 yarn vitest run src/main/notifyTasks.perf.test.ts`
(skipped otherwise; CI has no native modules). A refactor should stay within these ranges.

## Main-process ordering tests

The order and timing the main process depends on is pinned by characterisation tests. A change
that fails one should be a deliberate change of behaviour, with the test and this note updated:

- `src/main/ipc.test.ts` loads the real `ipc.ts` over a temporary storage folder, with Electron, the
  index, the watchers and the terminals faked into one call log. It pins `notifyTasksChanged` (sync,
  observe, time, one broadcast, a landing request it does not wait for, one Auto-run request; a
  burst is one Auto-run pass),
  `notifyAgentsChanged`, `switchWorkspace` (synchronous, A→B→A ends on A, index closed before the
  watchers restart), `inOtherWorkspace` (pin cleared after the work, on a throw, and never held
  across an await), `markAgentExited` and the `terminal:launchAgent` dedupe per workspace.
- `src/main/watcher.test.ts` pins the close race: a watcher restarted while the old one is still
  closing keeps running.
- `src/main/index.test.ts` pins the start-up call order: handlers before the window loads, the
  Auto-run grace after the first index sync.

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

Every rewrite (`add_task_note`, a status change) serialises the parsed task, so **nothing under
the activity heading may be dropped by the parser**. A line that is not a note joins the note before
it as written (or opens an untimed one). A heading or a thematic break (`---`) ends the section:
what follows is content an agent appended below Activity, such as a spec written with `cat >>`, and
it goes back into the description, so the next write moves it above the section. Dropping those
lines is what once erased a spec. `markdown.test.ts` holds both shapes.

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

**Archived when the chat ends.** `markAgentExited` calls `archiveOnExit`, which asks the pure
`shouldArchiveOnExit` (`core/archiveOnExit.ts`) inside one synchronous `pinWorkspace`, then
archives through `setArchived` and notifies once. An ask is archived only if it still has the
`ask` tag, is `in_progress` (In Review, Done or Backlog means someone moved it on), is not
archived, and the workspace setting `autoArchiveAsk` (default on) is on. Removing the tag is the
owner's "keep this". The task keeps its `sessions`, so the chat resumes from the Archive dialog,
and exiting again re-archives it. Commits and title edits are deliberately not signals: asks share
the repo and nothing stores a baseline. Planning runs use the same helper but archive whatever
their status. `remove()` still skips it. On quit, `killAllSessions` kills the terminals, so an
exit that reaches `markAgentExited` before the process ends archives its in-progress ask too;
that is fine, the chat stays resumable.

## Task presets

`Settings.taskPresets` (a workspace setting) are starting points for the New task dialog, called
**presets**, never templates: `PromptTemplate` owns that word. Applying one copies its values into
the form (`presetFields` in `core/taskPreset.ts`); the task keeps no link, so editing or deleting a
preset never touches existing tasks. A preset omits `repoPath`, context files and status. A
workspace whose `settings.json` has no `taskPresets` key runs on `DEFAULT_TASK_PRESETS`; once the
key is saved the list is the user's. The schema drops one invalid entry rather than the whole list.
A new workspace inherits them through the settings seed copy. Recurring tasks are not built: they
would attach as a schedule pointing at a preset id, evaluated for the active workspace only, with
at most one catch-up run and no new task while the previous one from that schedule is open.

**Quick add** (`QuickTaskDialog`) is the only other consumer: a leading `/` opens a picker over the
same presets, the chosen one shows as a tag, and `quickTaskDraft` seeds the task from it (title is
what was typed). ⌘↵ instead starts a **planning run**: a ready, non-worktree task tagged
`quick-plan` (`planDraft`, `planningPrompt` in `core/planning.ts`) launched on the default provider
to carry out the typed request (plus the chosen preset's prompt and defaults, via `planningPrompt(request, preset)`) with the Styr MCP tools in reach. The brief never assumes the request is about creating tasks; the typed request itself says so. `archiveOnExit` (`host/agentsService.ts`) archives it when its
terminal exits, so no card is left. The dialog asks `agents:mcpStatus` for the default provider and warns inline (never
blocks) when the Styr MCP server is missing or stale; the prompt still tells an agent that cannot
see the tools to say so and print what it would have done as text. The New task dialog warns the
same way for the provider "Save and start" would use (`components/McpSetup.tsx`).

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

## MCP verbs

Three intent-level tools on the MCP server (`src/mcp/index.ts`), each a thin call into `src/core/`
that writes only through `taskStore`, and each with a file-only form an agent without the server
(or a hand edit) produces. `boardProtocol` in `prompt.ts` names the tool first and the file edit as
the fallback (`core/boardTools.ts`). `set_task_status` and `update_task` are unchanged.

- **`split_task`** (`core/taskSplit.ts`). Validates everything first (parent exists, not Done or
  archived; `after` indexes point at _earlier_ siblings; `blockedBy` ids exist and none waits on the
  parent), so bad input writes nothing; then creates the children in order and turns the parent into a
  **blocked umbrella**: `blockedBy` gains every child, `orchestrate: false` (Dispatch never picks it up,
  before or after the children are Done) and a `## Split into` list. Children inherit the parent's
  repo, worktree, base branch, provider, model, context files and orchestrate. A child create that
  throws deletes the children made so far (best effort, not a transaction). The parent's status is left
  alone; once its children are Done it is an ordinary unblocked task the owner closes. File-only form:
  create the files and edit `blockedBy`.
- **`request_review`** (`core/reviewRequest.ts`; not `handoff.ts`, which the renderer imports and
  must stay node-free). Writes a replaceable `## Handoff` section, sets `in_review` (and `prUrl`, plus `extraRepos[].prUrl` through `mergeExtraPrUrls`) in one
  `updateTask`, adds a note, and returns the open question count. `changed` and `verify` are required.
  `getSection(description, 'Handoff')` (`core/sections.ts`, pure) reads the tool's section and a
  hand-written one alike. Sections are `## ` lines matched case-insensitively and run to the next `## `;
  headings inside code fences do not count.
- **`ask_owner`** (`taskStore.askQuestion`). Questions are the frontmatter list `Task.questions`
  (`id`, `askedAt`, `askedBy`, `text`, and `answer`/`answeredAt`/`answeredBy` once answered). They are
  not in `TaskPatch`: they change only through `askQuestion` / `answerQuestion`, each with its note in
  the same write, so `update_task` cannot clobber an answer. At most 20 are open. `markdown.ts`
  normalises hand-written entries (a bare string is a question; ids, `askedAt` and `askedBy` are filled
  in; entries with no text are dropped) and never fails the file. The index keeps them in a JSON column.

**Terminal first.** The owner is often in a maximised terminal, not the Inbox, so the prompt
(`ASK_LINE`) tells the agent to put the question in the conversation as well as call `ask_owner`. An
answer given there is recorded by the agent with `resolve_question` (`taskStore.answerQuestion`, the
same write as the Inbox's Send answer), so the Inbox entry closes. The Inbox still lists the question
until then.

**Inbox.** An open question is `kind: 'question'` in Needs you, ranked after `waiting` and before the
rest. It outranks a _working_ agent — a deliberate change of "a working agent outranks everything" —
so a question to the owner never hides under Running. A waiting agent still wins the kind. A Done or
archived task is not listed; its questions stay in the file. `summariseInbox` counts `question`.

**Answering.** `tasks:answerQuestion(taskId, questionId, answer)` → `taskWrites.answerQuestion`
records the answer, then delivers it through the Request changes routes (`reviewRoute` /
`deliverReview`): queued at the agent's next stop, now, or by resuming its chat. A task with no chat
(`fresh`) is not launched; the answer is recorded and `buildPrompt`'s `## Questions for the owner`
block shows it on the next launch. A failed delivery keeps the answer and reports `failed`; an answered
question is refused, so it is never sent twice. The task's status is not moved. A hand-written
`answer:` shows as answered with nothing delivered.
