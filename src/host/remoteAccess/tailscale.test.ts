import { describe, expect, it } from 'vitest'
import { parseShieldsUp, tailscaleCandidates, tailscaleShieldsUp } from './tailscale.js'

describe('Tailscale Shields Up', () => {
  it('reads ShieldsUp from the prefs JSON', () => {
    expect(parseShieldsUp('{"ShieldsUp": true, "WantRunning": true}')).toBe(true)
    expect(parseShieldsUp('{"ShieldsUp": false}')).toBe(false)
  })

  it('says nothing for output it cannot read', () => {
    expect(parseShieldsUp('not json')).toBeUndefined()
    expect(parseShieldsUp('null')).toBeUndefined()
    expect(parseShieldsUp('{"ShieldsUp": "yes"}')).toBeUndefined()
  })

  it('tries the next place when the CLI is not found', async () => {
    const tried: string[] = []
    const result = await tailscaleShieldsUp(
      async (file, args) => {
        tried.push(`${file} ${args.join(' ')}`)
        if (file !== 'b') throw new Error('ENOENT')
        return '{"ShieldsUp": true}'
      },
      ['a', 'b', 'c']
    )
    expect(result).toBe(true)
    expect(tried).toEqual(['a debug prefs', 'b debug prefs'])
  })

  it('is undefined when Tailscale is not installed', async () => {
    const missing = async (): Promise<string> => {
      throw new Error('ENOENT')
    }
    await expect(tailscaleShieldsUp(missing, ['a'])).resolves.toBeUndefined()
  })

  it('looks in the Mac app as well as on PATH', () => {
    expect(tailscaleCandidates('darwin')).toContain(
      '/Applications/Tailscale.app/Contents/MacOS/Tailscale'
    )
    expect(tailscaleCandidates('linux')[0]).toBe('tailscale')
  })
})
