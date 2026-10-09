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
idempotent so a resume lands in the same checkout. Worktrees are created beside the repo
(`<repo>.worktrees/<taskId>`) — inside it they would show as untracked files in the user's project.

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
