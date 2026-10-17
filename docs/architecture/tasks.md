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
(`app.getAppMetrics`), main event-loop delay, recent `notifyTasksChanged` durations, renderer heap,
DOM nodes and long tasks, with a "Copy report" button. Sampling lives in `host/diagnostics.ts` (main supplies the process metrics); the
shapes, buffer and text formatter are pure in `core/diagnostics.ts`. Everything is memory-only —
never written to a task file, config or the index — and costs nothing while the panel is closed:
the timer, the long-task observer and the event-loop histogram all stop on close. Dev builds read
higher than a packaged app, so judge speed on a packaged one.

The main process is single-threaded and git calls there are synchronous (`execFileSync`), so each
costs the whole UI. Anything that runs on every task write (`notifyTasksChanged`) must be cheap in
the steady state: `host/landing.ts` skips a task whose status, worktree and branch/base ref tips
are unchanged (`LandingCache`, 5-minute expiry), and `git:diffStats` yields between tasks and runs
one pass at a time. Check the panel's "Task change handling" line after touching either.

### `notifyTasksChanged` baseline

Measured on 2026-10-14 for the main-process refactor (TASK-0130) to compare against, by
`src/main/notifyTasks.perf.test.ts`: the real SQLite index, landing pass and source observer over a
200-task board (three notes each, no worktrees), timing the duration `ipc.ts` passes to
`recordNotifyDuration` — the panel's number. 200 runs per row, milliseconds, Apple M4 Pro, macOS
26.6, Node 24 under vitest (not Electron: compare like with like, on the same machine).

| Case                                       | p50     | p95     | max     |
| ------------------------------------------ | ------- | ------- | ------- |
| Cold: index file deleted (first start)     | 7.3–7.9 | 8.2–9.3 | 10–12   |
| Reopen: index closed (workspace switch)    | 1.6–1.8 | 1.9–2.1 | 2.3–3.2 |
| Warm: nothing changed on disk              | 1.3     | 1.5–1.6 | 1.7–1.9 |
| Warm: one task file written (a board edit) | 1.4–1.5 | 1.7–1.8 | 3.0–6.2 |

Ranges span three runs. Re-run with `STYR_BENCH=1 yarn vitest run src/main/notifyTasks.perf.test.ts`
(skipped otherwise; CI has no native modules). A refactor should stay within these ranges.

## Main-process ordering tests

The order and timing the main process depends on is pinned by characterisation tests. A change
that fails one should be a deliberate change of behaviour, with the test and this note updated:

- `src/main/ipc.test.ts` loads the real `ipc.ts` over a temporary storage folder, with Electron, the
  index, the watchers and the terminals faked into one call log. It pins `notifyTasksChanged` (sync,
  landing, observe, time, one broadcast, one Auto-run request; a burst is one Auto-run pass),
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
to carry out the typed request (plus the chosen preset's prompt and defaults, via `planningPrompt(request, preset)`) with the Styr MCP tools in reach. The brief never assumes the request is about creating tasks; the typed request itself says so. `archivePlanRun` (`ipc.ts`) archives it when its
terminal exits, so no card is left. Nothing detects a missing MCP setup; the prompt tells the agent
to say so and print what it would have done as text.

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
