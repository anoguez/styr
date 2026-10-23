import { describe, expect, it } from 'vitest'
import { getSection, setSection } from './sections.js'

describe('getSection', () => {
  it('reads the body up to the next ## heading', () => {
    const text = 'Intro\n\n## Handoff\n\nDone.\nMore.\n\n## Other\n\nx'
    expect(getSection(text, 'Handoff')).toBe('Done.\nMore.')
  })

  it('matches the heading case-insensitively, as a whole line only', () => {
    expect(getSection('## HANDOFF\nbody', 'handoff')).toBe('body')
    expect(getSection('### Handoff\nbody', 'Handoff')).toBeUndefined()
    expect(getSection('## Handoff notes\nbody', 'Handoff')).toBeUndefined()
  })

  it('runs to the end of the description and is undefined when absent', () => {
    expect(getSection('a\n## Split into\n- one', 'Split into')).toBe('- one')
    expect(getSection('nothing here', 'Handoff')).toBeUndefined()
  })

  it('ignores headings inside code fences', () => {
    const text = '## Handoff\n\n```\n## Not a heading\n```\n\nafter'
    expect(getSection(text, 'Handoff')).toContain('after')
  })
})

describe('setSection', () => {
  it('appends a missing section', () => {
    expect(setSection('Spec.', 'Handoff', 'Hi')).toBe('Spec.\n\n## Handoff\n\nHi')
    expect(setSection('', 'Handoff', 'Hi')).toBe('## Handoff\n\nHi')
  })

  it('replaces an existing section in place and keeps its neighbours', () => {
    const before = 'Spec.\n\n## Handoff\n\nold\n\n## Notes\n\nkeep'
    expect(setSection(before.replace('## Handoff', '## HANDOFF'), 'Handoff', 'new')).toBe(
      'Spec.\n\n## Handoff\n\nnew\n\n## Notes\n\nkeep'
    )
  })

  it('never duplicates on a second call', () => {
    const once = setSection('Spec.', 'Handoff', 'one')
    const twice = setSection(once, 'Handoff', 'two')
    expect(twice.match(/## Handoff/g)).toHaveLength(1)
    expect(getSection(twice, 'Handoff')).toBe('two')
  })
})
