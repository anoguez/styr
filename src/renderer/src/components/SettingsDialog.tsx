import { useCallback, useEffect, useState, type ReactNode } from 'react'
import {
  type Settings,
  type SettingsChange,
  type ThemeSettings,
  type WorkspaceSettings,
  globalSettingsFor,
  workspaceSettingsFor
} from '@core/types.js'
import { formatAccelerator } from '@core/shortcuts.js'
import { Button, Chip, Eyebrow, Modal, Select } from './ui.js'
import { WorkspacesPane } from './WorkspacesPane.js'
import { SourcesPane } from './SourcesPane.js'
import { PresetsPane } from './PresetsPane.js'
import type { Workspaces } from '../hooks/useWorkspaces.js'
import { useWorkspaceTarget } from '../hooks/useWorkspaceTarget.js'
import { workspaceColor } from '../lib/workspaceColor.js'
import {
  SECTIONS,
  scopeNoteFor,
  sectionShown,
  settingsNav,
  unsavedChanges,
  type SectionId
} from './settings/sections.js'
import { AgentsSection } from './settings/AgentsSection.js'
import { DispatchSection } from './settings/DispatchSection.js'
import { ExperimentalSection } from './settings/ExperimentalSection.js'
import { PreferencesSection } from './settings/PreferencesSection.js'
import { RoutingSection } from './settings/RoutingSection.js'
import { ShortcutsSection } from './settings/ShortcutsSection.js'
import { StorageSection } from './settings/StorageSection.js'
import { TemplatesSection } from './settings/TemplatesSection.js'
import { ThemeSection } from './settings/ThemeSection.js'
import { UpdatesSection } from './settings/UpdatesSection.js'

