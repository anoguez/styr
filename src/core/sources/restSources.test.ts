import { describe, expect, it } from 'vitest'
import type { SourceConfig } from './types.js'
import { duplicateRestSource, newRestSource, sourceName } from './restSources.js'

const github = { id: 'github', provider: 'github', enabled: true } as SourceConfig

describe('REST sources', () => {
  it('names a source by its own name, or by REST API / its provider', () => {
    expect(sourceName({ ...github })).toBe('github')
    expect(sourceName({ ...newRestSource([]), name: '  ' })).toBe('REST API')
    expect(sourceName({ ...newRestSource([]), name: 'Jira' })).toBe('Jira')
  })

  it('gives the first source the plain id, then fresh ids and numbered names', () => {
    const first = newRestSource([github])
    expect(first).toMatchObject({ id: 'rest', name: 'REST API', enabled: false, pollMinutes: 0 })
    const second = newRestSource([github, first], () => 'abc')
    expect(second).toMatchObject({ id: 'rest-abc', name: 'REST API 2' })
    const ids = ['abc', 'abc', 'def']
    const third = newRestSource([github, first, second], () => ids.shift()!)
    expect(third).toMatchObject({ id: 'rest-def', name: 'REST API 3' })
  })

  it('duplicates a source switched off, under a new id and name', () => {
    const jira: SourceConfig = { ...newRestSource([]), name: 'Jira', enabled: true }
    const copy = duplicateRestSource([jira], jira, () => 'x1')
    expect(copy).toMatchObject({ id: 'rest-x1', name: 'Jira copy', enabled: false })
    expect(copy.rest).toEqual(jira.rest)
    expect(copy.rest).not.toBe(jira.rest)
    expect(duplicateRestSource([jira, copy], jira, () => 'x2').name).toBe('Jira copy 2')
  })
})
