import type { ReactNode } from 'react'
import {
  AGENT_PROVIDER_LABELS,
  ORCHESTRATION_LANE_LABELS,
  ORCHESTRATION_LANES,
  type Settings
} from '@core/types.js'
import { UI_FONTS } from '../../hooks/useTheme.js'
import { PLATFORM } from '../../lib/platform.js'
import {
  DISPATCH_PRESETS,
  matchingPreset,
  routedToEnabled,
  setupSummary,
  withPreset,
  type SetupMode,
  type SetupStepId
} from '../../lib/setupWizard.js'
import { THEME_PRESETS, applyPreset } from '../../lib/themePresets.js'
import { AgentCliStatus } from '../AgentCliStatus.js'
import { McpSetupStatus } from '../McpSetup.js'
import { LANE_HINTS, LaneAgentSelect } from '../settings/parts.js'
import { withProvider } from '../settings/draft.js'
import {
  Card,
  CardRow,
  Chip,
  DirectoryInput,
  Eyebrow,
  Field,
  Hint,
  Segmented,
  Select,
  Stepper,
  Switch,
  SwitchRow,
  Button,
  inputBase
} from '../ui.js'

export interface StepProps {
  draft: Settings
  patch: (changes: Partial<Settings>) => void
}

function Heading({ title, children }: { title: string; children: ReactNode }): ReactNode {
  return (
    <div className="flex flex-col gap-2">
      <h1 className="text-[20px] font-semibold tracking-[-0.015em]">{title}</h1>
      <p className="text-[13px] leading-[1.55] text-dim text-pretty">{children}</p>
    </div>
  )
}

export function WorkspaceStep({
  mode,
  name,
  nameLocked,
  onName,
  picker,
  draft,
  patch
}: StepProps & {
  mode: SetupMode
  name: string
  /** The Default workspace cannot be renamed. */
  nameLocked: boolean
  onName: (name: string) => void
  /** Quick setup: the workspaces to set up, and which one is being edited. */
  picker: ReactNode
}): ReactNode {
  const first = mode === 'first-run'
  return (
    <div className="flex max-w-[560px] flex-col gap-[22px]">
      <div className="flex flex-col gap-2">
        <h1 className="text-[22px] font-semibold tracking-[-0.015em]">
          {first ? 'Let’s set up your first board' : 'Workspace'}
        </h1>
        <p className="text-[13px] leading-[1.55] text-dim text-pretty">
          {first
            ? 'Four short steps. Defaults are sensible, so you can skip ahead and tune things later in Settings.'
            : 'Each workspace keeps its own tasks, agents and settings. Pick the one to set up.'}
        </p>
      </div>
      {picker}
      <Field
        label="Workspace name"
        hint={
          nameLocked
            ? 'The Default workspace keeps its name. Add another from the workspace menu.'
            : undefined
        }
      >
        <input
          aria-label="Workspace name"
          disabled={nameLocked}
          className={`${inputBase} h-8 w-[280px] max-w-full px-2.5 text-[13px] disabled:opacity-60`}
          value={name}
          onChange={(event) => onName(event.target.value)}
        />
      </Field>
      <Field
        label="Default repository"
        hint="Where new tasks run unless they name their own repository."
      >
        <DirectoryInput
          value={draft.defaultRepoPath}
          onChange={(defaultRepoPath) => patch({ defaultRepoPath })}
          placeholder="~/code/my-project"
        />
      </Field>
      <Field
        label="Task worktrees"
        hint={
          draft.worktreeLocation === 'inside'
            ? 'Inside the repo, so tools that walk up the tree find its installed node_modules.'
            : 'Each task gets its own checkout next to the repository.'
        }
      >
        <Segmented
          label="Worktree location"
          value={draft.worktreeLocation}
          onChange={(worktreeLocation) => patch({ worktreeLocation })}
          options={[
            { value: 'beside', label: 'Beside the repo' },
            { value: 'inside', label: 'Inside .styr' }
          ]}
        />
      </Field>
      <Field
        label="Terminal shell"
        hint={
          PLATFORM === 'win32'
            ? 'Agents launch from Git Bash or PowerShell 7 (pwsh.exe). Blank picks one for you.'
            : 'Agents launch from this shell. Blank uses $SHELL.'
        }
      >
        <input
          aria-label="Terminal shell"
          className={`${inputBase} h-8 w-60 px-2.5 font-mono text-[11.5px]`}
          value={draft.shell}
          onChange={(event) => patch({ shell: event.target.value })}
        />
      </Field>
    </div>
  )
}

