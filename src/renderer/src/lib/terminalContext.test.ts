import { describe, expect, it } from 'vitest'
import { firstLine, taskFromTerminal } from './terminalContext.js'

describe('taskFromTerminal', () => {
  it('describes a failed command with its exit code and output', () => {
    const task = taskFromTerminal('fix', {
      cwd: '/repo',
      command: 'pnpm test',
      exitCode: 1,
      text: 'AssertionError'
    })
    expect(task.title).toBe('Fix: pnpm test')
    expect(task.description).toContain('failed with exit code 1')
    expect(task.description).toContain('Directory: `/repo`')
    expect(task.description).toContain('AssertionError')
  })

  it('keeps the tail of very long output', () => {
    const task = taskFromTerminal('output', { cwd: '/r', text: `${'a'.repeat(9000)}END` })
    expect(task.description).toContain('END')
    expect(task.description.length).toBeLessThan(7000)
  })

  it('says so when nothing was captured, and caps the title', () => {
    const task = taskFromTerminal('ask', { cwd: '/r', command: 'x'.repeat(200), text: '' })
    expect(task.description).toContain('(no output captured)')
    expect(task.title.length).toBeLessThanOrEqual(80)
  })
})

describe('firstLine', () => {
  it('skips blank lines', () => {
    expect(firstLine('\n  \n hello \nworld')).toBe('hello')
  })
})
