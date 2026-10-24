import { describe, expect, it } from 'vitest'
import { checkedIds, initialSelection, mergeSelection, orderDiffers } from './dispatchSelection.js'

describe('dispatchSelection', () => {
  it('starts in plan order with everything checked', () => {
    const s = initialSelection(['A', 'B'])
    expect(s).toEqual({ order: ['A', 'B'], skipped: [] })
    expect(checkedIds(s)).toEqual(['A', 'B'])
  })

  it('keeps order and unchecks for ids still in the plan, drops gone ids, appends new ones checked', () => {
    const merged = mergeSelection({ order: ['C', 'A', 'B'], skipped: ['A', 'B'] }, ['A', 'D', 'C'])
    expect(merged).toEqual({ order: ['C', 'A', 'D'], skipped: ['A'] })
    expect(checkedIds(merged)).toEqual(['C', 'D'])
  })

  it('checkedIds follows the user order and omits skipped rows', () => {
    expect(checkedIds({ order: ['B', 'A', 'C'], skipped: ['A'] })).toEqual(['B', 'C'])
  })

  it('reports a changed order but not changed checks', () => {
    expect(orderDiffers({ order: ['A', 'B'], skipped: ['A'] }, ['A', 'B'])).toBe(false)
    expect(orderDiffers({ order: ['B', 'A'], skipped: [] }, ['A', 'B'])).toBe(true)
  })
})
