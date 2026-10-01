import { describe, expect, it, vi } from 'vitest'
import { TaskLaunchGate } from './taskLaunchGate.js'

describe('TaskLaunchGate', () => {
  it('coalesces simultaneous launches for the same task', async () => {
    const gate = new TaskLaunchGate()
    let resolveLaunch: ((value: string) => void) | undefined
    const launch = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveLaunch = resolve
        })
    )

    const first = gate.run('TASK-0007', launch)
    const second = gate.run('TASK-0007', launch)
    await Promise.resolve()
    resolveLaunch?.('terminal-1')

    await expect(Promise.all([first, second])).resolves.toEqual(['terminal-1', 'terminal-1'])
    expect(launch).toHaveBeenCalledOnce()
  })

  it('allows a new launch after the previous one finishes', async () => {
    const gate = new TaskLaunchGate()
    const launch = vi.fn().mockResolvedValue('terminal-1')

    await gate.run('TASK-0007', launch)
    await gate.run('TASK-0007', launch)

    expect(launch).toHaveBeenCalledTimes(2)
  })
})
