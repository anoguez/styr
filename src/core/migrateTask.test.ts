import { describe, expect, it } from 'vitest'
import { parseTaskMarkdown } from './markdown.js'
import { settingsSchema } from './taskSchema.js'

const legacy = `---
id: TASK-0009
title: Old task
status: in_progress
claudeSessionId: aaaa-1111
sessions:
  - id: bbbb-2222
    startedAt: '2026-01-01T00:00:00.000Z'
    label: First run
createdAt: '2026-01-01T00:00:00.000Z'
updatedAt: '2026-01-02T00:00:00.000Z'
---
Body text.
`

describe('provider migration', () => {
  it('loads a Claude-only task file as Claude sessions without losing any chat', () => {
    const task = parseTaskMarkdown(legacy, '/tasks/TASK-0009.md')

    expect(task.agentSession).toEqual({ provider: 'claude', id: 'aaaa-1111' })
    expect(task.sessions).toEqual([
      expect.objectContaining({ id: 'aaaa-1111', provider: 'claude' }),
      {
        id: 'bbbb-2222',
        provider: 'claude',
        startedAt: '2026-01-01T00:00:00.000Z',
        label: 'First run'
      }
    ])
    expect(task).not.toHaveProperty('claudeSessionId')
    expect(task.description).toBe('Body text.')
  })

  it('keeps an existing agentSession and tagged history untouched', () => {
    const raw = `---
id: TASK-0010
title: Mixed
agentSession:
  provider: codex
  id: cx-1
sessions:
  - id: c-1
    provider: claude
    startedAt: '2026-01-01T00:00:00.000Z'
    label: A
  - id: cx-1
    provider: codex
    startedAt: '2026-01-02T00:00:00.000Z'
    label: B
createdAt: '2026-01-01T00:00:00.000Z'
updatedAt: '2026-01-02T00:00:00.000Z'
---
`
    const task = parseTaskMarkdown(raw, '/tasks/TASK-0010.md')

    expect(task.agentSession).toEqual({ provider: 'codex', id: 'cx-1' })
    expect(task.sessions.map((entry) => entry.provider)).toEqual(['claude', 'codex'])
  })

  it('defaults every lane to Claude for settings saved before Codex existed', () => {
    const routing = settingsSchema.shape.providerRouting.parse(undefined)
    expect(routing).toEqual({ spec: 'claude', implement: 'claude', review: 'claude' })
    expect(settingsSchema.shape.defaultProvider.parse(undefined)).toBe('claude')
    expect(settingsSchema.shape.enabledProviders.parse(undefined)).toEqual(['claude'])
  })
})
