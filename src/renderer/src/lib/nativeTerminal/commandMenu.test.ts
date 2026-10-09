import { describe, expect, it } from 'vitest'
import { isSlashCommand, matchCommands, MENU_LIMIT, slashQuery } from './commandMenu.js'

const commands = ['compact', 'clear', 'config', 'context', 'model', 'mcp', 'review'].map(
  (name) => ({ name, description: `${name} it` })
)
const names = (list: { name: string }[]): string[] => list.map((command) => command.name)

describe('command menu', () => {
  it('opens only while a command name is being typed', () => {
    expect(slashQuery('/')).toBe('')
    expect(slashQuery('/co')).toBe('co')
    expect(slashQuery('/compact keep tests')).toBeNull()
    expect(slashQuery('fix /tmp')).toBeNull()
    expect(slashQuery('')).toBeNull()
  })

  it('lists the CLI’s order for a bare slash, and prefix matches first otherwise', () => {
    expect(names(matchCommands('', commands))).toEqual(names(commands))
    expect(names(matchCommands('co', commands)).slice(0, 3).sort()).toEqual([
      'compact',
      'config',
      'context'
    ])
    expect(names(matchCommands('mo', commands))[0]).toBe('model')
    expect(matchCommands('zzz', commands)).toEqual([])
  })

  it('lists a bounded number', () => {
    const many = Array.from({ length: 80 }, (_, index) => ({ name: `c${index}`, description: '' }))
    expect(matchCommands('', many)).toHaveLength(MENU_LIMIT)
  })

  it('tells a command from a message', () => {
    expect(isSlashCommand('/compact')).toBe(true)
    expect(isSlashCommand('/model opus')).toBe(true)
    expect(isSlashCommand('/tmp/a is missing')).toBe(false)
    expect(isSlashCommand('please /compact')).toBe(false)
  })
})
