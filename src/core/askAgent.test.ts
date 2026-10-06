import { describe, expect, it } from 'vitest'
import { askTitle, forkDescription } from './askAgent.js'

describe('askTitle', () => {
  it('uses the first non-blank line of the question', () => {
    expect(askTitle('\n  why does this fail?  \nmore detail', 'x')).toBe('why does this fail?')
  })
  it('falls back when the question is empty', () => {
    expect(askTitle('  \n', 'Ask: pnpm test')).toBe('Ask: pnpm test')
  })
  it('clips to 80 characters', () => {
    const title = askTitle('q'.repeat(200), 'x')
    expect(title).toHaveLength(80)
    expect(title.endsWith('…')).toBe(true)
  })
})

describe('forkDescription', () => {
  it('leads with the question and names the source', () => {
    const text = forkDescription('why?', { id: 'TASK-0007', title: 'Fix login' })
    expect(text.startsWith('why?')).toBe(true)
    expect(text).toContain('Forked from TASK-0007: Fix login.')
  })
  it('has a generic ask for an empty question', () => {
    expect(forkDescription('', { id: 'T', title: 't' })).toContain('tell me what is going on')
  })
})
