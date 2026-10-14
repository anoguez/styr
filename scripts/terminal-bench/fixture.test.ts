import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
// @ts-expect-error: a plain .mjs script with no declarations.
import * as fixtureScript from './fixture.mjs'

const { makeOutput } = fixtureScript as { makeOutput: (bytes: number) => Buffer }

describe('terminal bench fixtures', () => {
  it('writes at least the size asked for, in whole lines', () => {
    const output = makeOutput(64 * 1024)
    expect(output.length).toBeGreaterThanOrEqual(64 * 1024)
    expect(output.subarray(-2).toString()).toBe('\r\n')
  })

  it('is the same bytes on every run, so runs compare', () => {
    const digest = (): string =>
      createHash('sha256')
        .update(makeOutput(256 * 1024))
        .digest('hex')
    expect(digest()).toBe(digest())
  })

  it('mixes colours, unicode and long lines', () => {
    const text = makeOutput(8 * 1024).toString()
    expect(text).toContain('\x1b[38;2;')
    expect(text).toContain('漢字')
    expect(text).toMatch(/x{150,}/)
  })
})
