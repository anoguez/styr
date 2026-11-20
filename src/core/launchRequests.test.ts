import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  awaitLaunchResult,
  claimLaunchRequests,
  LAUNCH_REQUEST_TTL_MS,
  launchRequestsDir,
  writeLaunchRequest,
  writeLaunchResult,
  type LaunchWait
} from './launchRequests.js'
import type { Settings } from './types.js'

let dir: string
let settings: Settings

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'styr-launch-requests-test-'))
  settings = { storageDir: dir, activeWorkspaceId: 'default' } as Settings
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

/** A clock that only moves when the waiter sleeps, running `onSleep` at each step. */
function fakeWait(onSleep: (elapsed: number) => void = () => {}): LaunchWait {
  let now = 0
  return {
    now: () => now,
    sleep: async (ms) => {
      now += ms
      onSleep(now)
    }
  }
}

describe('launch requests', () => {
  it('a written request is claimed once, then gone', () => {
    const now = new Date('2026-01-01T00:00:00Z')
    const written = writeLaunchRequest(settings, { taskId: 'TASK-0001', startAnyway: true }, now)
    expect(claimLaunchRequests(settings, now.getTime())).toEqual([written])
    expect(claimLaunchRequests(settings, now.getTime())).toEqual([])
    expect(readdirSync(launchRequestsDir(settings))).toEqual([])
  })

  it('drops expired and unreadable requests without launching them', () => {
    const now = new Date('2026-01-01T00:00:00Z')
    writeLaunchRequest(settings, { taskId: 'TASK-0001' }, now)
    writeFileSync(
      join(launchRequestsDir(settings), '00000000-0000-4000-8000-000000000000.json'),
      'not json'
    )
    expect(claimLaunchRequests(settings, now.getTime() + LAUNCH_REQUEST_TTL_MS + 1)).toEqual([])
    expect(readdirSync(launchRequestsDir(settings))).toEqual([])
  })

  it('the waiter reads the answer and cleans it up', async () => {
    const { id } = writeLaunchRequest(settings, { taskId: 'TASK-0001' })
    const result = { ok: true as const, sessionId: 's1', taskId: 'TASK-0001' }
    const answer = awaitLaunchResult(
      settings,
      id,
      fakeWait(() => {
        claimLaunchRequests(settings)
        writeLaunchResult(settings, id, result)
      })
    )
    expect(await answer).toEqual(result)
    expect(readdirSync(launchRequestsDir(settings))).toEqual([])
  })

  it('withdraws a request nobody claims, so a Styr opened later never starts it', async () => {
    const { id } = writeLaunchRequest(settings, { taskId: 'TASK-0001' })
    const result = await awaitLaunchResult(settings, id, fakeWait())
    expect(result).toMatchObject({ ok: false })
    expect(readdirSync(launchRequestsDir(settings))).toEqual([])
  })

  it('keeps waiting past the claim deadline once the host has taken the request', async () => {
    const { id } = writeLaunchRequest(settings, { taskId: 'TASK-0001' })
    claimLaunchRequests(settings)
    const result = await awaitLaunchResult(
      settings,
      id,
      fakeWait((elapsed) => {
        if (elapsed > LAUNCH_REQUEST_TTL_MS * 2) {
          writeLaunchResult(settings, id, { ok: false, error: 'boom' })
        }
      })
    )
    expect(result).toEqual({ ok: false, error: 'boom' })
  })
})
