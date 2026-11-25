import { describe, expect, it, vi } from 'vitest'
import { killProcessTree, withWindowsTreeKill, type RunSync } from './windowsTreeKill'

function fakePty(calls: string[]) {
  return {
    pid: 4242,
    onData: () => undefined,
    onExit: () => undefined,
    write: () => undefined,
    resize: () => undefined,
    kill: () => {
      calls.push('pty.kill')
    }
  }
}

describe('withWindowsTreeKill', () => {
  it('on Windows ends the shell’s process tree before node-pty closes the console', () => {
    const calls: string[] = []
    const pty = withWindowsTreeKill(fakePty(calls), 'win32', (pid) => calls.push(`tree ${pid}`))
    pty.kill()
    expect(calls).toEqual(['tree 4242', 'pty.kill'])
  })

  it('still closes the console when killing the tree throws', () => {
    const calls: string[] = []
    const pty = withWindowsTreeKill(fakePty(calls), 'win32', () => {
      throw new Error('taskkill missing')
    })
    expect(() => pty.kill()).toThrow('taskkill missing')
    expect(calls).toEqual(['pty.kill'])
  })

  it.each(['linux', 'darwin'] as const)('leaves the pty alone on %s', (platform) => {
    const calls: string[] = []
    const killTree = vi.fn()
    const original = fakePty(calls)
    const kill = original.kill
    const pty = withWindowsTreeKill(original, platform, killTree)
    expect(pty.kill).toBe(kill)
    pty.kill()
    expect(killTree).not.toHaveBeenCalled()
    expect(calls).toEqual(['pty.kill'])
  })
})

describe('killProcessTree', () => {
  it('force-kills the pid and its descendants, hidden, with a timeout', () => {
    const run = vi.fn<RunSync>()
    killProcessTree(4242, run)
    expect(run).toHaveBeenCalledWith('taskkill', ['/PID', '4242', '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 5_000
    })
  })
})
