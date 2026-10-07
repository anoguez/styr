import { describe, expect, it } from 'vitest'
import {
  currentWindow,
  parseCodexRollout,
  parseContextFile,
  parseUsageFile,
  resetsIn
} from './usage.js'

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

describe('resetsIn', () => {
  const now = Date.parse('2026-10-07T10:00:00Z')
  it('spells the time left', () => {
    expect(resetsIn('2026-10-07T12:14:30Z', now)).toBe('2h 14m')
    expect(resetsIn('2026-10-07T10:38:00Z', now)).toBe('38m')
    expect(resetsIn('2026-10-07T10:00:20Z', now)).toBe('<1m')
    expect(resetsIn('2026-10-09T13:00:00Z', now)).toBe('2d 3h')
  })

  it('is null when unknown or past', () => {
    expect(resetsIn(undefined, now)).toBeNull()
    expect(resetsIn('2026-10-07T09:00:00Z', now)).toBeNull()
  })
})

describe('parseCodexRollout', () => {
  const event = (percent: number, tokens: number): string =>
    JSON.stringify({
      timestamp: '2026-10-07T10:00:00.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { last_token_usage: { total_tokens: tokens }, model_context_window: 200000 },
        rate_limits: {
          primary: { used_percent: percent, window_minutes: 300, resets_at: 1791299021 },
          secondary: { used_percent: 13, window_minutes: 10080, resets_at: 1791602354 }
        }
      }
    })

  it('reads the newest token_count, naming windows by length', () => {
    const read = parseCodexRollout(
      ['cut off mid-line {', event(2, 1000), '{"type":"other"}', event(9, 50000), ''].join('\n')
    )
    expect(read?.usage?.windows.map((w) => [w.kind, w.percentUsed])).toEqual([
      ['five_hour', 9],
      ['seven_day', 13]
    ])
    expect(read?.usage?.windows[0]?.resetsAt).toBe(new Date(1791299021 * 1000).toISOString())
    expect(read?.context).toEqual({ percent: 25, tokens: 50000, window: 200000 })
  })

  it('is null when there is no reading yet', () => {
    expect(parseCodexRollout('{"type":"session_meta"}\n')).toBeNull()
  })
})
