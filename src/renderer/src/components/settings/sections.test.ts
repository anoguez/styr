import { describe, expect, it } from 'vitest'
import type { Settings } from '@core/types.js'
import { SECTIONS, scopeNoteFor, sectionShown, settingsNav, unsavedChanges } from './sections.js'

const off = {
  externalSources: false,
  nativeTerminal: false,
  worklog: false,
  remoteWorkspaces: false
}
const on = { externalSources: true, nativeTerminal: false, worklog: false, remoteWorkspaces: false }
const github = SECTIONS.find((section) => section.id === 'source-github')!

const settings = (overrides: Partial<Settings> = {}): Settings =>
  ({
    doneCap: { maxCount: 20, maxAgeDays: 0 },
    autoArchiveAsk: true,
    shell: '',
    theme: { base: '#000000' },
    shortcuts: {},
    storageDir: '/data',
    sources: [],
    ...overrides
  }) as unknown as Settings

describe('settings sections', () => {
  it('shows a flagged section only while its feature is on', () => {
    expect(sectionShown(github, off)).toBe(false)
    expect(sectionShown(github, on)).toBe(true)
    expect(sectionShown(SECTIONS[0], off)).toBe(true)
  })

  it('every section edits keys no other section claims', () => {
    const keys = SECTIONS.flatMap((section) => [...section.keys])
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('counts changed keys and marks the sections they belong to', () => {
    const saved = settings()
    const draft = settings({ shell: 'zsh', doneCap: { maxCount: 5, maxAgeDays: 0 } })
    const changes = unsavedChanges(draft, saved)
    expect(changes.count).toBe(2)
    expect([...changes.sections]).toEqual(['preferences', 'environment'])
    expect(unsavedChanges(saved, settings()).count).toBe(0)
  })

  it('marks only the Integrations page whose provider changed', () => {
    const rest = { id: 'rest', provider: 'rest', enabled: false } as Settings['sources'][number]
    const saved = settings({ sources: [rest] })
    const changes = unsavedChanges(settings({ sources: [{ ...rest, enabled: true }] }), saved)
    expect([...changes.sections]).toEqual(['source-rest'])
    expect(changes.count).toBe(1)
  })

  it('marks the REST page when any of its sources is added, changed or removed', () => {
    const rest = { id: 'rest', provider: 'rest', enabled: false } as Settings['sources'][number]
    const other = { ...rest, id: 'rest-2' }
    const saved = settings({ sources: [rest] })
    const sectionsOf = (sources: Settings['sources']): string[] => [
      ...unsavedChanges(settings({ sources }), saved).sections
    ]
    expect(sectionsOf([rest, other])).toEqual(['source-rest'])
    expect(sectionsOf([])).toEqual(['source-rest'])
    expect(sectionsOf([rest, { ...rest, id: 'github', provider: 'github' }])).toEqual([
      'source-github'
    ])
  })

  it('groups the nav, hiding flagged sections and empty groups', () => {
    const groups = settingsNav('', off)
    expect(groups.map((group) => group.label)).toEqual(['Workspace', 'All workspaces'])
    expect(groups[0]!.picker).toBe(true)
    expect(groups[0]!.subs.map((sub) => sub.label)).toEqual(['Board', 'Agents', 'Environment'])
    const board = (flags: typeof on): string[] =>
      settingsNav('', flags)[0]!.subs[0]!.items.map((item) => item.id)
    expect(board(on)).toEqual(['preferences', 'presets', 'source-github', 'source-rest', 'theme'])
    expect(board(off)).toEqual(['preferences', 'presets', 'theme'])
  })

  it('files every workspace page under a sub-heading and marks the live app pages', () => {
    for (const item of SECTIONS) {
      expect('sub' in item).toBe(item.scope === 'workspace')
    }
    expect(SECTIONS.filter((item) => 'live' in item).map((item) => item.id)).toEqual([
      'workspaces',
      'remote-access',
      'remote'
    ])
  })

  it('filters the nav by label and search words, case-insensitively', () => {
    const ids = (search: string): string[] =>
      settingsNav(search, on).flatMap((group) =>
        group.subs.flatMap((sub) => sub.items.map((item) => item.id))
      )
    expect(ids('  KEYBOARD ')).toEqual(['shortcuts'])
    expect(ids('github')).toEqual(['source-github', 'experimental'])
    expect(ids('restore')).toEqual(['environment'])
    expect(settingsNav('nothing matches this', on)).toEqual([])
  })

  it('says where a section is stored', () => {
    expect(scopeNoteFor('app', 'Work')).toMatch(/shared by every workspace/)
    expect(scopeNoteFor('workspace', 'Work')).toMatch(/Work workspace folder/)
  })
})
