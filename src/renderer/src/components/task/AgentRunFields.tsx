import type { ReactNode } from 'react'
import { AGENT_PROVIDER_LABELS, type Settings, type Task } from '@core/types.js'
import { useBranches } from '../../hooks/useBranches.js'
import { PickerGuard } from '../PickerGuard.js'
import {
  inheritedModel,
  modelOptions,
  templateNames,
  worktreeHint,
  type TaskForm
} from '../../lib/taskForm.js'
import { BranchIcon, ChevronIcon, FolderIcon } from '../icons.js'
import { PROP_LABEL, PROP_ROW, PropertySelect, RowToggle, SECTION_LABEL } from './fields.js'

/** The Model field's hint: where the model comes from when it is left on Default. */
function modelHint(
  form: TaskForm,
  settings: Settings,
  inherited: string | undefined
): { text: string; title?: string } {
  const label = AGENT_PROVIDER_LABELS[form.provider]
  if (form.model) return { text: `Used whenever ${label} runs this task.` }
  if (inherited) return { text: `From ${templateNames(settings, form).effective}.` }
  return {
    text: `${label} runs its default model.`,
    title:
      settings.agentModels[form.provider].length > 0
        ? undefined
        : 'Register models in Settings → Agents to pick one.'
  }
}

/** How an agent runs the task: provider, model, prompt template, and whether Dispatch may start it. */
export function AgentFields({
  form,
  patch,
  routedName,
  settings
}: {
  form: TaskForm
  patch: (changes: Partial<TaskForm>) => void
  /** The template the column routes to. */
  routedName: string
  settings: Settings
}): ReactNode {
  const inherited = inheritedModel(settings, form)
  const model = modelHint(form, settings, inherited)
  return (
    <div className="flex flex-col gap-0.5">
      <span className={`${SECTION_LABEL} pb-1.5`}>Agent</span>
      <PropertySelect
        label="Provider"
        value={form.provider}
        options={settings.enabledProviders.map((item) => ({
          value: item,
          label: AGENT_PROVIDER_LABELS[item]
        }))}
        onChange={(provider) =>
          // A model is named for one CLI; carried over it would fail to start the other.
          patch(provider === form.provider ? { provider } : { provider, model: '' })
        }
      />
      <PropertySelect
        label="Model"
        value={form.model}
        options={[
          { value: '', label: inherited ? `Default — ${inherited}` : 'Default' },
          ...modelOptions(settings, form).map((name) => ({ value: name, label: name }))
        ]}
        hint={model.text}
        hintTitle={model.title}
        onChange={(model) => patch({ model })}
      />
      <PropertySelect
        label="Prompt"
        ariaLabel="Prompt template"
        value={form.promptTemplateId}
        options={[
          { value: '', label: `Auto — ${routedName}` },
          ...settings.promptTemplates.map((template) => ({
            value: template.id,
            label: template.name
          }))
        ]}
        hint={form.promptTemplateId ? 'Pinned — used in any column.' : 'Follows the column.'}
        hintTitle={
          form.promptTemplateId
            ? 'Used whatever column the task is in.'
            : `Moves with the task's column. Currently runs ${routedName}.`
        }
        onChange={(promptTemplateId) => patch({ promptTemplateId })}
      />
      <RowToggle
        checked={form.orchestrate}
        onChange={(orchestrate) => patch({ orchestrate })}
        label="Dispatch"
        state={form.orchestrate ? 'Can start it' : 'Manual only'}
        title={
          form.orchestrate
            ? 'Dispatch can start this task. You can still start it yourself.'
            : 'Only you can start this task.'
        }
      />
    </div>
  )
}

