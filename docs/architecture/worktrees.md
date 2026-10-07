# Worktrees

Moved from CLAUDE.md verbatim; read it before touching this area.

## Worktrees

Git worktree code is split in four, all in `src/core/`: `gitExec.ts` (private: the git runners, ref
helpers, and the `Checkout` value), `worktree.ts` (lifecycle: ensure, remove, branches), `worktreeLanding.ts`
(`branchLanding`, `cleanupLandedTask`) and `worktreeDiff.ts` (`taskDiff`, `taskFilePatch`,
`workingTreeSummary`). A `Checkout` is `{repoPath, key, baseBranch?}`; the worktree path and branch derive
from it (`checkoutPath`, `branchNameFor`), so pass it instead of the loose triple. `ensureWorktree` is idempotent so a resume lands in the same
checkout. Worktrees are created beside the repo (`<repo>.worktrees/<taskId>`) — inside it they would
show as untracked files in the user's project.

A new worktree branch starts, after a best-effort `git fetch`, from the remote tip of the branch the
main checkout is on (its upstream, else `origin/<current>`, else `origin/<base>`) — so `main` and
`release/x.y.z` checkouts both advance. The remote is used only when HEAD is strictly behind it;
unpushed commits or divergence keep HEAD, as does a failed fetch (offline). See `startPointFor`.

`Task.baseBranch` (the New task dialog's Base branch select, fed by `listBranches` over `git:branches`)
overrides that automatic choice: the worktree starts from the fetched `origin/<baseBranch>`, else the
local branch, and a branch that has since vanished falls back to the automatic start. Unset means
automatic. It is fixed once `worktreePath` exists, since the branch is already cut.

Worktree failure is never fatal: `checkoutFor` in `launch.ts` falls back to the plain repository
and returns a `warning`, which `ipc.ts` writes to the task activity log. A blocked launch would be
worse than a shared working directory.

`WORKTREE_BRANCH_PREFIX` lives in `types.ts` because `prompt.ts` needs it too, and `prompt.ts` is
imported by the renderer — it must not reach for `worktree.ts`, which uses `node:child_process`.
