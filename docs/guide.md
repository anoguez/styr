# User guide

Everything Styr does, in the order you'll meet it. For setup, see the [README](../README.md).

- [Tasks on disk](#tasks-on-disk)
- [Launching an agent on a task](#launching-an-agent-on-a-task)
- [How agents move tasks](#how-agents-move-tasks)
- [The MCP server](#the-mcp-server)
- [Orchestrate](#orchestrate)
- [Settings](#settings)
- [Theme](#theme)
- [The status bar](#the-status-bar)
- [Command palette](#command-palette)
- [Shortcuts](#shortcuts)

Agent support today means Claude Code, so the commands and file paths below are Claude's. Other
agent CLIs are planned behind the same provider interface.

## Tasks on disk

On first launch the board stores its tasks in `~/Styr/tasks`. Change that under **Board storage
folder** in Settings. It holds the board's own data only, never your code. **Default working
directory** is the separate setting for where agents and new shells actually run.

```md
---
id: TASK-0001
title: Fix login redirect
status: in_progress # backlog | in_progress | in_review | done
priority: medium # low | medium | high | urgent
readiness: ready # ready | needs_spec
project: acme
tags: [bug]
repoPath: /Users/you/Workspace/acme
contextFiles:
  - /Users/you/Workspace/acme/src/auth/session.ts
  - /Users/you/Workspace/acme/docs/sso.md
order: 0
createdAt: '2026-09-30T01:00:00.000Z'
updatedAt: '2026-09-30T01:05:00.000Z'
---

## Context

The redirect loops after SSO.

<!-- styr:activity -->

## Activity

- `2026-09-30T01:05:00.000Z` **claude** — Reproduced it; the state cookie is dropped.
```

`.json` task files are read and written too, using the same fields plus `description` and
`activity` — useful when a generator emits JSON.

**Wayfinder specs drop straight in.** A plain `.md` file with no frontmatter is adopted on the next
scan: it gets an id, the title comes from the first `# heading`, and the frontmatter is written back
into the file in place.

The app keeps its own state in `<workspace>/.styr/`: the SQLite index, rendered prompts, hook
settings and agent status files. It is all derived or temporary, and deleting it costs nothing.

## Launching an agent on a task

Hover a card on the board and hit **▶ Claude** — that launches straight away using the task's own
prompt template. From inside a task, **Save & start Claude** saves your edits first and then launches.

Either way the app renders the task's prompt template, writes it to
`<workspace>/.styr/prompts/<id>.txt`, and runs it in a new embedded terminal tab from the
task's `repoPath`:

```sh
claude "$(cat '<workspace>/.styr/prompts/TASK-0001.txt')"
```

### Knowing what Claude is doing

The board shows live agent state per task — **Ready**, **Working**, **Waiting on you**, **Finished**
or **Stopped** — so you can see at a glance which sessions need you.

This does not scrape the terminal. Each launch writes a small settings file registering Claude Code
lifecycle hooks, passed with `--settings`, which _adds_ to your own settings rather than replacing
them (your global hooks keep working). The hooks write one JSON file per task into
`<workspace>/.styr/agents/`, the app watches that directory, and the board updates.

| Hook event                       | State                                                                         |
| -------------------------------- | ----------------------------------------------------------------------------- |
| `SessionStart`                   | **Ready** — session open, nothing in flight (this is what a resume gives you) |
| `UserPromptSubmit`, `PreToolUse` | Working                                                                       |
| `Notification`                   | **Waiting on you** — Claude needs input or a permission                       |
| `Stop`                           | Finished (captures Claude's last message)                                     |
| terminal exits                   | Stopped                                                                       |

A resumed session sits at **Ready** until you actually send something — opening a session is not
work. `PreToolUse` is what flips it back to Working once you answer a permission prompt, which
`Notification` would otherwise leave stuck on Waiting.

### The menu bar

Styr sits in the macOS menu bar, so you can see agent state without switching to the app.
When agents are waiting it shows a count next to the icon and badges the dock:

```
                                       ▮▮▯ 2   🔍  🔋  ...
   ┌─────────────────────────────────────────────────────────┐
   │ ●  Bulk actions on the relation tabs — Waiting on you   │
   │ ◐  SSO redirect loops … — Working                       │
   │ ✓  Replace the deprecated auth helper — Finished        │
   ├─────────────────────────────────────────────────────────┤
   │ Open Styr                                               │
   │ Quit Styr                                               │
   └─────────────────────────────────────────────────────────┘
```

The menu lists at most 8 agents, most urgent first — waiting, then working, ready, finished, and
most recently changed within each. Anything beyond that collapses into a **“N more — open Styr”** entry, so an agent that needs you
can never be pushed off the list by finished ones.

Clicking an agent brings the app forward and focuses that task's terminal tab — the same action as
clicking its row in the sidebar. If the session is no longer running it resumes the chat instead. A **native notification** fires when
an agent starts waiting on you — once per transition, so a turn that stays blocked does not nag.

### Terminal tabs

The terminal sits under the board and takes the same width, so the Agents sidebar stays visible
alongside it. The ⇕ button expands it to fill the whole board area and back; drag its top edge for
anything in between. `+ Shell` and the expand button stay pinned while the tabs scroll.

Drag a tab to reorder the strip. Each tab's dot shows that session's **agent state** — blue and
pulsing while working, amber when it needs you, green when finished, grey for a plain shell. The
active tab is marked by its underline, so the dot is free to carry status.

A task's tab is named after the task, with its id beside it — `SSO redirect loops… TASK-0001` —
and follows the task if you rename it. Long titles are cut short; hover a tab for the full name. A
reopened past chat reads `TASK-0001 · replay`, so it can't be mistaken for the live session. Plain
shells keep their plain label. Focusing a tab from the sidebar, the menu bar or ⌘P scrolls it into
view.

### The Agents sidebar

Every task with a Claude chat gets a row in the **Agents** sidebar on the right — state, task title,
Claude's last message, and how long since it changed.

Each row also shows the **git branch** of the directory that agent is working in — the worktree
branch for a worktree task, otherwise whatever the repo is currently on. It is read from `.git/HEAD`
on each refresh rather than by shelling out to git, so it stays current if the agent switches
branches mid-session. A detached HEAD shows a short SHA. **Waiting sorts to the top**, because it is the
one state that costs you time if you miss it; the status bar's **Agents** item carries an amber count
when anything is waiting, so you see it with the sidebar closed.

A task that reaches **Done** drops out of the list, whatever its agent was last doing. A finished
session usually leaves behind a `Notification` event while it sits at an idle prompt, so without
this a completed task would read _Waiting on you_ forever. The same rule applies to the menu bar and
to the waiting count in the status bar. A follow-up run on a Done task is still visible through its
terminal tab, whose dot shows live state.

Clicking a row focuses that task's terminal tab if the session is still live (marked `live`),
otherwise it resumes the chat. **Open** jumps to the task itself. Hide the sidebar with the ✕ or the
status bar.

The hook commands are plain POSIX shell — no `node` or `jq` on PATH required — and write via a temp
file plus rename, so the watcher never sees a half-written file.

### Worktrees

Tick **Run this task in its own git worktree** on a task and its first session gets a separate
checkout instead of sharing the repository:

```
~/Workspace/acme                     ← your repo, untouched
~/Workspace/acme.worktrees/TASK-0004 ← this task, on branch styr/TASK-0004
```

Worktrees sit beside the repo rather than inside it, so they never appear as untracked files and
need no `.gitignore` entry. Resuming a task returns to the same checkout, so work in progress is
preserved, and the prompt tells Claude it is on a branch in a dedicated worktree and must not touch
the main checkout.

If the working directory is not a git repository the session still starts — in the plain directory,
with the reason recorded in the task activity log rather than failing silently.

**Remove** in the task dialog deletes the checkout (and any uncommitted work in it) but keeps the
branch.

### Chat history

Every run on a task is recorded, so nothing is lost when a later run starts a fresh conversation —
a review in particular. The task dialog lists them newest first:

```
Review the work   [continues next]        [Open]
30/09/2026, 15:20 · 9f3c1a2b

Implement the task                        [Open]
30/09/2026, 11:00 · 1a2b3c4d

Spec the task                             [Open]
30/09/2026, 08:10 · 1a2b3c4d
```

**Open** reopens that conversation in a terminal so you can read back what it did — it resumes bare,
with no prompt, so it starts no new work. `continues next` marks the chat the next run will carry
on. **Forget current chat** clears only that pointer; the history stays.

### Resuming the same chat

The first launch generates a session id, stores it on the task as `claudeSessionId`, and starts
Claude with it:

```sh
claude --session-id <uuid> "$(cat …/prompts/TASK-0004.txt)"
```

Every launch after that resumes the same conversation instead of starting over:

```sh
claude --resume <uuid>
```

So you can close the app, come back tomorrow, and pick up the chat where you left it — the id lives
in the task file, not in app memory. The card button reads **▶ Claude** for a task that has never
been started and **⏵ Resume** once it has.

Resuming is checked against disk, not just the stored id: the app looks for the transcript at
`~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`. If you have cleared your Claude history the
launch quietly falls back to a fresh start rather than failing.

To deliberately start over, open the task and hit **Forget** next to the Claude session. The next
launch gets a new id and re-sends the full prompt.

If a terminal tab for that task is already open, ▶ Claude focuses it rather than starting a second
Claude on the same work. Close the tab to get a new one — it will still resume the same chat.

### Context files

Attach files to a task with **Add files…** in the task dialog (it opens in the task's working
directory). Their paths go into the prompt under a `## Context files` heading, so Claude reads them
before it starts:

```
## Context files
Read these before you start:
- /Users/you/Workspace/acme/src/auth/session.ts
- /Users/you/Workspace/acme/docs/sso.md
```

Nothing is copied — only the paths travel, so the files stay the single copy on disk and Claude sees
whatever is current when it reads them. Cards show `◎ n` when a task has attachments.

Place `{{contextFiles}}` wherever you want the block to land in a template; it collapses to nothing
when a task has no attachments. If a template omits the placeholder entirely, the block is appended
at the end — attachments always reach Claude.

### The board protocol

Every prompt also carries a **Board protocol** section explaining how to move the task: which
`status:` values are valid, when to set `in_progress` and `in_review`, and where activity notes go.
It is rendered in, not written into each template, so an old or hand-edited template can never leave
an agent with no way to report progress — which is how a task ends up finished but still sitting in
Backlog.

Position it with `{{board}}` if you want it somewhere specific; otherwise it is appended.

### The prompt follows the column

A task in **In Review** does not need implementing — it needs reviewing. So the template is chosen
from where the task sits, not from a single global default:

| Task state                           | Template that runs                                                            |
| ------------------------------------ | ----------------------------------------------------------------------------- |
| `readiness: needs_spec` (any column) | **Spec the task** — wayfinder, or grilling you until the scope is pinned down |
| Backlog / In Progress                | **Implement the task**                                                        |
| In Review                            | **Review the work** — check the diff or PR against the acceptance criteria    |
| Done                                 | **Follow up** — confirm it landed, capture leftovers as new tasks             |

Starting Claude on a **Backlog** task moves it to **In Progress** — including when it only needs a
spec, because writing the spec is work and the board should say so. Status and readiness are
separate axes: a task can be `in_progress` while still `needs_spec`. Launching on In Review or Done
leaves the column alone, since those are a review and a follow-up rather than new work.

**Needs spec beats the column**, so unspecified work always gets specced before anyone builds it.
Mark a task **Needs spec** in the task dialog and it shows an amber `needs spec` badge on the board.

Remap any of this under **Which prompt runs where** in Settings. A task can also pin one template
for good — set **Prompt template** on the task to anything other than _Auto_, and it ignores the
column. Hovering ▶ Claude names the template that will actually run.

Templates support `{{id}}`, `{{title}}`, `{{description}}`, `{{status}}`, `{{priority}}`,
`{{readiness}}`, `{{project}}`, `{{tags}}`, `{{contextFiles}}`, `{{filePath}}` and `{{repoPath}}`
(which resolves to the directory Claude will really start in). **Preview prompt** in the task dialog shows exactly what
will be sent.

The session also gets `STYR_TASK_ID` in its environment, so a session started from a task
knows which task it is on.

## How agents move tasks

The markdown file is the board. Claude moves a task by editing one line of its frontmatter:

```yaml
status: in_review # backlog | in_progress | in_review | done
```

The file watcher picks it up and the column changes. This needs no setup at all — the task's path is
already in the prompt as `{{filePath}}`, and it works in any session, connected MCP server or not.
The shipped templates instruct Claude this way.

Parsing is deliberately forgiving about the slips a hand-edit invites: `In Review`, `in-progress`
and `IN_REVIEW` all resolve. A value that is genuinely not a status (`shipped`) leaves the file
**completely untouched** and shows the task in an amber banner at the top of the board rather than
guessing. Nothing on disk is ever rewritten to recover from a bad edit.

Notes work the same way — append a bullet under `## Activity` at the end of the file. Entries
without the canonical `` `timestamp` **author** — `` prefix are kept verbatim and survive later
writes.

[The MCP server](#the-mcp-server) does all of this too, with validation. Use it when you want Claude to _query_
the board (what is in review? what needs a spec?) rather than just update the task in front of it.

## The MCP server

Register the bundled MCP server once (Settings shows the exact command for your install):

```sh
yarn build
claude mcp add styr --scope user -- node /path/to/styr/out/main/mcp/index.mjs
```

Tools: `list_tasks`, `get_task`, `create_task`, `update_task`, `set_task_status`, `add_task_note`,
`delete_task`. `create_task` and `update_task` both take `contextFiles`, so Claude can attach
files it finds to a task. `list_tasks` filters on `readiness`, and `update_task` sets it — that is how a
specking session promotes a task from `needs_spec` to `ready` when it is done. Notes are attributed to `claude` unless `STYR_MCP_AUTHOR` says otherwise.

The server reads the same `~/.styr/config.json` the app does, so it always targets the
workspace you have configured.

## Orchestrate

**Orchestrate** in the header starts work on everything that is waiting, up to the capacity you set.
It does not decide _what_ an agent does — prompt routing already does that — it only decides _which_
tasks to start:

| Lane             | Picks up                           |
| ---------------- | ---------------------------------- |
| **Specifying**   | Backlog tasks flagged `needs_spec` |
| **Implementing** | Ready tasks in Backlog             |
| **Reviewing**    | Tasks sitting in In Review         |

Each lane has its own slot count under **Settings → Orchestrate**; a slot is taken while a task has
a live session. Set a lane to `0` to have Orchestrate skip it. The button shows how many it would
start and, when it would start none, hovering says why — no free slots, tasks opted out, or nothing
with a working directory.

Within a lane, the highest priority goes first, then board order.

**You can see what it will do before clicking.** Every task Orchestrate would start is marked on the
board with a numbered badge in dispatch order and an accent border, so the count on the button is
never a mystery. Clicking asks for confirmation first, listing each task with its lane and the slots
you will be using afterwards — it starts nothing until you confirm, and it starts exactly the tasks
it listed.

**A review always starts a fresh Claude session**, not the one that wrote the code — an author
reviewing their own conversation is a much weaker check, and the reviewer should read the branch
rather than its own memory of writing it. The other lanes resume the task's existing chat.

Every Orchestrate launch sends its prompt, including when it resumes. A bare `--resume` submits
nothing, so a dispatched agent would otherwise sit at a prompt with no instruction. The manual
**⏵ Resume** button still resumes bare, because there you just want to carry on talking.

**Every task is orchestrated by default.** Untick _Let Orchestrate start this task_ on a task to keep
its hands off; you can still start that one yourself.

Two things Orchestrate deliberately will not do:

- **Touch a task already In Progress**, even if its session has died. That task belongs to whoever
  started it, and restarting it could redo work someone is part-way through.
- **Start a task with no working directory**, which would otherwise run in the board's own folder
  where there is no code.

## Settings

Grouped into sections down the left of the dialog:

| Section            | What's in it                                              |
| ------------------ | --------------------------------------------------------- |
| **Workspace**      | Board storage folder, default working directory           |
| **Terminal**       | Shell, Claude command                                     |
| **Prompt routing** | Which template runs for each column, and the fallback     |
| **Orchestrate**    | Slots per lane                                            |
| **Templates**      | Editing the prompts themselves, with the placeholder list |
| **Theme**          | Colours and fonts                                         |
| **Integrations**   | The `claude mcp add` command, with a copy button          |
| **Updates**        | Current version, Check for updates, automatic checks      |

## Updates

Styr checks for a new release when it opens and every six hours after. A new version downloads in
the background and installs the next time you quit, so it never interrupts an agent mid-turn. While
one is waiting, the status bar shows **Restart to update to x.y.z**; restarting asks first if any
terminals are open, since agents running in them stop (their chats can be resumed afterwards).

**Settings → Updates** shows the current version and the updater's status, has a **Check for
updates** button, and turns the automatic checks off. Running from source (`yarn dev`) never
updates itself.

## Theme

**Settings → Theme** applies as you drag. The whole app repaints behind the dialog, so you can judge
a combination before committing — **Save settings** keeps it, closing without saving puts the old
theme back. **Reset to defaults** sits beside the presets, where the experimenting happens.

Colours use an in-app picker: a saturation/lightness field, a hue strip, and an **eyedropper** for
sampling any pixel on screen — handy for matching a brand colour. It is deliberately not the
browser's `<input type="color">`, which opens the native macOS colour panel: that floats above the
app and cannot be dismissed by clicking away from it.

| Setting                                      | What it affects                                                                                                                                               |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Base**                                     | Every surface and text colour in the app                                                                                                                      |
| **Gradient background**                      | Washes the base with a hint of the accent                                                                                                                     |
| **Accent**                                   | Buttons, active states, search focus, queue badges, project chips                                                                                             |
| **Backlog / In Progress / In Review / Done** | Column dots and rules, card borders, **and the matching agent states** — In Progress tints _Working_, In Review tints _Waiting on you_, Done tints _Finished_ |
| **Interface font**                           | The whole UI                                                                                                                                                  |
| **Terminal font / size**                     | The embedded terminal, applied to open sessions without restarting them                                                                                       |
| **Terminal colours**                         | The 16 ANSI colours programs draw with, plus a preset to start from                                                                                           |

**Base** is one colour, not ten. The interface derives its whole ramp from it — chrome, panels,
cards, borders and the three text weights — at fixed lightness steps, so contrast holds whatever you
pick. The base supplies hue and saturation and only nudges the overall lightness. Seven presets sit
under the picker (Harbour, Midnight, Graphite, Deep sea, Plum, Ember, Moss).

**Gradient background** has its own **Strength** and **Angle** — strength scales both the accent
wash and how far the base shifts, angle turns the linear sweep. At 0% it disappears without needing
the checkbox.

**Terminal colours** are the 16 slots a program picks from — the red in a failing test, the green in
a diff, the blue in your prompt. These can't be derived from the base, because red has to stay red,
so they're stored outright: pick a preset (Default, Vivid, Muted, Mono), then click any of the 16
swatches to edit that one slot. Everything else about the terminal — its text, cursor and selection —
follows the base and accent automatically.

Open sessions repaint as you change them. Nothing restarts, so scrollback survives.

Each colour also takes a typed hex value, and the preview under the fields shows a real terminal
line — prompt, diff, warning — in your colours and font.

Every colour resolves through one CSS variable per role, so a single change repaints the board, the
cards, the agents sidebar and the terminal tab dots together. **Reset theme to defaults** puts it
back.

## The status bar

A strip along the bottom of the window:

```
┌────────────────────────────────────────────────────────────┐
│ ▣ Agents 1   >_ Terminal 2    8 tasks · 1 running  ⚙ Settings │
└────────────────────────────────────────────────────────────┘
```

**Agents** and **Terminal** toggle their panels and highlight when open; Agents shows an amber count
when sessions are waiting on you, Terminal shows how many sessions are running. **Settings** sits on
the right.

The terminal opens at 45% of the window height. Drag its top edge to resize — once you do, that
height sticks and later toggles stop resetting it.

## Command palette

`⌘P` (or `⌘K`) opens a fuzzy finder over everything the app can reach:

| Group         | What it does                                                                     |
| ------------- | -------------------------------------------------------------------------------- |
| **Actions**   | New task, Orchestrate, new shell, toggle the terminal, toggle the Agents sidebar |
| **Tasks**     | `↵` opens the task, `⌘↵` starts Claude on it                                     |
| **Agents**    | Focus the running session, or resume it if the tab was closed                    |
| **Terminals** | Switch to that tab                                                               |
| **Settings**  | Jump straight to a section — Theme, Templates, Orchestrate, …                    |

Matching is subsequence-based with a bias toward prefixes and word boundaries, so `tmpl` finds
Templates and `0004` finds `TASK-0004`. `↑`/`↓` (or `⌃p`/`⌃n`) move, `↵` runs, `Esc` closes.

## Shortcuts

Every one of these is rebindable in **Settings → Shortcuts** — click **Change** on a row and press
the combination you want. These are the defaults:

| Key                | Action                                             |
| ------------------ | -------------------------------------------------- |
| `⌘P` or `⌘K`       | Command palette                                    |
| `⌘N`               | New task                                           |
| `⌘F`               | Focus search                                       |
| `⌘,`               | Open Settings                                      |
| ``⌃` `` or ``⌘` `` | Toggle the terminal panel                          |
| `⌘T`               | New terminal tab — only while a terminal has focus |

`⌘T` is scoped to the terminal, so it does nothing on the board; Settings marks such shortcuts
_in the terminal_. The command palette still opens a new tab from anywhere.

Toggle the agents sidebar and Orchestrate are commands too, but ship unbound — give them a key if
you use them often. **Clear** unbinds a command; **Reset** puts its default back.

Two keys are fixed because they are dialog behaviour rather than commands:

| Key   | Action                |
| ----- | --------------------- |
| `⌘↵`  | Save the open dialog  |
| `Esc` | Close the open dialog |

Bound keys work with focus in the terminal too — the embedded terminal hands them to the app instead
of forwarding them to the shell. `Esc`, `⌃C`, `⌃D`, `⌃L`, `⌃Z`, `↵` and `Tab` cannot be bound at
all, since they belong to whatever is running in there.

Mouse and terminal:

| Action                                 | What it does                           |
| -------------------------------------- | -------------------------------------- |
| Double-click a card                    | Edit the task                          |
| Hover a card → **Edit**                | Edit the task                          |
| Hover a card → **▶ Claude**            | Start Claude on that task              |
| `Shift+↵` / `Option+↵` in the terminal | Insert a newline instead of submitting |

#### Done means landed

A passing review does not move a worktree task to Done while its branch has commits that are not on
the base branch (the remote's default branch, else `main`/`master`, else the branch your main
checkout is on). The reviewer leaves the task in **In Review** and records the branch, the base and
the number of commits left to land in the Activity log. It offers a PR when the repo has a GitHub
remote and `gh` is installed, and otherwise tells you to merge or push by hand — it never assumes a
host. A failing review is unchanged: back to In Progress with the required fixes.

Styr also watches for the merge itself. When an In Review task's branch lands on the base — a normal,
fast-forward, squash or rebase merge, seen against the local base or `origin/<base>` — it moves to
Done on its own, whatever host you use. For squash and rebase merges, where the commits are not
reachable from the base, "landed" means every file the branch changed since its merge-base is
identical on the base.

Once a task is Done because its work landed, Styr removes what it left behind: the worktree
(`git worktree remove`, never forced), the local branch `styr/<id>` and the remote branch if it still
exists with the same tip. A worktree with uncommitted or untracked changes is left alone, and so is
its branch; a branch whose work cannot be shown to be on the base is kept. Each outcome is noted in
Activity, and `worktreePath` is cleared once the worktree is gone so the next launch makes a fresh
one. Tasks without a worktree are untouched by all of this: there is no branch to compare, so the
reviewer simply asks you before setting Done.

Custom or older saved review templates keep their own wording, but the board protocol appended to
every prompt carries the same "Done only when landed" rule.