/** Where the agent runs: the working directory, and the worktree with its branch and base. */
export function WorkspaceFields({
  form,
  patch,
  task,
  taskId,
  settings,
  onClose
}: {
  form: TaskForm
  patch: (changes: Partial<TaskForm>) => void
  task: Task | null
  /** The task's id, or a placeholder before the first save. */
  taskId: string
  settings: Settings
  /** Removing the worktree changes the task on disk, so the dialog closes after. */
  onClose: () => void
}): ReactNode {
  const { info: branchInfo, loaded } = useBranches(form.repoPath, form.useWorktree)
  const notARepo = loaded && branchInfo.branches.length === 0
  const hint = worktreeHint(form, taskId, notARepo)
  // The worktree cannot be made as asked: say why in a few words, in full on hover.
  const warning = !form.useWorktree
    ? null
    : !form.repoPath
      ? 'Set a directory first.'
      : notARepo
        ? 'Not a git repository: runs in the folder.'
        : null
  const existing = form.useWorktree && task?.worktreePath ? task : null
  return (
    <div className="flex flex-col gap-0.5">
      <span className={`${SECTION_LABEL} pb-1.5`}>Workspace</span>
      <div className={`${PROP_ROW} h-8`}>
        <span className={PROP_LABEL}>Directory</span>
        <div className="flex h-7 items-center gap-1 rounded-[7px] border border-transparent pl-2 pr-[3px] hover:border-edge hover:bg-card focus-within:border-accent focus-within:bg-chrome">
          <input
            aria-label="Working directory"
            value={form.repoPath}
            placeholder={settings.defaultRepoPath || 'Workspace folder'}
            title={
              form.repoPath ||
              (settings.defaultRepoPath
                ? `Empty: runs in ${settings.defaultRepoPath}`
                : 'No working directory set: the agent runs in the workspace folder.')
            }
            onChange={(event) => patch({ repoPath: event.target.value })}
            className="min-w-0 flex-1 bg-transparent font-mono text-[11.5px] text-ink outline-none placeholder:text-faint"
          />
          <PickerGuard title="Choose a folder">
            {(disabled) => (
              <button
                type="button"
                aria-label="Browse"
                disabled={disabled}
                onClick={() => {
                  void window.api.settings
                    .pickDirectory(form.repoPath || undefined)
                    .then((picked) => {
                      if (picked) patch({ repoPath: picked })
                    })
                }}
                className="inline-flex size-[22px] shrink-0 items-center justify-center rounded-[5px] text-dim hover:bg-raised hover:text-ink disabled:pointer-events-none disabled:opacity-40"
              >
                <FolderIcon />
              </button>
            )}
          </PickerGuard>
        </div>
      </div>
      <RowToggle
        checked={form.useWorktree}
        onChange={(useWorktree) => patch({ useWorktree })}
        label="Worktree"
        state={form.useWorktree ? 'Own branch' : 'Run in directory'}
        title={hint}
      />
      {form.useWorktree ? (
        <div className="mt-1 flex flex-col gap-1.5 rounded-lg border border-edge bg-chrome py-2 pl-2.5 pr-2">
          <div className="flex min-w-0 items-center gap-1.5 font-mono text-[11px]">
            <span className="text-[var(--color-accent-text)]">
              <BranchIcon size={12} />
            </span>
            <span className="whitespace-nowrap text-[var(--color-accent-text)]">{`styr/${taskId}`}</span>
            {form.repoPath ? (
              <>
                <span className="text-faint">from</span>
                {task?.worktreePath ? (
                  <span
                    title="Fixed once the worktree exists"
                    className="min-w-0 truncate text-dim"
                  >
                    {form.baseBranch || 'current branch'}
                  </span>
                ) : (
                  <span className="relative inline-block min-w-0">
                    <select
                      aria-label="Base branch"
                      title="The worktree branches from the latest origin tip of this branch."
                      value={form.baseBranch}
                      onChange={(event) => patch({ baseBranch: event.target.value })}
                      className="h-[22px] max-w-full cursor-pointer appearance-none truncate rounded-[5px] border border-edge bg-card pl-1.5 pr-5 font-[family-name:var(--font-ui)] text-[11px] text-ink outline-none focus:border-accent"
                    >
                      <option value="" className="bg-chrome text-ink">
                        {branchInfo.current ? `current (${branchInfo.current})` : 'current branch'}
                      </option>
                      {branchInfo.branches.map((name) => (
                        <option key={name} value={name} className="bg-chrome text-ink">
                          {name}
                        </option>
                      ))}
                    </select>
                    <span className="pointer-events-none absolute right-[5px] top-1/2 -translate-y-1/2 text-faint">
                      <ChevronIcon size={10} />
                    </span>
                  </span>
                )}
              </>
            ) : null}
          </div>
          {existing ? (
            <div className="flex items-center gap-1.5">
              <span
                title={existing.worktreePath}
                className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-faint"
              >
                {existing.worktreePath}
              </span>
              <button
                type="button"
                title="Deletes the checkout and uncommitted work. The branch is kept."
                className="h-5 shrink-0 rounded-[5px] px-1.5 text-[11px] font-medium text-danger hover:bg-danger/10"
                onClick={() => {
                  void window.api.tasks.removeWorktree(existing.id).then(onClose)
                }}
              >
                Remove checkout
              </button>
            </div>
          ) : null}
          {warning ? (
            <span
              title={hint}
              className="text-[11px] leading-[1.4] text-[var(--color-col-review-text)]"
            >
              {warning}
            </span>
          ) : existing ? null : (
            <span className="text-[11px] leading-[1.4] text-faint">
              Created on first run from the latest origin tip, so parallel agents never share a
              checkout.
            </span>
          )}
        </div>
      ) : null}
    </div>
  )
}
