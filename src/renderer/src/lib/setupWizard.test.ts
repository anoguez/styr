import { describe, expect, it } from 'vitest'
import { DEFAULT_THEME, type Settings } from '@core/types.js'
import {
  DISPATCH_PRESETS,
  SETUP_TITLES,
  changedKeyCount,
  dirtySteps,
  matchingPreset,
  routedToEnabled,
  setupSummary,
  shouldWelcome,
  withPreset
} from './setupWizard.js'

const base = {
  defaultRepoPath: '',
  shell: '/bin/zsh',
  worktreeLocation: 'beside',
  enabledProviders: ['claude', 'codex'],
  defaultProvider: 'claude',
  claudeApprovalMode: 'user',
  codexApprovalReviewer: 'user',
  providerRouting: { spec: 'claude', implement: 'claude', review: 'codex' },
  orchestration: { spec: 1, implement: 2, review: 1 },
  autoDispatch: false,
  theme: DEFAULT_THEME,
  experimental: {
    externalSources: false,
    nativeTerminal: false,
    worklog: false,
    remoteWorkspaces: false
  }
} as unknown as Settings

describe('dispatch presets', () => {
  it('recognises each preset it applies', () => {
    for (const preset of DISPATCH_PRESETS) {
      expect(matchingPreset({ ...base, ...withPreset(preset) })?.id).toBe(preset.id)
    }
  })

  it('is Custom once a lane is tuned by hand', () => {
    const tuned = { ...base, orchestration: { spec: 1, implement: 3, review: 1 } }
    expect(matchingPreset(tuned)).toBeUndefined()
    expect(setupSummary('Styr', tuned).find((r) => r.label === 'Dispatch')?.value).toContain(
      'Custom'
    )
  })

  it('copies the lanes instead of sharing them with the preset', () => {
    const applied = withPreset(DISPATCH_PRESETS[0]!)
    applied.orchestration.implement = 9
    expect(DISPATCH_PRESETS[0]!.lanes.implement).toBe(1)
  })
})

describe('routedToEnabled', () => {
  it('moves lanes off a provider that was switched off', () => {
    expect(routedToEnabled(base.providerRouting, ['claude'])).toEqual({
      spec: 'claude',
      implement: 'claude',
      review: 'claude'
    })
  })

  it('leaves routing alone while both are on', () => {
    expect(routedToEnabled(base.providerRouting, ['claude', 'codex'])).toEqual(base.providerRouting)
  })
})

describe('change tracking', () => {
  it('marks only the steps that differ', () => {
    const draft = { ...base, shell: '/bin/bash', autoDispatch: true }
    expect([...dirtySteps(draft, base)].sort()).toEqual(['dispatch', 'workspace'])
    expect(changedKeyCount(draft, base)).toBe(2)
  })

  it('reports nothing for an untouched draft', () => {
    expect(dirtySteps(base, base).size).toBe(0)
    expect(changedKeyCount(base, base)).toBe(0)
  })
})

describe('setupSummary', () => {
  it('says when no repository is chosen and skipped lanes are skipped', () => {
    const rows = setupSummary('Styr', {
      ...base,
      orchestration: { spec: 0, implement: 0, review: 0 }
    })
    expect(rows[0]!.value).toBe('Styr · no repository yet')
    expect(rows[2]!.value).toContain('all lanes skipped')
  })

  it('names the default agent only when there is a choice', () => {
    expect(setupSummary('Styr', base)[1]!.value).toContain('Claude Code default')
    expect(setupSummary('Styr', { ...base, enabledProviders: ['claude'] })[1]!.value).not.toContain(
      'default'
    )
  })
})

describe('shouldWelcome', () => {
  it('welcomes someone with nothing set up', () => {
    expect(shouldWelcome({ seen: false, defaultRepoPath: ' ', taskCount: 0 })).toBe(true)
  })

  it.each([
    { seen: true, defaultRepoPath: '', taskCount: 0 },
    { seen: false, defaultRepoPath: '/repo', taskCount: 0 },
    { seen: false, defaultRepoPath: '', taskCount: 3 }
  ])('does not welcome %o', (input) => {
    expect(shouldWelcome(input)).toBe(false)
  })
})

describe('titles', () => {
  it('welcomes the first time and is Quick setup afterwards', () => {
    expect(SETUP_TITLES['first-run']).toBe('Welcome to Styr')
    expect(SETUP_TITLES.quick).toBe('Quick setup')
  })
})