const APPROVAL_COPY = {
  claude: {
    user: 'Claude Code pauses and asks before risky actions.',
    auto: 'Prompts go to Claude Code’s auto mode classifier; it does not grant full access.'
  },
  codex: {
    user: 'Codex pauses and asks before risky commands.',
    auto: 'Eligible requests go to Codex’s automatic reviewer; it does not grant full access.'
  }
} as const

export function AgentsStep({ draft, patch }: StepProps): ReactNode {
  function toggle(provider: 'claude' | 'codex', enabled: boolean): void {
    const next = withProvider(draft, provider, enabled)
    if (next) {
      patch({
        ...next,
        providerRouting: routedToEnabled(draft.providerRouting, next.enabledProviders)
      })
    }
  }
  return (
    <div className="flex max-w-[600px] flex-col gap-[18px]">
      <Heading title="Which agents do you use?">
        The coding CLIs Styr launches. Checked against your terminal shell.
      </Heading>
      <div className="flex flex-col gap-2.5">
        {(['claude', 'codex'] as const).map((id) => {
          const label = AGENT_PROVIDER_LABELS[id]
          const on = draft.enabledProviders.includes(id)
          const only = on && draft.enabledProviders.length === 1
          const isDefault = on && draft.defaultProvider === id
          const command = id === 'claude' ? draft.claudeCommand : draft.codexCommand
          const approval =
            id === 'claude'
              ? ({
                  value: draft.claudeApprovalMode,
                  auto: 'auto',
                  set: (v: string) =>
                    patch({ claudeApprovalMode: v as Settings['claudeApprovalMode'] })
                } as const)
              : ({
                  value: draft.codexApprovalReviewer,
                  auto: 'auto_review',
                  set: (v: string) =>
                    patch({ codexApprovalReviewer: v as Settings['codexApprovalReviewer'] })
                } as const)
          return (
            <Card key={id}>
              <div className="flex items-center gap-3 px-3.5 py-3">
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex items-center gap-2 text-[13px] font-semibold text-ink">
                    {label}
                    {isDefault && draft.enabledProviders.length > 1 ? (
                      <Chip tone="accent">Default</Chip>
                    ) : null}
                  </span>
                  <span className="text-[11.5px] text-faint">
                    {!on
                      ? 'Off. Tasks and lanes cannot use it.'
                      : isDefault
                        ? 'Used by manual launches. Dispatch lanes can pick either.'
                        : 'Available for tasks and Dispatch lanes.'}
                  </span>
                </span>
                {on && !isDefault ? (
                  <Button variant="subtle" onClick={() => patch({ defaultProvider: id })}>
                    Make default
                  </Button>
                ) : null}
                <Switch
                  label={`Enable ${label}`}
                  checked={on}
                  disabled={only}
                  title={only ? 'At least one provider must stay on' : undefined}
                  onChange={(enabled) => toggle(id, enabled)}
                />
              </div>
              {on ? (
                <div className="flex flex-col gap-3 border-t border-edge px-3.5 pb-3.5 pt-3">
                  <div className="grid grid-cols-[96px_minmax(0,1fr)] items-start gap-2.5">
                    <span className="pt-[3px] text-[12px] text-dim">Status</span>
                    <AgentCliStatus provider={id} command={command} shell={draft.shell} />
                  </div>
                  <div className="grid grid-cols-[96px_minmax(0,1fr)] items-start gap-2.5">
                    <span className="pt-[5px] text-[12px] text-dim">Approvals</span>
                    <div className="flex flex-col gap-1.5">
                      <Segmented
                        label={`${label} approvals`}
                        value={approval.value}
                        onChange={approval.set}
                        options={[
                          { value: 'user', label: 'Ask me' },
                          { value: approval.auto, label: 'Approve for me' }
                        ]}
                      />
                      <Hint>{APPROVAL_COPY[id][approval.value === 'user' ? 'user' : 'auto']}</Hint>
                    </div>
                  </div>
                  <div className="grid grid-cols-[96px_minmax(0,1fr)] items-start gap-2.5">
                    <span className="pt-[3px] text-[12px] text-dim">Board access</span>
                    <div className="flex min-w-0 flex-col gap-1.5">
                      <McpSetupStatus provider={id} />
                      <Hint>
                        Optional. Register Styr’s tools once (Settings → Agents has the command),
                        then start a new {label} session — it lets the agent read and move tasks.
                        Without it, runs can only edit files.
                      </Hint>
                    </div>
                  </div>
                </div>
              ) : null}
            </Card>
          )
        })}
      </div>
    </div>
  )
}

