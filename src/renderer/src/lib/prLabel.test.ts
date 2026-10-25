import { describe, expect, it } from 'vitest'
import { prMenuLabel } from './prLabel.js'

describe('prMenuLabel', () => {
  it.each([
    ['https://github.com/acme/api/pull/100', '#100 - api'],
    ['https://gitlab.com/acme/api/-/merge_requests/7', '#7 - api'],
    ['https://bitbucket.org/acme/api/pull-requests/3/overview', '#3 - api'],
    ['https://example.com/review/abc', 'api']
  ])('%s -> %s', (url, label) => {
    expect(prMenuLabel({ repo: 'api', url })).toBe(label)
  })
})
