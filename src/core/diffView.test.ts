import { describe, expect, it } from 'vitest'
import { buildRows, emphasise } from './diffView.js'

const PATCH = [
  '@@ -1,3 +1,3 @@ fn',
  ' keep',
  '-const a = 1',
  '+const a = 2',
  ' tail',
  '@@ -20,2 +20,3 @@',
  ' x',
  '+added',
  ' y',
  ''
].join('\n')

describe('buildRows', () => {
  it('numbers lines, folds the gap between hunks and drops the trailing blank', () => {
    const rows = buildRows(PATCH)
    expect(rows.map((r) => r.kind)).toEqual([
      'hunk',
      'ctx',
      'del',
      'add',
      'ctx',
      'fold',
      'hunk',
      'ctx',
      'add',
      'ctx'
    ])
    expect(rows[5]).toEqual({ kind: 'fold', count: 16 })
    expect(rows[2]).toMatchObject({ kind: 'del', oldLine: 2 })
    expect(rows[3]).toMatchObject({ kind: 'add', newLine: 2 })
  })

  it('emphasises only the changed middle of a paired line', () => {
    const [oldSegs, newSegs] = emphasise('const a = 1', 'const a = 2')
    expect(oldSegs.find((s) => s.em)?.text).toBe('1')
    expect(newSegs.find((s) => s.em)?.text).toBe('2')
  })
})
