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

describe('taskFromTerminal ask', () => {
  const context = { cwd: '/r', command: 'pnpm test', exitCode: 1, text: 'boom' }

  it('titles the task with the question and leads the description with it', () => {
    const task = taskFromTerminal('ask', { ...context, question: 'why does this fail?\nmore' })
    expect(task.title).toBe('why does this fail?')
    expect(task.description.startsWith('why does this fail?\nmore')).toBe(true)
    expect(task.description).toContain('boom')
    expect(task.tags).toEqual(['ask'])
    expect(task.ready).toBe(true)
  })

  it('falls back to the command, then to the terminal, when nothing was asked', () => {
    expect(taskFromTerminal('ask', context).title).toBe('Ask: pnpm test')
    expect(taskFromTerminal('ask', { cwd: '/r', text: '' }).title).toBe('Ask: terminal')
    expect(taskFromTerminal('ask', context).description).toContain('tell me what is going on')
  })

  it('leaves the other kinds as they were', () => {
    const task = taskFromTerminal('explain', context)
    expect(task.title).toBe('Explain: pnpm test')
    expect(task.tags).toBeUndefined()
  })
})
