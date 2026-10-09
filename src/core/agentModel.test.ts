import { describe, expect, it } from 'vitest'
import { launchModel, withModel } from './agentModel.js'

const sonnet = { model: { provider: 'claude' as const, name: 'sonnet' } }

describe('launchModel', () => {
  it('leaves the CLI default when nothing names a model', () => {
    expect(launchModel({}, 'claude', 'claude')).toBeUndefined()
    expect(launchModel({}, 'claude', 'claude', {})).toBeUndefined()
  })

  it('prefers the task model over the template one', () => {
    expect(launchModel({ provider: 'claude', model: 'opus' }, 'codex', 'claude', sonnet)).toBe(
      'opus'
    )
  })

  it('reads an unset task provider as the workspace default', () => {
    expect(launchModel({ model: 'opus' }, 'claude', 'claude')).toBe('opus')
    expect(launchModel({ model: 'opus' }, 'codex', 'claude')).toBeUndefined()
  })

  it('ignores the task model when the launch runs another provider', () => {
    const codex = { model: { provider: 'codex' as const, name: 'gpt-6.1-sol' } }
    expect(launchModel({ provider: 'claude', model: 'opus' }, 'claude', 'codex', codex)).toBe(
      'gpt-6.1-sol'
    )
  })

  it('takes the template model only for the provider it names', () => {
    expect(launchModel({}, 'claude', 'codex', sonnet)).toBeUndefined()
    expect(launchModel({}, 'claude', 'claude', sonnet)).toBe('sonnet')
  })

  it('treats a blank task model as unset', () => {
    expect(launchModel({ provider: 'claude', model: '  ' }, 'claude', 'claude', sonnet)).toBe(
      'sonnet'
    )
  })
})

describe('withModel', () => {
  it('adds a trimmed name once', () => {
    expect(withModel(['opus'], ' sonnet ')).toEqual(['opus', 'sonnet'])
    expect(withModel(['opus'], 'opus')).toEqual(['opus'])
    expect(withModel(['opus'], '  ')).toEqual(['opus'])
  })
})
