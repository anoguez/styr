import { describe, expect, it } from 'vitest'
import { sameDiffStats } from './useDiffStats.js'

const stat = (
  added: number,
  removed = 0,
  files = 1
): { added: number; removed: number; files: number } => ({
  added,
  removed,
  files
})

describe('sameDiffStats', () => {
  it('treats equal contents as the same', () => {
    expect(sameDiffStats(new Map([['a', stat(1)]]), new Map([['a', stat(1)]]))).toBe(true)
    expect(sameDiffStats(new Map(), new Map())).toBe(true)
  })

  it('notices a change, an added task and a removed task', () => {
    expect(sameDiffStats(new Map([['a', stat(1)]]), new Map([['a', stat(2)]]))).toBe(false)
    expect(sameDiffStats(new Map([['a', stat(1)]]), new Map())).toBe(false)
    expect(sameDiffStats(new Map([['a', stat(1)]]), new Map([['b', stat(1)]]))).toBe(false)
  })
})
