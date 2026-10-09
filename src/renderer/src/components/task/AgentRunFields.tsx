import type { ReactNode } from 'react'
import { AGENT_PROVIDER_LABELS, type Settings, type Task } from '@core/types.js'
import { useBranches } from '../../hooks/useBranches.js'
import { worktreeHint, type TaskForm } from '../../lib/taskForm.js'
import { FolderIcon } from '../icons.js'
import { Select } from '../ui.js'
import { BOXED_CONTROL, SECTION_LABEL, Toggle } from './fields.js'

const BOXED_SELECT = `${BOXED_CONTROL} !h-[30px] !py-0 !text-[12.5px]`

/** How an agent runs the task: provider, prompt, folder, worktree and its base, and Dispatch. */
export function AgentRunFields({
  form,
  patch,
  task,
  taskId,
  routedName,
  settings,
  onClose
}: {
  form: TaskForm
  patch: (changes: Partial<TaskForm>) => void
  task: Task | null
  /** The task's id, or a placeholder before the first save. */
  taskId: string
  /** The template the column routes to. */
  routedName: string
  settings: Settings
  /** Removing the worktree changes the task on disk, so the dialog closes after. */
  onClose: () => void
}): ReactNode {
  const { info: branchInfo, loaded } = useBranches(form.repoPath, form.useWorktree)
  return (
    <div className="flex flex-col gap-3">
      <span className={SECTION_LABEL}>Agent run</span>
      <div className="flex flex-col gap-[5px]">
        <span className="text-[12px] text-dim">Provider</span>
        <Select
          aria-label="Provider"
          className={BOXED_SELECT}
          value={form.provider}
          onChange={(event) => patch({ provider: event.target.value as 'claude' | 'codex' })}
        >
          {settings.enabledProviders.map((item) => (
            <option key={item} value={item}>
              {AGENT_PROVIDER_LABELS[item]}
            </option>
          ))}
        </Select>
      </div>
      <div className="flex flex-col gap-[5px]">
        <span className="text-[12px] text-dim">Agent prompt</span>
        <Select
          aria-label="Prompt template"
          className={BOXED_SELECT}
          value={form.promptTemplateId}
          onChange={(event) => patch({ promptTemplateId: event.target.value })}
        >
          <option value="">Auto — {routedName}</option>
          {settings.promptTemplates.map((template) => (
            <option key={template.id} value={template.id}>
              {template.name}
            </option>
          ))}
        </Select>
        <span className="text-[11px] leading-[1.4] text-faint">
          {form.promptTemplateId
            ? 'Pinned — used whatever column the task is in.'
            : `Follows the column. Currently runs ${routedName}.`}
        </span>
      </div>
      <div className="flex flex-col gap-[5px]">
        <span className="text-[12px] text-dim">Working directory</span>
        <div className="flex h-[30px] items-center gap-1.5 rounded-[7px] border border-edge-strong bg-chrome pl-2.5 pr-1 focus-within:border-accent">
          <input
            aria-label="Working directory"
            value={form.repoPath}
            placeholder="/Users/you/Workspace/project"
            title={form.repoPath}
            onChange={(event) => patch({ repoPath: event.target.value })}
            className="min-w-0 flex-1 bg-transparent font-mono text-[11.5px] text-ink outline-none placeholder:text-faint"
          />
          <button
            type="button"
            aria-label="Browse"
            onClick={() => {
              void window.api.settings.pickDirectory(form.repoPath || undefined).then((picked) => {
                if (picked) patch({ repoPath: picked })
              })
            }}
            className="inline-flex size-[22px] shrink-0 items-center justify-center rounded-[5px] text-dim hover:bg-raised hover:text-ink"
          >
            <FolderIcon />
          </button>
        </div>
      </div>
      {!form.repoPath.trim() && !settings.defaultRepoPath ? (
        <span className="text-[11.5px] text-dim">
          No working directory set: the agent runs in the workspace folder.
        </span>
      ) : null}
      <Toggle
        checked={form.useWorktree}
        onChange={(useWorktree) => patch({ useWorktree })}
        label="Own git worktree"
        hint={worktreeHint(form, taskId, loaded && branchInfo.branches.length === 0)}
      />
      {form.useWorktree && form.repoPath ? (
        <div className="flex flex-col gap-1">
          <Select
            aria-label="Base branch"
            value={form.baseBranch}
            disabled={Boolean(task?.worktreePath)}
            onChange={(event) => patch({ baseBranch: event.target.value })}
          >
            <option value="">
              {branchInfo.current ? `Current branch (${branchInfo.current})` : 'Current branch'}
            </option>
            {branchInfo.branches.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </Select>
          <span className="text-[11px] text-dim">
            {task?.worktreePath
              ? 'Fixed once the worktree exists.'
              : 'The worktree branches from the latest origin tip of this branch.'}
          </span>
        </div>
      ) : null}
      <Toggle
        checked={form.orchestrate}
        onChange={(orchestrate) => patch({ orchestrate })}
        label="Dispatch can start it"
        hint={
          form.orchestrate ? 'You can still start it yourself.' : 'Only you can start this task.'
        }
      />
      {task?.worktreePath && form.useWorktree ? (
        <div className="-mt-1 flex items-center gap-1.5 rounded-[7px] border border-edge bg-chrome py-1.5 pl-2.5 pr-1.5">
          <span
            title={task.worktreePath}
            className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-dim"
          >
            {task.worktreePath}
          </span>
          <button
            type="button"
            title="Deletes the checkout and uncommitted work. The branch is kept."
            className="h-5 shrink-0 rounded-[5px] px-1.5 text-[11px] font-medium text-red-300 hover:bg-red-400/10"
            onClick={() => {
              void window.api.tasks.removeWorktree(task.id).then(onClose)
            }}
          >
            Remove
          </button>
        </div>
      ) : null}
    </div>
  )
}
