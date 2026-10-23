import { describe, expect, it } from 'vitest'
import { shippedSettings } from './config.js'
import { isSpecHandoff } from './specHandoff.js'
import type { Settings, Task, TaskSessionRef } from './types.js'

const settings: Settings = shippedSettings()

const ref = (id: string, extra: Partial<TaskSessionRef> = {}): TaskSessionRef => ({
  id,
  provider: 'claude',
  startedAt: '2026-01-01T00:00:00Z',
  label: id,
  ...extra
})

function task(extra: Partial<Task> = {}): Task {
  return {
    id: 'TASK-1',
    status: 'backlog',
    readiness: 'ready',
    sessions: [
      ref('spec-chat', { templateId: 'spec' }),
      ref('impl-chat', { templateId: 'implement' })
    ],
    agentSession: { provider: 'claude', id: 'spec-chat' },
    ...extra
  } as unknown as Task
}

const pointAt = (id: string): Partial<Task> => ({ agentSession: { provider: 'claude', id } })

describe('isSpecHandoff', () => {
  it('is true for a spec run handed back to Backlog + ready', () => {
    expect(isSpecHandoff(settings, task())).toBe(true)
  })

  it('is false for an implement or review run', () => {
    const sessions = [
      ref('impl-chat', { templateId: 'implement' }),
      ref('review-chat', { templateId: 'code-review' })
    ]
    expect(isSpecHandoff(settings, task({ sessions, ...pointAt('impl-chat') }))).toBe(false)
    expect(isSpecHandoff(settings, task({ sessions, ...pointAt('review-chat') }))).toBe(false)
  })

  it.each([
    ['in_progress', 'ready'],
    ['in_review', 'ready'],
    ['done', 'ready'],
    ['backlog', 'needs_spec']
  ])('is false for %s + %s', (status, readiness) => {
    expect(isSpecHandoff(settings, task({ status, readiness } as Partial<Task>))).toBe(false)
  })

  it('follows the template needs_spec routes to, not a hardcoded id', () => {
    const base = settings.promptTemplates.find((t) => t.id === 'spec')!
    const custom: Settings = {
      ...settings,
      promptTemplates: [...settings.promptTemplates, { ...base, id: 'my-spec', name: 'My spec' }],
      promptRouting: { ...settings.promptRouting, needsSpec: 'my-spec' }
    }
    const sessions = [ref('a', { templateId: 'my-spec' }), ref('b', { templateId: 'spec' })]
    expect(isSpecHandoff(custom, task({ sessions, ...pointAt('a') }))).toBe(true)
    expect(isSpecHandoff(custom, task({ sessions, ...pointAt('b') }))).toBe(false)
  })

  it('falls back to the label for a legacy entry without templateId', () => {
    const specName = settings.promptTemplates.find((t) => t.id === 'spec')!.name
    const sessions = [ref('old', { label: specName })]
    expect(isSpecHandoff(settings, task({ sessions, ...pointAt('old') }))).toBe(true)
    expect(
      isSpecHandoff(
        settings,
        task({ sessions: [ref('old', { label: 'Something' })], ...pointAt('old') })
      )
    ).toBe(false)
  })

  it('is false when there is no pointer or it names a chat missing from sessions', () => {
    expect(isSpecHandoff(settings, task({ agentSession: undefined }))).toBe(false)
    expect(isSpecHandoff(settings, task(pointAt('gone')))).toBe(false)
  })

  it('is false when a pinned template runs both lanes', () => {
    expect(isSpecHandoff(settings, task({ promptTemplateId: 'spec' }))).toBe(false)
  })
})
