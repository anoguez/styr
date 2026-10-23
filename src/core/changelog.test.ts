import { describe, expect, it } from 'vitest'
import {
  compareVersions,
  parseChangelog,
  sectionsBetween,
  whatsNewToShow,
  WHATS_NEW_CAP
} from './changelog.js'

const SAMPLE = `# Changelog

## [0.37.2](https://github.com/anoguez/styr/compare/v0.37.1...v0.37.2) (2026-10-22)


### Bug Fixes

* never drop lines under a task's Activity heading ([#191](https://github.com/anoguez/styr/issues/191)) ([a8db53f](https://github.com/anoguez/styr/commit/a8db53f))

## [0.37.1](https://github.com/anoguez/styr/compare/v0.37.0...v0.37.1) (2026-10-22)


### Bug Fixes

* activity timeline order ([#189](https://github.com/anoguez/styr/issues/189))
* run External sources ([#187](https://github.com/anoguez/styr/issues/187))

## [0.37.0](https://github.com/anoguez/styr/compare/v0.36.1...v0.37.0) (2026-10-22)


### Features

* task activity panel ([#188](https://github.com/anoguez/styr/issues/188))

### Performance

* keep git off the main thread

## [0.1.0](https://github.com/anoguez/styr/releases/tag/v0.1.0) (2026-01-01)
`

const sections = parseChangelog(SAMPLE)

describe('parseChangelog', () => {
  it('reads versions, dates, groups and bullets', () => {
    expect(sections.map((s) => s.version)).toEqual(['0.37.2', '0.37.1', '0.37.0', '0.1.0'])
    expect(sections[0]).toMatchObject({ date: '2026-10-22', groups: [{ title: 'Bug Fixes' }] })
    expect(sections[1]!.groups[0]!.items).toHaveLength(2)
    expect(sections[2]!.groups.map((g) => g.title)).toEqual(['Features', 'Performance'])
  })

  it('keeps a section with no groups', () => {
    expect(sections[3]).toEqual({ version: '0.1.0', date: '2026-01-01', groups: [] })
  })

  it('ignores text before the first section and tolerates garbage', () => {
    expect(parseChangelog('nothing here')).toEqual([])
    expect(parseChangelog('')).toEqual([])
  })
})

describe('compareVersions', () => {
  it('compares numerically and ignores pre-release suffixes', () => {
    expect(compareVersions('0.9.0', '0.10.0')).toBeLessThan(0)
    expect(compareVersions('1.0.0', '0.99.99')).toBeGreaterThan(0)
    expect(compareVersions('0.38.0-beta.1', '0.38.0')).toBe(0)
  })
})

describe('sectionsBetween', () => {
  it('is empty for equal versions', () => {
    expect(sectionsBetween(sections, '0.37.2', '0.37.2')).toEqual([])
  })
  it('lists skipped versions newest first, excluding the seen one', () => {
    expect(sectionsBetween(sections, '0.37.0', '0.37.2').map((s) => s.version)).toEqual([
      '0.37.2',
      '0.37.1'
    ])
  })
  it('is empty on a downgrade', () => {
    expect(sectionsBetween(sections, '0.37.2', '0.37.0')).toEqual([])
  })
  it('is empty when the current version has no section and nothing newer exists', () => {
    expect(sectionsBetween(sections, '0.37.2', '0.37.3')).toEqual([])
  })
})

describe('whatsNewToShow', () => {
  const many = Array.from({ length: 8 }, (_, i) => ({
    version: `0.${40 - i}.0`,
    date: '',
    groups: []
  }))
  const cases: [string, string | null, string, boolean, number, string | null][] = [
    ['fresh install', null, '0.37.2', true, 4, null],
    ['same version', '0.37.2', '0.37.2', true, 4, null],
    ['downgrade', '0.37.2', '0.37.0', true, 4, null],
    ['dev build', '0.37.0', '0.37.2', false, 4, null],
    ['upgrade', '0.37.0', '0.37.2', true, 4, '0.37.2,0.37.1']
  ]
  it.each(cases)('%s', (_name, seen, current, packaged, _n, expected) => {
    const result = whatsNewToShow(seen, current, packaged, sections)
    expect(result.store).toBe(current)
    expect(result.show?.map((s) => s.version).join(',') ?? null).toBe(expected)
  })

  it('shows nothing when the changelog has no entry in range', () => {
    expect(whatsNewToShow('0.37.2', '0.37.3', true, sections).show).toBeNull()
  })

  it('caps the sections and says so', () => {
    const result = whatsNewToShow('0.30.0', '0.40.0', true, many)
    expect(result.show).toHaveLength(WHATS_NEW_CAP)
    expect(result.truncated).toBe(true)
    expect(result.show![0]!.version).toBe('0.40.0')
  })
})