export function DispatchStep({ draft, patch }: StepProps): ReactNode {
  const preset = matchingPreset(draft)
  const total = ORCHESTRATION_LANES.reduce((sum, lane) => sum + draft.orchestration[lane], 0)
  return (
    <div className="flex max-w-[600px] flex-col gap-5">
      <Heading title="How hands-off should Styr be?">
        Dispatch fills free slots with the highest-priority waiting task. Pick a starting point;
        every value stays editable in Settings → Dispatch.
      </Heading>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))] gap-2.5">
        {DISPATCH_PRESETS.map((item) => {
          const on = preset?.id === item.id
          return (
            <button
              key={item.id}
              type="button"
              aria-pressed={on}
              onClick={() => patch(withPreset(item))}
              className={`flex flex-col items-start gap-1.5 rounded-[10px] border px-3.5 py-3 text-left transition-colors hover:border-faint ${
                on ? 'border-accent bg-accent/15' : 'border-edge bg-chrome'
              }`}
            >
              <span className="flex w-full items-center justify-between text-[13px] font-semibold text-ink">
                {item.label}
                <span
                  aria-hidden
                  className={`grid size-3.5 place-items-center rounded-full border ${on ? 'border-[var(--color-accent-text)]' : 'border-edge-strong'}`}
                >
                  <span
                    className={`size-1.5 rounded-full ${on ? 'bg-[var(--color-accent-text)]' : ''}`}
                  />
                </span>
              </span>
              <span className="text-[11.5px] leading-[1.45] text-dim text-pretty">{item.hint}</span>
            </button>
          )
        })}
      </div>
      <Card>
        <div className="grid grid-cols-[minmax(0,1fr)_150px_104px] items-center gap-3 border-b border-edge px-3.5 py-2">
          <Eyebrow>Lane</Eyebrow>
          <Eyebrow>Agent</Eyebrow>
          <span className="text-center">
            <Eyebrow>At once</Eyebrow>
          </span>
        </div>
        {ORCHESTRATION_LANES.map((lane) => (
          <CardRow
            key={lane}
            className={`grid grid-cols-[minmax(0,1fr)_150px_104px] items-center gap-3 px-3.5 py-2.5 ${
              draft.orchestration[lane] === 0 ? 'opacity-60' : ''
            }`}
          >
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-[12.5px] font-medium text-ink">
                {ORCHESTRATION_LANE_LABELS[lane]}
              </span>
              <span className="text-[11px] text-faint">
                {draft.orchestration[lane] === 0
                  ? 'Skipped — Dispatch leaves these alone'
                  : LANE_HINTS[lane]}
              </span>
            </span>
            <LaneAgentSelect lane={lane} draft={draft} patch={patch} />
            <Stepper
              label={ORCHESTRATION_LANE_LABELS[lane]}
              value={draft.orchestration[lane]}
              min={0}
              max={20}
              onChange={(value) =>
                patch({ orchestration: { ...draft.orchestration, [lane]: value } })
              }
            />
          </CardRow>
        ))}
      </Card>
      <Hint>Set a lane to 0 to skip it. Up to {total} agents can run at once.</Hint>
      <Card>
        <SwitchRow
          label="Auto-run"
          hint="Keep starting eligible work as slots free up. Stops itself after 20 starts in an hour or 3 failed starts in a row."
          checked={draft.autoDispatch}
          onChange={(autoDispatch) => patch({ autoDispatch })}
        />
      </Card>
    </div>
  )
}

const PREVIEW_CARDS = [
  { title: 'Debounce file watcher reindex', meta: 'Working · Claude' },
  { title: 'Spec the import flow', meta: 'Working · Codex' }
]

