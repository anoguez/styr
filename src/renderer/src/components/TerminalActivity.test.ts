import { describe, expect, it } from 'vitest'
import { activityTime } from './TerminalActivity.js'

describe('activityTime', () => {
  const now = new Date(2026, 9, 22, 15, 0, 0)
  const ago = (ms: number): string => new Date(now.getTime() - ms).toISOString()

  it('says now for the last minute, and minutes for the last hour', () => {
    expect(activityTime(ago(20_000), now)).toBe('now')
    expect(activityTime(ago(4 * 60_000), now)).toBe('4m')
  })

  it('shows the time for earlier today and the date before that', () => {
    const earlier = new Date(2026, 9, 22, 9, 5).toISOString()
    expect(activityTime(earlier, now)).toBe(
      new Date(earlier).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    )
    const before = new Date(2026, 8, 30, 12, 0).toISOString()
    expect(activityTime(before, now)).toBe(
      new Date(before).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    )
  })

  it('is empty for a timestamp it cannot read', () => {
    expect(activityTime('not a date', now)).toBe('')
  })
})
