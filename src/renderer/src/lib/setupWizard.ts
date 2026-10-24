import type { OrchestrationCapacity, Settings } from '@core/types.js'
import {
  ORCHESTRATION_LANES,
  ORCHESTRATION_LANE_LABELS,
  AGENT_PROVIDER_LABELS
} from '@core/types.js'

/** First run welcomes a new user; Quick setup is the same wizard reopened from the palette. */
export type SetupMode = 'first-run' | 'quick'

export const SETUP_STEPS = [
  { id: 'workspace', label: 'Workspace' },
  { id: 'agents', label: 'Agents' },
  { id: 'dispatch', label: 'Dispatch' },
  { id: 'theme', label: 'Theme' },
  { id: 'review', label: 'Review' }
] as const

export type SetupStepId = (typeof SETUP_STEPS)[number]['id']

/** The `Settings` keys each step edits, so Quick setup can mark the steps with changes. */
export const STEP_KEYS: Record<SetupStepId, readonly (keyof Settings)[]> = {
  workspace: ['defaultRepoPath', 'worktreeLocation', 'shell'],
  agents: [
    'enabledProviders',
    'defaultProvider',
    'claudeApprovalMode',
    'codexApprovalReviewer',
    'providerRouting'
  ],
  dispatch: ['orchestration', 'providerRouting', 'autoDispatch'],
  theme: ['theme'],
  review: ['experimental']
}

export interface DispatchPreset {
  id: 'manual' | 'balanced' | 'parallel'
  label: string
  hint: string
  lanes: OrchestrationCapacity
  autoDispatch: boolean
}

export const DISPATCH_PRESETS: readonly DispatchPreset[] = [
  {
    id: 'manual',
    label: 'Hands-on',
    hint: 'One agent at a time, started by you. Dispatch only runs when you ask.',
    lanes: { spec: 0, implement: 1, review: 0 },
    autoDispatch: false
  },
  {
    id: 'balanced',
    label: 'Balanced',
    hint: 'A few agents across spec, build and review. You press Dispatch.',
    lanes: { spec: 1, implement: 2, review: 1 },
    autoDispatch: false
  },
  {
    id: 'parallel',
    label: 'Parallel',
    hint: 'Auto-run keeps every slot busy. You review what comes back.',
    lanes: { spec: 1, implement: 4, review: 2 },
    autoDispatch: true
  }
]

/** The preset the draft matches exactly, or undefined once a lane or Auto-run was tuned by hand. */
export function matchingPreset(
  draft: Pick<Settings, 'orchestration' | 'autoDispatch'>
): DispatchPreset | undefined {
  return DISPATCH_PRESETS.find(
    (preset) =>
      preset.autoDispatch === draft.autoDispatch &&
      ORCHESTRATION_LANES.every((lane) => preset.lanes[lane] === draft.orchestration[lane])
  )
}

export function withPreset(
  preset: DispatchPreset
): Pick<Settings, 'orchestration' | 'autoDispatch'> {
  return { orchestration: { ...preset.lanes }, autoDispatch: preset.autoDispatch }
}

/** Lanes that route to a provider that has just been switched off move to the one still on. */
export function routedToEnabled(
  routing: Settings['providerRouting'],
  enabled: Settings['enabledProviders']
): Settings['providerRouting'] {
  const fallback = enabled[0]
  if (!fallback) return routing
  return Object.fromEntries(
    ORCHESTRATION_LANES.map((lane) => [
      lane,
      enabled.includes(routing[lane]) ? routing[lane] : fallback
    ])
  ) as Settings['providerRouting']
}

/** The settings keys the draft changes against what is saved, per step. */
export function dirtySteps(draft: Settings, saved: Settings): ReadonlySet<SetupStepId> {
  const changed = (key: keyof Settings): boolean =>
    JSON.stringify(draft[key]) !== JSON.stringify(saved[key])
  return new Set(SETUP_STEPS.filter((step) => STEP_KEYS[step.id].some(changed)).map((s) => s.id))
}

export function changedKeyCount(draft: Settings, saved: Settings): number {
  const keys = new Set(Object.values(STEP_KEYS).flat())
  return [...keys].filter((key) => JSON.stringify(draft[key]) !== JSON.stringify(saved[key])).length
}

export interface SummaryRow {
  label: string
  value: string
  step: SetupStepId
}

export function setupSummary(name: string, draft: Settings): SummaryRow[] {
  const preset = matchingPreset(draft)
  const lanes =
    ORCHESTRATION_LANES.filter((lane) => draft.orchestration[lane] > 0)
      .map(
        (lane) => `${draft.orchestration[lane]} ${ORCHESTRATION_LANE_LABELS[lane].toLowerCase()}`
      )
      .join(', ') || 'all lanes skipped'
  const providers = draft.enabledProviders.map((p) => AGENT_PROVIDER_LABELS[p])
  return [
    {
      label: 'Workspace',
      value: `${name} · ${draft.defaultRepoPath.trim() || 'no repository yet'}`,
      step: 'workspace'
    },
    {
      label: 'Agents',
      value:
        providers.join(', ') +
        (draft.enabledProviders.length > 1
          ? ` · ${AGENT_PROVIDER_LABELS[draft.defaultProvider]} default`
          : ''),
      step: 'agents'
    },
    {
      label: 'Dispatch',
      value: `${preset?.label ?? 'Custom'} · ${lanes} · Auto-run ${draft.autoDispatch ? 'on' : 'off'}`,
      step: 'dispatch'
    },
    {
      label: 'Theme',
      value: draft.theme.gradient ? 'Gradient background' : 'Flat background',
      step: 'theme'
    }
  ]
}

export const SETUP_TITLES: Record<SetupMode, string> = {
  'first-run': 'Welcome to Styr',
  quick: 'Quick setup'
}

const SEEN_KEY = 'styr.setup.seen'

export function setupSeen(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) !== null
  } catch {
    return true
  }
}

export function markSetupSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, '1')
  } catch {
    // A convenience: without storage the wizard may come back, which is harmless.
  }
}

/**
 * Whether to welcome this person: never seen the wizard, no repository chosen and no task on any
 * board. An existing user whose browser storage was cleared has tasks, so is not welcomed again.
 */
export function shouldWelcome(input: {
  seen: boolean
  defaultRepoPath: string
  taskCount: number
}): boolean {
  return !input.seen && input.defaultRepoPath.trim() === '' && input.taskCount === 0
}
