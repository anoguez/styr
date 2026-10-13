import { describe, expect, it } from 'vitest'
import { buildRows, editRows, emphasise } from './diffView.js'

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

describe('editRows', () => {
  it('draws an agent patch without line numbers, parts as hunk rows', () => {
    expect(editRows(' a\n-b\n+c\n@@\n-d')).toEqual([
      { kind: 'ctx', segments: [{ text: 'a', em: false }] },
      { kind: 'del', oldLine: undefined, segments: [{ text: 'b', em: false }] },
      { kind: 'add', newLine: undefined, segments: [{ text: 'c', em: false }] },
      { kind: 'hunk', text: '' },
      { kind: 'del', oldLine: undefined, segments: [{ text: 'd', em: false }] }
    ])
  })

  it('emphasises paired lines and drops apply_patch headers', () => {
    const rows = editRows('*** Begin Patch\n*** Update File: a.ts\n@@ fn()\n-let x = 1\n+let x = 2')
    expect(rows[0]).toEqual({ kind: 'hunk', text: 'fn()' })
    expect(rows[1]).toMatchObject({
      kind: 'del',
      segments: [{ text: 'let x = ' }, { text: '1', em: true }]
    })
    expect(rows[2]).toMatchObject({
      kind: 'add',
      segments: [{ text: 'let x = ' }, { text: '2', em: true }]
    })
  })
})
