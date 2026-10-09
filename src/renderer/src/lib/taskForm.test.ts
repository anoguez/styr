import { describe, expect, it } from 'vitest'
import { DEFAULT_TASK_PRESETS, MAX_TASK_PRESETS, type Settings, type Task } from '@core/types.js'
import {
  blockerState,
  changesTitle,
  choosePreset,
  initialForm,
  savePresetPlan,
  taskPayload,
  templateNames,
  toForm,
  worktreeHint
} from './taskForm.js'

const bug = DEFAULT_TASK_PRESETS[0]!
// Only the keys the form reads; the full shipped settings live in node-only config.ts.
const settings = {
  defaultRepoPath: '/repo',
  defaultProvider: 'claude',
  taskDefaults: { orchestrate: true, useWorktree: false },
  taskPresets: [bug],
  defaultPromptTemplateId: 'implement',
  promptTemplates: [
    { id: 'spec', name: 'Spec the task', template: '' },
    { id: 'implement', name: 'Implement the task', template: '' }
  ],
  promptRouting: {
    needsSpec: 'spec',
    byStatus: {
      backlog: 'implement',
      in_progress: 'implement',
      in_review: 'implement',
      done: 'implement'
    }
  }
} as unknown as Settings
const blank = toForm(null, settings)

const task = (id: string, overrides: Partial<Task> = {}): Task =>
  ({ id, title: id, status: 'backlog', blockedBy: [], ...overrides }) as Task

describe('toForm and initialForm', () => {
  it('seeds a new task from the workspace defaults', () => {
    expect(blank).toMatchObject({
      title: '',
      status: 'backlog',
      repoPath: '/repo',
      useWorktree: settings.taskDefaults.useWorktree,
      provider: settings.defaultProvider
    })
  })

  it('lays the preset a new task was opened from over the defaults', () => {
    expect(initialForm(null, settings, bug)).toMatchObject({ tags: bug.tags, priority: 'high' })
    expect(initialForm(null, settings)).toEqual(blank)
  })
})

describe('choosePreset', () => {
  it('applies a preset to an empty form without asking', () => {
    const choice = choosePreset(blank, '', bug.id, settings)
    expect(choice).toMatchObject({ presetId: bug.id, confirm: false })
    expect(choice.form?.tags).toEqual(bug.tags)
  })

  it('asks before laying a preset over typed work, keeping a typed title the preset leaves blank', () => {
    const typed = { ...blank, title: 'Crash on save', description: 'Steps…' }
    const choice = choosePreset(typed, '', bug.id, settings)
    expect(choice.confirm).toBe(true)
    expect(choice.form?.title).toBe(bug.title || 'Crash on save')
  })

  it('does not ask when the form still holds only the previous preset', () => {
    const applied = initialForm(null, settings, bug)
    expect(choosePreset(applied, bug.id, bug.id, settings).confirm).toBe(false)
  })

  it('going back to None clears an untouched preset but keeps the chosen folder', () => {
    const applied = { ...initialForm(null, settings, bug), repoPath: '/elsewhere' }
    const choice = choosePreset(applied, bug.id, '', settings)
    expect(choice.presetId).toBe('')
    expect(choice.form).toEqual({ ...blank, repoPath: '/elsewhere' })
  })

  it('going back to None keeps edits made on top of the preset', () => {
    const edited = { ...initialForm(null, settings, bug), description: 'my own words' }
    expect(choosePreset(edited, bug.id, '', settings)).toEqual({
      form: null,
      presetId: '',
      confirm: false
    })
  })
})

describe('savePresetPlan', () => {
  const form = { ...blank, title: 'T', tags: ['x'] }

  it('ignores a blank name', () => {
    expect(savePresetPlan([bug], '   ', form)).toEqual({ kind: 'empty' })
  })

  it('adds a new preset with a fresh id', () => {
    const plan = savePresetPlan([bug], ' Mine ', form)
    expect(plan.kind).toBe('save')
    if (plan.kind !== 'save') return
    expect(plan.replaces).toBeUndefined()
    expect(plan.presets).toHaveLength(2)
    expect(plan.presets[1]).toMatchObject({ id: plan.presetId, name: 'Mine', tags: ['x'] })
  })

  it('replaces a preset of the same name, in place and whatever the case', () => {
    const plan = savePresetPlan([bug], bug.name.toUpperCase(), form)
    if (plan.kind !== 'save') throw new Error(plan.kind)
    expect(plan.replaces).toBe(bug)
    expect(plan.presetId).toBe(bug.id)
    expect(plan.presets).toHaveLength(1)
  })

  it('refuses a new preset past the cap, but still allows replacing one', () => {
    const full = Array.from({ length: MAX_TASK_PRESETS }, (_, i) => ({
      ...bug,
      id: `p${i}`,
      name: `P${i}`
    }))
    expect(savePresetPlan(full, 'Another', form)).toEqual({ kind: 'full' })
    expect(savePresetPlan(full, 'P3', form).kind).toBe('save')
  })
})

