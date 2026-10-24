import { useCallback, useEffect, useState, type ReactNode } from 'react'
import {
  globalSettingsFor,
  workspaceSettingsFor,
  type Settings,
  type SettingsChange,
  DEFAULT_WORKSPACE_ID,
  type ThemeSettings
} from '@core/types.js'
import { formatAccelerator } from '@core/shortcuts.js'
import type { Workspaces } from '../../hooks/useWorkspaces.js'
import { useWorkspaceTarget } from '../../hooks/useWorkspaceTarget.js'
import {
  SETUP_STEPS,
  SETUP_TITLES,
  changedKeyCount,
  dirtySteps,
  markSetupSeen,
  type SetupMode
} from '../../lib/setupWizard.js'
import { workspaceColor } from '../../lib/workspaceColor.js'
import { ipcMessage } from '../../lib/ipcMessage.js'
import { CloseIcon } from '../icons.js'
import { Button, Modal } from '../ui.js'
import { AgentsStep, DispatchStep, ReviewStep, ThemeStep, WorkspaceStep } from './SetupSteps.js'

const LAST = SETUP_STEPS.length - 1

/**
 * The setup wizard: Welcome to Styr the first time, Quick setup when reopened from the palette.
 * It edits a draft of the same settings the Settings dialog does and writes them once, on the last
 * step, so closing early changes nothing. Quick setup can pick any workspace; the first run is
 * always the open one.
 */
