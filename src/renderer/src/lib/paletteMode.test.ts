import { describe, expect, it } from 'vitest'
import { splitQuery } from './paletteMode.js'

describe('splitQuery', () => {
  it('stays in go mode without a prefix', () => {
    expect(splitQuery('fix')).toEqual({ mode: 'go', text: 'fix' })
  })

  it('treats a leading > as command mode and strips it', () => {
    expect(splitQuery('>settings')).toEqual({ mode: 'command', text: 'settings' })
    expect(splitQuery('>')).toEqual({ mode: 'command', text: '' })
  })

  it('only reads > at the start', () => {
    expect(splitQuery('a>b').mode).toBe('go')
  })
})
