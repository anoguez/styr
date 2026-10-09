import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readAgentStatus, statusFilePath } from './agentStore.js'
import { buildHookSettings } from './providers/claude.js'
import type { Settings } from './types.js'

let dir: string
let settings: Settings

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'styr-agent-store-test-'))
  settings = { storageDir: dir, activeWorkspaceId: 'default' } as Settings
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

function write(event: string, payload: Record<string, unknown> | null): void {
  const record = { taskId: 'TASK-0001', event, at: '2026-01-01T00:00:00Z', payload }
  writeFileSync(statusFilePath(settings, 'TASK-0001'), JSON.stringify(record))
}

describe('readAgentStatus', () => {
  it('reads an idle-prompt notification as idle, not waiting', () => {
    write('Notification', { notification_type: 'idle_prompt', message: 'whatever' })
    expect(readAgentStatus(settings, 'TASK-0001')?.state).toBe('idle')
  })

  it('recognises the idle prompt by its message when the type is missing', () => {
    write('Notification', { message: 'Claude is waiting for your input' })
    expect(readAgentStatus(settings, 'TASK-0001')?.state).toBe('idle')
  })

  it('still reads a permission prompt as waiting', () => {
    write('Notification', { notification_type: 'permission_prompt', message: 'Allow Bash?' })
    expect(readAgentStatus(settings, 'TASK-0001')?.state).toBe('waiting')
    write('Notification', null)
    expect(readAgentStatus(settings, 'TASK-0001')?.state).toBe('waiting')
  })
})

describe('buildHookSettings', () => {
  it('hooks only the notifications that need you', () => {
    const { hooks } = JSON.parse(buildHookSettings(settings, 'TASK-0001'))
    expect(hooks.Notification[0].matcher).toBe('permission_prompt|elicitation_dialog')
    expect(hooks.Stop[0].matcher).toBeUndefined()
  })
})