export function SetupWizard({
  mode,
  settings,
  workspaces,
  onSave,
  onPreviewTheme,
  onClose
}: {
  mode: SetupMode
  settings: Settings
  workspaces: Workspaces
  onSave: (change: SettingsChange) => Promise<void>
  /** Applies the draft theme to the live app so a choice can be judged before it is saved. */
  onPreviewTheme: (theme: ThemeSettings | null) => void
  onClose: () => void
}): ReactNode {
  const first = mode === 'first-run'
  const [draft, setDraft] = useState<Settings>(settings)
  const [step, setStep] = useState(0)
  const [furthest, setFurthest] = useState(0)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const target = useWorkspaceTarget({ settings, workspaces, draft, setDraft, onLoaded: () => {} })
  const [name, setName] = useState(target.editedWorkspaceName)
  const workspaceId = target.editedWorkspaceId

  useEffect(() => setName(target.editedWorkspaceName), [workspaceId, target.editedWorkspaceName])

  const saved: Settings = { ...settings, ...target.savedWorkspaceSettings }
  const dirty = first ? new Set<string>() : dirtySteps(draft, saved)
  // The Default workspace keeps its name (`renameWorkspace` refuses it), so it is never renamed.
  const nameLocked = workspaceId === DEFAULT_WORKSPACE_ID
  const nameChanged = !nameLocked && name.trim() !== target.editedWorkspaceName
  const changes = changedKeyCount(draft, saved) + (nameChanged ? 1 : 0)
  const themeEdited =
    JSON.stringify(draft.theme) !== JSON.stringify(target.savedWorkspaceSettings.theme)
  const previewed = target.editingActiveWorkspace && themeEdited ? draft.theme : null
  useEffect(() => {
    onPreviewTheme(previewed)
  }, [previewed, onPreviewTheme])

  const patch = useCallback(
    (changes: Partial<Settings>): void => setDraft((current) => ({ ...current, ...changes })),
    []
  )
  const go = (index: number): void => {
    setStep(index)
    setFurthest((value) => Math.max(value, index))
  }

  const id = SETUP_STEPS[step]!.id
  const isLast = step === LAST
  const blocked = id === 'workspace' && name.trim() === ''
  const reach = first ? furthest : LAST

  function close(): void {
    if (
      !first &&
      changes > 0 &&
      !window.confirm(
        `Close Quick setup and discard ${changes} unsaved change${changes === 1 ? '' : 's'}?`
      )
    )
      return
    markSetupSeen()
    onClose()
  }

  async function apply(): Promise<void> {
    if (saving) return
    setError('')
    setSaving(true)
    try {
      await onSave({
        workspaceId,
        workspace: workspaceSettingsFor(draft),
        global: globalSettingsFor(draft)
      })
      if (nameChanged)
        workspaces.apply(await window.api.workspaces.rename(workspaceId, name.trim()))
      markSetupSeen()
      onClose()
    } catch (failure) {
      setError(ipcMessage(failure))
      setSaving(false)
    }
  }

  function next(): void {
    if (blocked || saving) return
    if (isLast) void apply()
    else go(step + 1)
  }

  const scope =
    id === 'review'
      ? 'Early features are shared by every workspace.'
      : `Stored in the ${name.trim() || 'this'} workspace folder.`

  const picker = first ? null : (
    <div className="flex flex-col gap-1.5">
      <span className="text-[12px] font-semibold text-dim">Set up</span>
      <div className="flex flex-wrap gap-1.5">
        {target.workspaces.map((workspace) => {
          const on = workspace.id === workspaceId
          return (
            <button
              key={workspace.id}
              type="button"
              aria-pressed={on}
              onClick={() => target.choose(workspace.id)}
              className={`inline-flex h-7 items-center gap-[7px] rounded-[7px] border px-2.5 text-[12px] font-medium transition-colors hover:text-ink ${
                on ? 'border-accent bg-accent/15 text-ink' : 'border-edge-strong text-dim'
              }`}
            >
              <span
                style={{ backgroundColor: workspaceColor(workspace.id) }}
                className="size-2 rounded-[3px]"
              />
              {workspace.name}
            </button>
          )
        })}
      </div>
      {target.requestedWorkspaceId ? (
        <p
          role="status"
          className="flex flex-wrap items-center gap-2 text-[11.5px] text-col-review-text"
        >
          Switching discards your unsaved changes.
          <Button className="h-6 px-2 text-[11.5px]" onClick={target.confirmDiscard}>
            Discard
          </Button>
          <Button variant="subtle" className="h-6 px-2 text-[11.5px]" onClick={target.cancelSwitch}>
            Stay
          </Button>
        </p>
      ) : null}
      {target.notice ? <p className="text-[11.5px] text-faint">{target.notice}</p> : null}
    </div>
  )

  return (
    <Modal title={SETUP_TITLES[mode]} onClose={close} onSubmit={next} bare backdropCloses={false}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={SETUP_TITLES[mode]}
        className="flex min-h-0 flex-1 flex-col"
      >
        <header className="flex items-center gap-3.5 border-b border-edge py-3.5 pl-6 pr-3.5">
          <h2 className="whitespace-nowrap text-[15px] font-semibold tracking-[-0.01em]">
            {SETUP_TITLES[mode]}
          </h2>
          <ol className="m-0 flex min-w-0 flex-1 list-none flex-wrap items-center gap-1 p-0">
            {SETUP_STEPS.map((item, index) => {
              const current = index === step
              const done = first && index < step
              const locked = index > reach
              return (
                <li key={item.id} className="flex">
                  <button
                    type="button"
                    disabled={locked}
                    aria-current={current ? 'step' : undefined}
                    onClick={() => go(index)}
                    className={`inline-flex h-6 items-center gap-1.5 rounded-[7px] px-2 text-[12px] font-medium transition-colors enabled:hover:text-ink disabled:cursor-default ${
                      current ? 'bg-raised text-ink' : locked ? 'text-faint/60' : 'text-dim'
                    }`}
                  >
                    <span
                      className={`grid size-4 place-items-center rounded-full border text-[10px] ${
                        current
                          ? 'border-[var(--color-accent-text)] text-ink'
                          : done
                            ? 'border-accent bg-accent text-[var(--color-on-accent)]'
                            : 'border-edge-strong text-faint'
                      }`}
                    >
                      {done ? '✓' : index + 1}
                    </span>
                    {item.label}
                    {dirty.has(item.id) ? (
                      <span
                        role="img"
                        aria-label="Has changes"
                        className="size-[5px] rounded-full bg-[var(--color-accent-text)]"
                      />
                    ) : null}
                  </button>
                </li>
              )
            })}
          </ol>
          <Button
            variant="subtle"
            className="size-7 shrink-0 p-0"
            aria-label="Close"
            onClick={close}
          >
            <CloseIcon size={14} />
          </Button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-8 py-[26px]">
          {id === 'workspace' ? (
            <WorkspaceStep
              mode={mode}
              name={name}
              nameLocked={nameLocked}
              onName={setName}
              picker={picker}
              draft={draft}
              patch={patch}
            />
          ) : null}
          {id === 'agents' ? <AgentsStep draft={draft} patch={patch} /> : null}
          {id === 'dispatch' ? <DispatchStep draft={draft} patch={patch} /> : null}
          {id === 'theme' ? <ThemeStep draft={draft} patch={patch} /> : null}
          {id === 'review' ? (
            <ReviewStep
              mode={mode}
              name={name.trim()}
              draft={draft}
              patch={patch}
              changes={changes}
              onEdit={(stepId) => go(SETUP_STEPS.findIndex((item) => item.id === stepId))}
              openPaletteHint={
                <>
                  Run this again any time from the command palette:{' '}
                  <kbd className="font-mono text-dim">{formatAccelerator('mod+k')}</kbd> → Quick
                  setup.
                </>
              }
            />
          ) : null}
        </div>

        <footer className="flex shrink-0 items-center gap-2 border-t border-edge bg-chrome/40 py-3 pl-6 pr-4">
          {step > 0 ? (
            <Button variant="subtle" className="h-[30px]" onClick={() => go(step - 1)}>
              ← Back
            </Button>
          ) : null}
          <span
            role={error ? 'alert' : undefined}
            className={`min-w-0 truncate text-[11.5px] ${error ? 'text-danger' : 'text-faint'}`}
            title={error || undefined}
          >
            {error || `Step ${step + 1} of ${SETUP_STEPS.length} · ${scope}`}
          </span>
          <div className="flex-1" />
          {!isLast ? (
            <Button variant="subtle" className="h-[30px] shrink-0" onClick={() => go(LAST)}>
              {first ? (step === 0 ? 'Skip setup' : 'Use defaults') : 'Skip to review'}
            </Button>
          ) : null}
          <Button
            variant="primary"
            className="h-[30px] shrink-0 gap-2 px-3.5"
            disabled={blocked || saving}
            onClick={next}
          >
            {isLast ? (first ? 'Open board' : 'Apply') : first ? 'Continue' : 'Next'} →
          </Button>
        </footer>
      </div>
    </Modal>
  )
}