describe('taskPayload', () => {
  it('trims, leaves blanks unset and defaults the project to the folder name', () => {
    const payload = taskPayload({
      ...blank,
      title: '  Fix it ',
      repoPath: ' /code/styr ',
      prUrl: ' ',
      baseBranch: '',
      promptTemplateId: ''
    })
    expect(payload).toMatchObject({
      title: 'Fix it',
      repoPath: '/code/styr',
      project: 'styr',
      prUrl: undefined,
      baseBranch: undefined,
      promptTemplateId: undefined
    })
    expect(taskPayload({ ...blank, project: ' web ' }).project).toBe('web')
    expect(taskPayload({ ...blank, repoPath: '' }).project).toBeUndefined()
  })
})

describe('templateNames', () => {
  it('runs the routed template unless a pinned one still exists', () => {
    const routed = templateNames(settings, { ...blank, promptTemplateId: '' })
    expect(routed).toEqual({ routed: 'Implement the task', effective: 'Implement the task' })
    expect(templateNames(settings, { ...blank, readiness: 'needs_spec' }).routed).toBe(
      'Spec the task'
    )
    expect(templateNames(settings, { ...blank, promptTemplateId: 'spec' }).effective).toBe(
      'Spec the task'
    )
    expect(templateNames(settings, { ...blank, promptTemplateId: 'gone' }).effective).toBe(
      routed.routed
    )
  })
})

describe('blockerState', () => {
  const tasks = [
    task('A', { blockedBy: ['B'] }),
    task('B'),
    task('C', { status: 'done' }),
    task('D', { archivedAt: '2026-01-01' }),
    task('E')
  ]

  it('offers open, unarchived tasks not already listed, flagging ones that would close a cycle', () => {
    const { choices } = blockerState('B', [], tasks)
    expect(choices.map((choice) => [choice.id, choice.cycle])).toEqual([
      ['A', true],
      ['E', false]
    ])
  })

  it('reports a cycle the list already makes and ids that match no task', () => {
    const state = blockerState('B', ['A', 'TASK-9999'], tasks)
    expect(state.cycle).toEqual(['B', 'A', 'B'])
    expect(state.missing).toEqual(['TASK-9999'])
    expect(state.choices.map((choice) => choice.id)).toEqual(['E'])
  })

  it('finds no cycles for a new task, which has no id yet', () => {
    const state = blockerState(undefined, ['A'], tasks)
    expect(state.cycle).toBeNull()
    expect(state.choices.every((choice) => !choice.cycle)).toBe(true)
  })
})

describe('worktreeHint', () => {
  const on = { useWorktree: true, repoPath: '/code/styr' }

  it('explains each state of the worktree switch', () => {
    expect(worktreeHint({ ...on, useWorktree: false }, 'TASK-0001', false)).toMatch(/directly/)
    expect(worktreeHint({ ...on, repoPath: '' }, 'TASK-0001', false)).toMatch(/^Set a working/)
    expect(worktreeHint(on, 'TASK-0001', true)).toMatch(/not look like a git repository/)
    expect(worktreeHint(on, 'TASK-0001', false)).toBe(
      'Runs on branch styr/TASK-0001 so parallel agents never share a checkout.'
    )
  })
})

describe('changesTitle', () => {
  it('says whether changes are loading, absent or ready', () => {
    expect(changesTitle(null)).toBe('Reading changes…')
    expect(changesTitle({ files: [], branch: 'styr/TASK-0001' })).toBe(
      'No changes on styr/TASK-0001 yet'
    )
    expect(changesTitle({ files: [], branch: '' })).toBe('No changes to show')
    expect(changesTitle({ files: [{}], branch: 'b' } as never)).toBe('View changes')
  })
})
