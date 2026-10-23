import { describe, expect, it, vi } from 'vitest'
import { createReleaseNotes } from './releaseNotes.js'

const ok = (body: unknown) => ({ ok: true, json: async () => ({ body }) })

describe('release notes fetch', () => {
  it('returns the release body and asks for that tag', async () => {
    const fetchFn = vi.fn(async (_url: string, _init: unknown) => ok('## Notes'))
    const notes = createReleaseNotes(fetchFn)
    expect(await notes.load('0.38.0')).toBe('## Notes')
    expect(fetchFn.mock.calls[0]![0]).toMatch(/releases\/tags\/v0\.38\.0$/)
    expect(notes.get('0.38.0')).toBe('## Notes')
  })

  it('is null on a 404 and does not cache it', async () => {
    const fetchFn = vi.fn(async (_url: string, _init: unknown) => ({
      ok: false,
      json: async () => ({})
    }))
    const notes = createReleaseNotes(fetchFn)
    expect(await notes.load('0.38.0')).toBeNull()
    expect(notes.get('0.38.0')).toBeNull()
    await notes.load('0.38.0')
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('is null on a network error or an empty body', async () => {
    expect(
      await createReleaseNotes(async () => {
        throw new Error('offline')
      }).load('1.0.0')
    ).toBeNull()
    expect(await createReleaseNotes(async () => ok('  ')).load('1.0.0')).toBeNull()
  })

  it('gives up after the timeout', async () => {
    const hang = (_url: string, init: { signal: AbortSignal }) =>
      new Promise<never>((_resolve, reject) =>
        init.signal.addEventListener('abort', () => reject(new Error('timeout')))
      )
    expect(await createReleaseNotes(hang, 10).load('1.0.0')).toBeNull()
  })

  it('fetches once per version, even for concurrent callers', async () => {
    const fetchFn = vi.fn(async (_url: string, _init: unknown) => ok('body'))
    const notes = createReleaseNotes(fetchFn)
    await Promise.all([notes.load('1.0.0'), notes.load('1.0.0')])
    await notes.load('1.0.0')
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })
})
