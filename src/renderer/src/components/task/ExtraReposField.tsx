import type { ReactNode } from 'react'
import { MAX_EXTRA_REPOS, type ExtraRepo } from '@core/types.js'
import { useBranches } from '../../hooks/useBranches.js'
import { PathBrowse } from '../PathBrowse.js'
import { FolderIcon } from '../icons.js'
import { Select } from '../ui.js'

/**
 * The other repositories a worktree task spans, beside the Directory above (the primary, where the
 * agent starts). Each gets its own worktree on the task branch and its own base branch. Fixed once
 * the task has launched: the branches are already cut, so a repository added later is a new task.
 */
export function ExtraReposField({
  repos,
  primary,
  fixed,
  defaultPath,
  onChange
}: {
  repos: ExtraRepo[]
  primary: string
  /** The task already has its worktrees. */
  fixed: boolean
  defaultPath: string
  onChange: (repos: ExtraRepo[]) => void
}): ReactNode {
  const update = (index: number, changes: Partial<ExtraRepo>): void =>
    onChange(repos.map((repo, at) => (at === index ? { ...repo, ...changes } : repo)))
  return (
    <div className="flex flex-col gap-1.5" aria-label="More repositories">
      {repos.map((repo, index) => (
        <ExtraRepoRow
          // The list is edited in place and never reordered, so the position is the identity.
          key={index}
          repo={repo}
          primary={primary}
          others={repos.filter((_, at) => at !== index)}
          fixed={fixed}
          defaultPath={defaultPath}
          onChange={(changes) => update(index, changes)}
          onRemove={() => onChange(repos.filter((_, at) => at !== index))}
        />
      ))}
      {fixed ? (
        repos.length > 0 ? (
          <span className="text-[11px] leading-[1.4] text-faint">
            Repositories are fixed once the task has launched. Make a new task for another one.
          </span>
        ) : null
      ) : repos.length < MAX_EXTRA_REPOS ? (
        <button
          type="button"
          onClick={() => onChange([...repos, { repoPath: '' }])}
          className="h-6 self-start rounded-[5px] px-1.5 text-[11px] font-medium text-dim hover:bg-raised hover:text-ink"
        >
          + Add repository
        </button>
      ) : (
        <span className="text-[11px] text-faint">At most {MAX_EXTRA_REPOS} more repositories.</span>
      )}
    </div>
  )
}

const sameFolder = (a: string, b: string): boolean =>
  a.trim().replace(/[\\/]+$/, '') === b.trim().replace(/[\\/]+$/, '')

function ExtraRepoRow({
  repo,
  primary,
  others,
  fixed,
  defaultPath,
  onChange,
  onRemove
}: {
  repo: ExtraRepo
  primary: string
  others: ExtraRepo[]
  fixed: boolean
  defaultPath: string
  onChange: (changes: Partial<ExtraRepo>) => void
  onRemove: () => void
}): ReactNode {
  const { info, loaded } = useBranches(repo.repoPath, true)
  const path = repo.repoPath.trim()
  const problem = !path
    ? undefined
    : sameFolder(path, primary) || others.some((other) => sameFolder(other.repoPath, path))
      ? 'Already part of this task: it is left out.'
      : loaded && info.branches.length === 0
        ? 'Not a git repository: it is left out.'
        : undefined
  return (
    <div className="flex flex-col gap-1">
      <div className="flex h-7 items-center gap-1 rounded-[7px] border border-transparent pl-2 pr-[3px] hover:border-edge hover:bg-card focus-within:border-accent focus-within:bg-chrome">
        <input
          aria-label="Repository"
          value={repo.repoPath}
          readOnly={fixed}
          placeholder="Path to another repository"
          title={repo.worktreePath ?? repo.repoPath}
          onChange={(event) => onChange({ repoPath: event.target.value })}
          className="min-w-0 flex-1 bg-transparent font-mono text-[11.5px] text-ink outline-none placeholder:text-faint"
        />
        {fixed ? null : (
          <>
            <PathBrowse
              kind="folder"
              title="Choose a repository"
              start={repo.repoPath || primary || defaultPath}
              onPick={([picked]) => {
                if (picked) onChange({ repoPath: picked })
              }}
            >
              {(browse, disabled) => (
                <button
                  type="button"
                  aria-label="Browse"
                  disabled={disabled}
                  onClick={browse}
                  className="inline-flex size-[22px] shrink-0 items-center justify-center rounded-[5px] text-dim hover:bg-raised hover:text-ink disabled:pointer-events-none disabled:opacity-40"
                >
                  <FolderIcon />
                </button>
              )}
            </PathBrowse>
            <button
              type="button"
              aria-label="Remove repository"
              onClick={onRemove}
              className="inline-flex size-[22px] shrink-0 items-center justify-center rounded-[5px] text-dim hover:bg-raised hover:text-danger"
            >
              ×
            </button>
          </>
        )}
      </div>
      {path && !problem && info.branches.length > 0 ? (
        <div className="flex items-center gap-1.5 pl-2 text-[11px] text-faint">
          <span>from</span>
          {fixed || repo.worktreePath ? (
            <span className="font-mono text-dim">{repo.baseBranch || 'current branch'}</span>
          ) : (
            <Select
              compact
              aria-label="Base branch"
              value={repo.baseBranch ?? ''}
              onChange={(event) => onChange({ baseBranch: event.target.value || undefined })}
            >
              <option value="">
                {info.current ? `current (${info.current})` : 'current branch'}
              </option>
              {info.branches.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </Select>
          )}
        </div>
      ) : null}
      {repo.worktreePath || repo.prUrl ? (
        <input
          aria-label="Pull request URL"
          type="url"
          value={repo.prUrl ?? ''}
          placeholder="Pull request link (none yet)"
          title="Optional link to this repository's pull or merge request, on any host"
          onChange={(event) => onChange({ prUrl: event.target.value || undefined })}
          className="ml-2 h-6 min-w-0 rounded-[5px] border border-transparent bg-transparent px-1.5 font-mono text-[11px] text-ink outline-none placeholder:text-faint hover:border-edge focus:border-accent focus:bg-chrome"
        />
      ) : null}
      {problem ? (
        <span className="pl-2 text-[11px] leading-[1.4] text-[var(--color-col-review-text)]">
          {problem}
        </span>
      ) : null}
    </div>
  )
}