export function SettingsDialog({
  settings,
  workspaces,
  initialSection,
  onSave,
  onPreviewTheme,
  onClose
}: {
  settings: Settings
  workspaces: Workspaces
  initialSection?: SectionId
  onSave: (change: SettingsChange) => Promise<void>
  /** Applies a draft theme to the live app so combinations can be judged before saving. */
  onPreviewTheme: (theme: ThemeSettings | null) => void
  onClose: () => void
}): ReactNode {
  const [draft, setDraft] = useState<Settings>(settings)
  const [saveError, setSaveError] = useState('')
  const [section, setSection] = useState<SectionId>(initialSection ?? 'preferences')
  const [selectedId, setSelectedId] = useState<string>(
    settings.promptTemplates[0]?.id ?? settings.defaultPromptTemplateId
  )
  const [search, setSearch] = useState('')
  const selectFirstTemplate = useCallback(
    (loaded: WorkspaceSettings) =>
      setSelectedId(loaded.promptTemplates[0]?.id ?? loaded.defaultPromptTemplateId),
    []
  )
  const target = useWorkspaceTarget({
    settings,
    workspaces,
    draft,
    setDraft,
    onLoaded: selectFirstTemplate
  })

  const active = SECTIONS.find((item) => item.id === section) ?? SECTIONS[0]
  const activeHidden = !sectionShown(active, draft.experimental)
  // What is on disk now: the app-level values, with the edited workspace's own laid over them.
  const baseline: Settings = { ...settings, ...target.savedWorkspaceSettings }
  const { sections: dirtySections, count: dirtyCount } = unsavedChanges(draft, baseline)
  const dirtyLabel = `${dirtyCount} unsaved ${dirtyCount === 1 ? 'change' : 'changes'}`
  const themeEdited =
    JSON.stringify(draft.theme) !== JSON.stringify(target.savedWorkspaceSettings.theme)
  const previewedTheme = target.editingActiveWorkspace && themeEdited ? draft.theme : null
  const navGroups = settingsNav(search, draft.experimental)

  // Switching the feature off while on its page would leave a page that no longer exists.
  useEffect(() => {
    if (activeHidden) setSection('experimental')
  }, [activeHidden])

  useEffect(() => {
    onPreviewTheme(previewedTheme)
  }, [previewedTheme, onPreviewTheme])

  const patch = (changes: Partial<Settings>): void =>
    setDraft((current) => ({ ...current, ...changes }))

  function save(): void {
    if (dirtyCount === 0) return
    setSaveError('')
    onSave({
      workspaceId: target.editedWorkspaceId,
      workspace: workspaceSettingsFor(draft),
      global: globalSettingsFor(draft)
    }).then(onClose, (error: unknown) =>
      setSaveError(error instanceof Error ? error.message : String(error))
    )
  }

  function discard(): void {
    setDraft((current) => ({
      ...current,
      ...target.savedWorkspaceSettings,
      ...globalSettingsFor(settings)
    }))
  }

  return (
    <Modal bare backdropCloses={false} title="Settings" onClose={onClose} onSubmit={save}>
      <div className="grid min-h-0 flex-1 grid-cols-[220px_minmax(0,1fr)]">
        <nav className="flex min-h-0 flex-col gap-2.5 overflow-y-auto border-r border-edge bg-chrome/50 px-2.5 py-3">
          <div className="px-1.5">
            <span className="text-[15px] font-semibold tracking-[-0.01em]">Settings</span>
          </div>
          <label className="relative block">
            <svg
              aria-hidden
              viewBox="0 0 16 16"
              width="13"
              height="13"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              className="pointer-events-none absolute left-[9px] top-1/2 -translate-y-1/2 text-faint"
            >
              <circle cx="7" cy="7" r="4.25" />
              <path d="M10.25 10.25 13 13" />
            </svg>
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Find a setting"
              aria-label="Find a setting"
              className="box-border h-7 w-full rounded-[7px] border border-edge bg-chrome pl-7 pr-2 text-[12.5px] text-ink outline-none placeholder:text-faint focus:border-accent"
            />
          </label>

          {navGroups.map((group) => (
            <div key={group.label} className="flex flex-col gap-0.5">
              <div className="px-2 pb-1">
                <Eyebrow>{group.label}</Eyebrow>
              </div>
              {group.picker ? (
                <span className="relative mb-1.5 block">
                  <span
                    aria-hidden
                    style={{ backgroundColor: workspaceColor(target.editedWorkspaceId) }}
                    className="pointer-events-none absolute left-[9px] top-1/2 z-10 size-[7px] -translate-y-1/2 rounded-[2px]"
                  />
                  <Select
                    aria-label="Workspace these settings apply to"
                    compact
                    inset
                    className="font-medium"
                    value={target.requestedWorkspaceId ?? target.editedWorkspaceId}
                    onChange={(event) => target.choose(event.target.value)}
                  >
                    {target.workspaces.map((workspace) => (
                      <option key={workspace.id} value={workspace.id}>
                        {workspace.name}
                        {workspace.id === settings.activeWorkspaceId ? ' (open)' : ''}
                      </option>
                    ))}
                  </Select>
                </span>
              ) : null}
              {group.items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  aria-current={item.id === section}
                  onClick={() => setSection(item.id)}
                  className={`flex h-[26px] items-center gap-2 rounded-[7px] px-2 text-left text-[12.5px] transition-colors ${
                    item.id === section
                      ? 'bg-raised font-semibold text-ink'
                      : 'font-medium text-dim hover:bg-raised/70 hover:text-ink'
                  }`}
                >
                  <span className="flex-1">{item.label}</span>
                  {dirtySections.has(item.id) ? (
                    <span
                      title="Unsaved changes"
                      className="size-1.5 rounded-full bg-[var(--color-accent-text)]"
                    />
                  ) : null}
                </button>
              ))}
            </div>
          ))}
          {navGroups.length === 0 ? (
            <p className="px-2 text-[12px] text-faint">No settings match “{search}”.</p>
          ) : null}
        </nav>

        <section className="flex min-h-0 min-w-0 flex-col">
          <header className="flex items-start gap-4 border-b border-edge py-4 pl-6 pr-4">
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <div className="flex items-center gap-2.5">
                <h2 className="text-[17px] font-semibold tracking-[-0.01em]">{active.label}</h2>
                <Chip
                  tone={active.scope === 'workspace' ? 'accent' : 'neutral'}
                  title={scopeNoteFor(active.scope, target.editedWorkspaceName)}
                >
                  {active.scope === 'workspace'
                    ? `${target.editedWorkspaceName} only`
                    : 'All workspaces'}
                </Chip>
              </div>
              <p className="text-[12px] leading-normal text-dim text-pretty">{active.blurb}</p>
            </div>
            <button
              type="button"
              aria-label="Close"
              onClick={onClose}
              className="grid size-7 shrink-0 place-items-center rounded-lg text-dim transition-colors hover:bg-raised/70 hover:text-ink"
            >
              <svg
                aria-hidden
                viewBox="0 0 16 16"
                width="14"
                height="14"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              >
                <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
              </svg>
            </button>
          </header>

          {target.requestedWorkspaceId ? (
            <div
              role="alert"
              className="mx-6 mt-3.5 flex shrink-0 items-center gap-2.5 rounded-[10px] border border-edge-strong bg-raised py-2.5 pl-3.5 pr-2.5"
            >
              <p className="min-w-0 flex-1 text-[12px] leading-[1.45] text-ink">
                You have {dirtyLabel} in {target.editedWorkspaceName}. Switching workspace discards
                them.
              </p>
              <Button autoFocus className="h-[26px] px-2.5" onClick={target.cancelSwitch}>
                Stay
              </Button>
              <Button variant="danger" className="h-[26px] px-2.5" onClick={target.confirmDiscard}>
                Discard &amp; switch
              </Button>
            </div>
          ) : null}
          {target.notice ? (
            <p
              role="status"
              className="mx-6 mt-3.5 shrink-0 rounded-[10px] border border-edge bg-raised/60 px-3.5 py-2.5 text-[12px] text-dim"
            >
              {target.notice}
            </p>
          ) : null}
          {target.editedFileBroken ? (
            <p
              role="status"
              className="mx-6 mt-3.5 shrink-0 rounded-[10px] border border-edge bg-raised/60 px-3.5 py-2.5 text-[12px] text-dim"
            >
              Some of {target.editedWorkspaceName}&apos;s settings.json could not be used, so
              defaults are shown in its place. Saving keeps a copy of the old file as
              settings.json.bak.
            </p>
          ) : null}

          <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-7 pt-5">
            <div
              className={`flex flex-col gap-5 ${section === 'templates' ? 'h-full min-h-[380px]' : section === 'presets' ? 'max-w-[820px]' : 'max-w-[640px]'}`}
            >
              {section === 'preferences' ? (
                <PreferencesSection draft={draft} patch={patch} />
              ) : null}

              {section === 'workspaces' ? (
                <WorkspacesPane
                  workspaces={workspaces}
                  editedWorkspaceId={target.editedWorkspaceId}
                  onEdit={(id) => {
                    target.choose(id)
                    setSection('preferences')
                  }}
                />
              ) : null}

              {section === 'storage' ? <StorageSection draft={draft} patch={patch} /> : null}

              {section === 'routing' ? <RoutingSection draft={draft} patch={patch} /> : null}

              {section === 'templates' ? (
                <TemplatesSection
                  draft={draft}
                  patch={patch}
                  selectedId={selectedId}
                  onSelect={setSelectedId}
                />
              ) : null}

              {section === 'orchestration' ? <DispatchSection draft={draft} patch={patch} /> : null}

              {section === 'shortcuts' ? <ShortcutsSection draft={draft} patch={patch} /> : null}
              {section === 'theme' ? <ThemeSection draft={draft} patch={patch} /> : null}

              {section === 'presets' ? (
                <PresetsPane
                  presets={draft.taskPresets}
                  settings={draft}
                  onChange={(taskPresets) => patch({ taskPresets })}
                />
              ) : null}

              {section === 'source-github' ? (
                <SourcesPane
                  sources={draft.sources}
                  saved={target.savedWorkspaceSettings.sources}
                  canAct={target.editingActiveWorkspace}
                  onChange={(sources) => patch({ sources })}
                />
              ) : null}

              {section === 'agents' ? <AgentsSection draft={draft} patch={patch} /> : null}
              {section === 'experimental' ? (
                <ExperimentalSection draft={draft} patch={patch} />
              ) : null}

              {section === 'updates' ? <UpdatesSection draft={draft} patch={patch} /> : null}
            </div>
          </div>

          <footer className="flex shrink-0 items-center gap-2 border-t border-edge bg-chrome/40 py-3 pl-6 pr-4">
            {saveError ? (
              <span role="alert" className="text-[12px] text-danger">
                {saveError}
              </span>
            ) : (
              <span
                className={`flex items-center gap-[7px] text-[12px] ${dirtyCount ? 'text-ink' : 'text-faint'}`}
              >
                {dirtyCount ? (
                  <span className="size-1.5 rounded-full bg-[var(--color-accent-text)]" />
                ) : null}
                {dirtyCount === 0
                  ? 'All changes saved'
                  : `${dirtyLabel} in ${target.editedWorkspaceName}`}
              </span>
            )}
            <div className="flex-1" />
            {dirtyCount ? (
              <Button variant="subtle" onClick={discard}>
                Discard
              </Button>
            ) : null}
            <Button variant="primary" disabled={dirtyCount === 0} onClick={save}>
              Save
              <kbd className="font-mono text-[10px] font-normal opacity-70">
                {formatAccelerator('mod+enter')}
              </kbd>
            </Button>
          </footer>
        </section>
      </div>
    </Modal>
  )
}