export function ThemeStep({ draft, patch }: StepProps): ReactNode {
  const theme = draft.theme
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_240px] gap-7">
      <div className="flex min-w-0 flex-col gap-5">
        <Heading title="Make it yours">
          A theme sets the base, accent and column colours together. Every surface is derived from
          the base, so contrast holds.
        </Heading>
        <div className="flex flex-wrap gap-2">
          {THEME_PRESETS.map((preset) => {
            const on = theme.base.toLowerCase() === preset.base
            return (
              <button
                key={preset.label}
                type="button"
                aria-pressed={on}
                onClick={() => patch({ theme: applyPreset(theme, preset) })}
                className="flex flex-col items-center gap-[5px]"
              >
                <span
                  style={{ backgroundColor: preset.base }}
                  className={`flex h-[34px] w-[52px] items-end gap-[3px] rounded-lg border-2 p-1 shadow-[inset_0_0_0_1px_rgba(128,128,128,0.25)] ${
                    on ? 'border-[var(--color-accent-text)]' : 'border-transparent'
                  }`}
                >
                  <span style={{ backgroundColor: preset.accent }} className="h-2 w-3 rounded-sm" />
                  {Object.values(preset.columns).map((hex) => (
                    <span
                      key={hex}
                      style={{ backgroundColor: hex }}
                      className="h-2 w-[5px] rounded-sm"
                    />
                  ))}
                </span>
                <span className={`text-[11px] ${on ? 'text-ink' : 'text-faint'}`}>
                  {preset.label}
                </span>
              </button>
            )
          })}
        </div>
        <Card>
          <SwitchRow
            label="Gradient background"
            hint="Washes the base with a hint of the accent."
            checked={theme.gradient}
            onChange={(gradient) => patch({ theme: { ...theme, gradient } })}
          />
        </Card>
        <Field label="Interface font">
          <div className="w-[200px]">
            <Select
              compact
              aria-label="Interface font"
              value={theme.uiFont}
              onChange={(event) => patch({ theme: { ...theme, uiFont: event.target.value } })}
            >
              {UI_FONTS.map((font) => (
                <option key={font.id} value={font.id}>
                  {font.label}
                </option>
              ))}
            </Select>
          </div>
        </Field>
        <Hint>Terminal colours, fonts and per-column colours are in Settings → Theme.</Hint>
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-[12px] font-semibold text-dim">Preview</span>
        <div className="flex flex-col gap-2.5 rounded-xl border border-edge bg-surface p-3">
          <div className="flex items-center gap-1.5 text-[11px] font-semibold text-ink">
            <span
              style={{ backgroundColor: theme.columns.in_progress }}
              className="size-1.5 rounded-full"
            />
            In Progress
            <span className="font-medium text-faint">2</span>
          </div>
          {PREVIEW_CARDS.map((card) => (
            <div
              key={card.title}
              className="flex flex-col gap-1.5 rounded-lg border border-edge bg-chrome p-2.5"
            >
              <span className="text-[11.5px] leading-[1.35] text-ink">{card.title}</span>
              <span className="flex items-center gap-1.5 text-[10.5px] text-faint">
                <span
                  style={{ backgroundColor: theme.columns.in_progress }}
                  className="size-1.5 rounded-full"
                />
                {card.meta}
              </span>
            </div>
          ))}
          <span className="inline-flex h-6 items-center self-start rounded-[7px] bg-accent px-2.5 text-[11.5px] font-semibold text-[var(--color-on-accent)]">
            Agent
          </span>
        </div>
      </div>
    </div>
  )
}

export function ReviewStep({
  mode,
  name,
  draft,
  patch,
  changes,
  onEdit,
  openPaletteHint
}: StepProps & {
  mode: SetupMode
  name: string
  changes: number
  onEdit: (step: SetupStepId) => void
  openPaletteHint: ReactNode
}): ReactNode {
  const first = mode === 'first-run'
  const rows = setupSummary(name, draft)
  const experiments = [
    {
      key: 'externalSources',
      label: 'External sources',
      hint: 'Link GitHub issues or REST API items to tasks.'
    },
    { key: 'worklog', label: 'Worklog', hint: 'Token usage and agent sessions per task per day.' },
    {
      key: 'remoteWorkspaces',
      label: 'Remote workspaces',
      hint: 'Boards on another machine running styr serve, reached over ssh.'
    }
  ] as const
  return (
    <div className="flex max-w-[580px] flex-col gap-5">
      <Heading title={first ? 'You’re ready' : 'Review changes'}>
        {first
          ? 'Here’s what Styr will use. Create a task and press Agent, or Dispatch to fill the lanes.'
          : changes > 0
            ? `${changes} change${changes > 1 ? 's' : ''} to ${name}. Nothing is saved until you press Apply.`
            : 'No changes yet. Nothing is saved until you press Apply.'}
      </Heading>
      <Card>
        {rows.map((row) => (
          <CardRow
            key={row.label}
            className="grid grid-cols-[96px_minmax(0,1fr)_auto] items-center gap-3 py-2.5 pl-3.5 pr-2.5"
          >
            <span className="text-[12px] text-faint">{row.label}</span>
            <span className="min-w-0 truncate text-[12.5px] text-ink" title={row.value}>
              {row.value}
            </span>
            <Button
              variant="subtle"
              className="h-6 px-2 text-[11.5px]"
              onClick={() => onEdit(row.step)}
            >
              Edit
            </Button>
          </CardRow>
        ))}
      </Card>
      <div className="flex flex-col gap-2">
        <span className="flex items-baseline gap-2 text-[12px] font-semibold text-dim">
          Try early features{' '}
          <span className="font-normal text-faint">— shared by every workspace</span>
        </span>
        <Card>
          {experiments.map((item) => (
            <CardRow key={item.key}>
              <SwitchRow
                label={item.label}
                hint={item.hint}
                checked={draft.experimental[item.key]}
                onChange={(value) =>
                  patch({ experimental: { ...draft.experimental, [item.key]: value } })
                }
              />
            </CardRow>
          ))}
        </Card>
      </div>
      <Hint>{openPaletteHint}</Hint>
    </div>
  )
}
