import { describe, expect, it } from 'vitest'
import { currentWindow, parseContextFile, parseUsageFile } from './usage.js'

const file = JSON.stringify({
  at: '2026-10-07T10:00:00.000Z',
  rateLimits: [
    { kind: 'five_hour', percentUsed: 54, resetsAt: '2026-10-07T11:30:00.000Z' },
    { kind: 'seven_day', percentUsed: 25 },
    { kind: 'bad', percentUsed: 'x' }
  ]
})

describe('parseUsageFile', () => {
  it('keeps well-formed windows and drops the rest', () => {
    expect(parseUsageFile(file)?.windows.map((w) => w.kind)).toEqual(['five_hour', 'seven_day'])
  })

  it('returns null for garbage', () => {
    expect(parseUsageFile('{"at":')).toBeNull()
    expect(parseUsageFile('[]')).toBeNull()
    expect(parseUsageFile('{"at":"x"}')).toBeNull()
  })
})

describe('currentWindow', () => {
  const usage = parseUsageFile(file)
  it('finds a window that has not reset', () => {
    expect(currentWindow(usage, 'five_hour', Date.parse('2026-10-07T11:00:00Z'))?.percentUsed).toBe(
      54
    )
  })

  it('drops a window whose reset has passed', () => {
    expect(currentWindow(usage, 'five_hour', Date.parse('2026-10-07T12:00:00Z'))).toBeNull()
  })

  it('is null without usage or the window', () => {
    expect(currentWindow(null, 'five_hour', 0)).toBeNull()
    expect(currentWindow(usage, 'nope', 0)).toBeNull()
  })
})

describe('parseContextFile', () => {
  it('reads the fill, with tokens and window when present', () => {
    expect(
      parseContextFile('{"at":"x","context":{"percent":42,"tokens":84000,"window":200000}}')
    ).toEqual({ percent: 42, tokens: 84000, window: 200000 })
    expect(parseContextFile('{"context":{"percent":7}}')).toEqual({ percent: 7 })
  })

  it('returns null without a numeric percent', () => {
    expect(parseContextFile('{"context":{}}')).toBeNull()
    expect(parseContextFile('nope')).toBeNull()
  })
})
