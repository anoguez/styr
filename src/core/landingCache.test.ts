import { describe, expect, it } from 'vitest'
import { LandingCache } from './landingCache.js'

describe('LandingCache', () => {
  it('is fresh only for the same fingerprint', () => {
    const cache = new LandingCache(1000, () => 0)
    cache.remember('a', 'x')
    expect(cache.isFresh('a', 'x')).toBe(true)
    expect(cache.isFresh('a', 'y')).toBe(false)
    expect(cache.isFresh('b', 'x')).toBe(false)
  })

  it('expires after the ttl', () => {
    let now = 0
    const cache = new LandingCache(1000, () => now)
    cache.remember('a', 'x')
    now = 999
    expect(cache.isFresh('a', 'x')).toBe(true)
    now = 1000
    expect(cache.isFresh('a', 'x')).toBe(false)
  })

  it('forgets', () => {
    const cache = new LandingCache(1000, () => 0)
    cache.remember('a', 'x')
    cache.forget('a')
    expect(cache.isFresh('a', 'x')).toBe(false)
  })
})
