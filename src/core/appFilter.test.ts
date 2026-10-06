import { describe, expect, it } from 'vitest'
import { opensTextFiles } from './appFilter.js'

describe('opensTextFiles', () => {
  it('accepts apps declaring a text UTI', () => {
    expect(
      opensTextFiles({ CFBundleDocumentTypes: [{ LSItemContentTypes: ['public.plain-text'] }] })
    ).toBe(true)
  })
  it('accepts apps declaring a markdown extension', () => {
    expect(opensTextFiles({ CFBundleDocumentTypes: [{ CFBundleTypeExtensions: ['MD'] }] })).toBe(
      true
    )
  })
  it('rejects other apps', () => {
    expect(
      opensTextFiles({ CFBundleDocumentTypes: [{ LSItemContentTypes: ['public.jpeg'] }] })
    ).toBe(false)
    expect(opensTextFiles({})).toBe(false)
  })
})
