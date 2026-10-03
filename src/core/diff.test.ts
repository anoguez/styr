import { describe, expect, it } from 'vitest'
import {
  cleanPatch,
  countPatchLines,
  parseNameStatus,
  parseNumstat,
  untrackedFiles
} from './diff.js'

describe('diff parsers', () => {
  it('joins numstat with name-status, including renames and odd paths', () => {
    const statuses = parseNameStatus(
      'M\0src/a b.ts\0R100\0old.ts\0new é.ts\0D\0gone.ts\0A\0img.png\0'
    )
    const files = parseNumstat(
      '3\t1\tsrc/a b.ts\0' + '0\t0\t\0old.ts\0new é.ts\0' + '0\t5\tgone.ts\0' + '-\t-\timg.png\0',
      statuses
    )
    expect(files).toEqual([
      {
        path: 'src/a b.ts',
        oldPath: undefined,
        status: 'modified',
        additions: 3,
        deletions: 1,
        binary: false
      },
      {
        path: 'new é.ts',
        oldPath: 'old.ts',
        status: 'renamed',
        additions: 0,
        deletions: 0,
        binary: false
      },
      {
        path: 'gone.ts',
        oldPath: undefined,
        status: 'deleted',
        additions: 0,
        deletions: 5,
        binary: false
      },
      {
        path: 'img.png',
        oldPath: undefined,
        status: 'added',
        additions: 0,
        deletions: 0,
        binary: true
      }
    ])
  })

  it('lists untracked files not already known', () => {
    expect(untrackedFiles('a.txt\0b c.txt\0', new Set(['a.txt'])).map((f) => f.path)).toEqual([
      'b c.txt'
    ])
  })

  it('counts patch lines and strips the preamble', () => {
    const patch = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-old\n+new\n same\n'
    expect(countPatchLines(patch)).toEqual({ additions: 1, deletions: 1 })
    expect(cleanPatch(patch).startsWith('@@')).toBe(true)
  })
})
