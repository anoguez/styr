import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { providerForLane } from '../orchestrate.js'
import { syntaxFor } from '../shell.js'
import { providerById, withoutSessionMarkers } from './index.js'

const workspace = mkdtempSync(join(tmpdir(), 'styr-provider-test-'))
afterAll(() => rmSync(workspace, { recursive: true, force: true }))

describe('provider routing', () => {
  it('sends each lane to its configured provider', () => {
    const settings = {
      providerRouting: { spec: 'claude', implement: 'codex', review: 'codex' }
    } as const
    expect(providerForLane(settings, 'spec')).toBe('claude')
    expect(providerForLane(settings, 'implement')).toBe('codex')
    expect(providerForLane(settings, 'review')).toBe('codex')
  })

  it('resumes each provider through its own command', () => {
    const settings = {
      storageDir: workspace,
      activeWorkspaceId: 'default',
      claudeCommand: 'claude',
      codexCommand: 'codex',
      codexApprovalReviewer: 'user'
    } as never
    const input = {
      settings,
      taskId: 'T',
      sessionId: 'sid',
      resume: true,
      cwd: '/w',
      syntax: syntaxFor('posix')
    }
    expect(providerById('claude').buildCommand(input)).toContain('--resume sid')
    expect(providerById('codex').buildCommand(input)).toContain('codex resume')
    expect(providerById('codex').buildCommand(input)).toContain(' sid')
  })

  it('strips both providers session markers from a terminal environment', () => {
    const env = withoutSessionMarkers({ CODEX_THREAD_ID: 'x', CLAUDECODE: '1', HOME: '/h' })
    expect(env).toEqual({ HOME: '/h' })
  })
})
