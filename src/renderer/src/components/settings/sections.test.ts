import { describe, expect, it } from 'vitest'
import type { Settings } from '@core/types.js'
import { SECTIONS, scopeNoteFor, sectionShown, settingsNav, unsavedChanges } from './sections.js'

const off = { externalSources: false, nativeTerminal: false }
const on = { externalSources: true, nativeTerminal: false }
const github = SECTIONS.find((section) => section.id === 'source-github')!

const settings = (overrides: Partial<Settings> = {}): Settings =>
  ({
    doneCap: { maxCount: 20, maxAgeDays: 0 },
    shell: '',
    theme: { base: '#000000' },
    shortcuts: {},
    storageDir: '/data',
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
    expect([...changes.sections]).toEqual(['preferences'])
    expect(unsavedChanges(saved, settings()).count).toBe(0)
  })

  it('groups the nav, hiding flagged sections and empty groups', () => {
    const groups = settingsNav('', off)
    expect(groups.map((group) => group.label)).toEqual(['Workspace', 'All workspaces'])
    expect(groups[0]!.picker).toBe(true)
    expect(settingsNav('', on).map((group) => group.label)).toContain('Integrations')
  })

  it('filters the nav by label and search words, case-insensitively', () => {
    const ids = (search: string): string[] =>
      settingsNav(search, on).flatMap((group) => group.items.map((item) => item.id))
    expect(ids('  KEYBOARD ')).toEqual(['shortcuts'])
    expect(ids('github')).toEqual(['source-github', 'experimental'])
    expect(settingsNav('nothing matches this', on)).toEqual([])
  })

  it('says where a section is stored', () => {
    expect(scopeNoteFor('app', 'Work')).toMatch(/shared by every workspace/)
    expect(scopeNoteFor('workspace', 'Work')).toMatch(/Work workspace folder/)
  })
})
