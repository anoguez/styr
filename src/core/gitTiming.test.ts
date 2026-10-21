import { beforeEach, describe, expect, it } from 'vitest'
import { clearSlowGitCalls, recordGitCall, SLOW_GIT_MS, slowGitCalls } from './gitTiming.js'

beforeEach(clearSlowGitCalls)

describe('recordGitCall', () => {
  it('keeps only calls at or over the threshold, with the last folder segment', () => {
    recordGitCall(['status'], '/repo', SLOW_GIT_MS - 1, true)
    recordGitCall(['worktree', 'remove', '/w'], '/Users/me/repo/', 1450.4, true)
    expect(slowGitCalls()).toEqual([
      {
        command: 'git worktree remove /w',
        folder: 'repo',
        ms: 1450,
        blocking: true,
        at: expect.any(String)
      }
    ])
  })

  it('keeps the newest 50', () => {
    for (let n = 0; n < 60; n++) recordGitCall([`call-${n}`], '/repo', SLOW_GIT_MS, false)
    const calls = slowGitCalls()
    expect(calls).toHaveLength(50)
    expect(calls[0]?.command).toBe('git call-10')
    expect(calls[49]?.command).toBe('git call-59')
  })
})
