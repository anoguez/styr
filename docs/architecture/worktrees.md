# Worktrees

Moved from CLAUDE.md verbatim; read it before touching this area.

## Worktrees

A task's checkout has one front door, `core/taskCheckout.ts`. `taskCheckout(workspaceId, task)`
returns a `TaskCheckout` keyed by the task — `diff()`, `filePatch(path, full)`, `landing()` and
`removeWorktree()` — and decides the worktree/repository split once (`useWorktree !== false`: an
unset flag on an older task file still counts as a worktree task). `checkoutOf(workspaceId, task,
repoPath)` is the only place a task becomes a `Checkout`; `launch.ts` and `settleTasks` use it too,
and `ipc.ts` never builds one. The git a landing pass runs (`refListing`, `branchLanding`,
`cleanupLandedTask`) is the one adapter, `CheckoutGit`: `checkoutGit` is real git and
`landing.test.ts` fakes it. Diffs have no fake — nothing varies there, so their tests use real
repositories (`gitFixture.ts`).

Behind it, all in `src/core/`: `gitExec.ts` (private: the git runners, ref helpers, and the
`Checkout` value), `worktree.ts` (lifecycle and directory-level helpers: ensure, remove, branches,
`readGitBranch`, `findGitRoot`, `workingTreeSummary`), `worktreeLanding.ts` (`branchLanding`,
`cleanupLandedTask`, `refListing`) and `worktreeDiff.ts` (`taskDiff`, `taskFilePatch`). Outside
the cluster, reach the last two only through `taskCheckout.ts`. The landing rules (`settleTasks`, `LandingCache`,
`refsFingerprint`) are in `core/landing.ts`, run by `main/landing.ts` — see
[agents.md](agents.md).

A `Checkout` is `{repoPath, key, baseBranch?}`; the worktree path and branch derive from it
(`checkoutPath`, `branchNameFor`), so pass it instead of the loose triple. `ensureWorktree` is
idempotent so a resume lands in the same checkout. `Checkout.location` (`WorktreeLocation`) says
where: `beside` (the default, and every worktree made before the setting) is
`<repo>.worktrees/<key>`; `inside` is `<repo>/.styr/worktrees/<key>`, so the main checkout's
`node_modules` resolve from it. `ensureWorktree` hides `inside` worktrees with a `.gitignore` of `*`
in that folder — without it they would show as untracked files in the user's project.

The location comes from the workspace setting `worktreeLocation`, but only for a worktree yet to be
made: `checkoutOf` first matches the task's recorded `worktreePath` against both derivable paths
and keeps the one it was made at, so changing the setting never strands an existing worktree. A
`worktreePath` matching neither is ignored, never used as a path — cleanup must not be pointed at an
arbitrary directory by a hand-edited file. Callers pass the setting (`launch.ts`, `ipc.ts`'s
`activeTaskCheckout`, `LandingPorts.worktreeLocation`).

A new worktree branch starts, after a best-effort `git fetch`, from the remote tip of the branch the
main checkout is on (its upstream, else `origin/<current>`, else `origin/<base>`) — so `main` and
`release/x.y.z` checkouts both advance. The remote is used only when HEAD is strictly behind it;
unpushed commits or divergence keep HEAD, as does a failed fetch (offline). See `startPointFor`.

`Task.baseBranch` (the New task dialog's Base branch select, fed by `listBranches` over `git:branches`)
overrides that automatic choice: the worktree starts from the fetched `origin/<baseBranch>`, else the
local branch, and a branch that has since vanished falls back to the automatic start. Unset means
automatic. It is fixed once `worktreePath` exists, since the branch is already cut.

An automatic start still records a base: `ensureWorktree` reports the branch it cut from, and
`launchPatch` writes it to `Task.baseBranch` when that is unset. Without it the diff, the landing
check and the PR prompt fall back to `baseBranchFor` (the repository default), so a task started
from a `release/x.y.z` checkout would be measured against `main`.

Worktree failure is never fatal: `checkoutFor` in `launch.ts` falls back to the plain repository
and returns a `warning`, which `ipc.ts` writes to the task activity log. A blocked launch would be
worse than a shared working directory.

`WORKTREE_BRANCH_PREFIX` lives in `types/workspaces.ts` because `prompt.ts` needs it too, and `prompt.ts` is
imported by the renderer — it must not reach for `worktree.ts`, which uses `node:child_process`.

## Multi-repo tasks

A task may span several repositories: `Task.extraRepos` (`{repoPath, baseBranch?, worktreePath?,
prUrl?}`, max 5) sits beside `repoPath`, which stays the _primary_ repo — the session `cwd`. Every
single-repo reader (`repoPath`, `baseBranch`, `worktreePath`, `prUrl`, the index columns, the MCP
server) keeps meaning the primary, so a task without `extraRepos` is exactly the old task. It needs
`useWorktree`; without it `extraRepos` is ignored. Each repo has its own base branch, resolved like
the primary's (recorded by `launchPatch`, fixed once the worktree exists), and all share the branch
`styr/<key>`, each in its own repository.

- **Keys.** `checkoutsOf` (`taskCheckout.ts`) returns the primary then each extra as
  `{role, repoName, checkout}`; `taskCheckout` is the primary plus `repos`. Names are the folder, or
  `parent/folder` on a clash (`repoNames.ts`, pure: the prompt and the renderer use it).
- **Fixed after launch.** `updateTask` refuses to add or remove repositories once any worktree
  exists ("make a new task"); recording a launch's `worktreePath`/`baseBranch` on the same
  repositories is not a change. `markdown.ts` normalises hand edits (`normaliseExtraRepos`): one
  mapping or a bare string becomes a list, entries without a `repoPath`, repeats and the primary are
  dropped, trailing slashes trimmed, capped at 5. Whether a path is a git repo is checked at launch,
  not at parse: a non-repo falls back like any worktree failure, with a warning.
- **Launch.** `checkoutFor` ensures every worktree; a failure on any repo falls back to that repo's
  plain path with a warning naming it (joined with `; `) and never stops the session. An extra that
  fell back has no `worktreePath`, is shown in the Changes dialog as a plain-repository diff, and is
  not landable. Resume re-ensures every worktree.
- **Diffs.** `git:taskDiff` and `git:filePatch` take an optional trailing `repo` (a `repoPath`),
  resolved against `checkoutsOf` — a repo that is not the task's is refused. `git:diffStats` sums all
  repos for the card and lists each in `DiffStat.repos` for the tooltip.
- **Landing.** `settleTasks` evaluates a multi-repo task with `settleMultiRepo`: Done only when every
  _counted_ repo (the primary, and each extra with a worktree) has landed or has no commits of its
  own, and at least one really landed. Some landed, some not leaves it In Review with one note,
  "Landed: api. Not landed: client (3 commits ahead of main)", deduped by `isRepeatNote`. Nothing is
  rolled back. On Done each repo is cleaned on its own (a refusal in one is a note and does not
  block the rest); `clearWorktree` (with `extras`) clears every recorded path only when all repos
  were cleaned. The cache is keyed per task, its fingerprint is the status plus each repo's refs.
- **PRs.** The primary's PR is the top-level `prUrl`; an extra's is `extraRepos[i].prUrl`. MCP
  `update_task` merges `extraRepos[].prUrl` by `repoPath` and never replaces the list. "Create PR"
  (`createPullRequestsPrompt`) asks for one PR per repo, each with its own base and branch.
