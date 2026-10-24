import { describe, expect, it } from 'vitest'
import { firstLine, repoForDirectory, taskFromTerminal } from './terminalContext.js'

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

describe('taskFromTerminal fix', () => {
  const context = { cwd: '/r', command: 'pnpm test', exitCode: 1, text: 'boom' }

  it('is ready to dispatch, the other kinds still need a spec', () => {
    expect(taskFromTerminal('fix', context).ready).toBe(true)
    expect(taskFromTerminal('explain', context).ready).toBeUndefined()
    expect(taskFromTerminal('output', context).ready).toBeUndefined()
  })

  it('uses a longer fence when the output has backticks', () => {
    const task = taskFromTerminal('fix', { ...context, text: 'a ```code``` b' })
    expect(task.description).toContain('````\na ```code``` b\n````')
  })

  it('notes clipped output and strips colour codes', () => {
    const task = taskFromTerminal('fix', {
      ...context,
      text: `\x1b[31mred\x1b[0m${'a'.repeat(7000)}`
    })
    expect(task.description).toContain('(output trimmed to the last 6000 characters)')
    expect(task.description).not.toContain('\x1b')
    expect(
      taskFromTerminal('fix', { ...context, text: '\x1b[31mred\x1b[0m' }).description
    ).toContain('\nred\n')
  })

  it('handles a missing command and exit code', () => {
    const task = taskFromTerminal('fix', { cwd: '/r', text: '' })
    expect(task.title).toBe('Fix: terminal failure')
    expect(task.description).not.toContain('Command:')
    expect(task.description).not.toContain('Exit code')
    expect(task.description).not.toContain('with exit code')
  })
})

describe('repoForDirectory', () => {
  it('returns the git root of the directory', async () => {
    const seen: string[] = []
    const root = await repoForDirectory('/repo/src', async (path) => {
      seen.push(path)
      return { root: '/repo' }
    })
    expect(root).toBe('/repo')
    expect(seen).toEqual(['/repo/src'])
  })

  it('falls back to undefined outside a repo or when the lookup fails', async () => {
    expect(await repoForDirectory('/tmp', async () => ({ root: null }))).toBeUndefined()
    expect(
      await repoForDirectory('/tmp', async () => {
        throw new Error('gone')
      })
    ).toBeUndefined()
  })
})
