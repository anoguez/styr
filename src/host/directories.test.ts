import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { listDirectories } from './directories.js'

describe('listDirectories', () => {
  const made: string[] = []
  afterEach(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('lists the visible sub-directories, sorted, and the parent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'styr-dirs-'))
    made.push(dir)
    for (const name of ['beta', 'Alpha', '.hidden']) mkdirSync(join(dir, name))
    writeFileSync(join(dir, 'file.txt'), '')
    expect(listDirectories(dir)).toEqual({
      path: dir,
      parent: join(dir, '..'),
      names: ['Alpha', 'beta']
    })
  })

  it('reads ~ as the home folder, and gives the root no parent', () => {
    expect(listDirectories('~').path).toBe(homedir())
    expect(listDirectories(parse(tmpdir()).root).parent).toBeNull()
  })

  it('lists nothing for a folder it cannot read', () => {
    expect(listDirectories(join(tmpdir(), 'styr-no-such-folder')).names).toEqual([])
  })
})
