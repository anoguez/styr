import { describe, expect, it } from 'vitest'
import { claudeConversation } from './claudeConversation.js'
import { conversationAdapter } from './conversation.js'

const { promptText, describeTool } = claudeConversation
const use = (tool: string, input: Record<string, unknown>, extra = {}) => ({
  id: 't',
  tool,
  input,
  ...extra
})

describe('Claude Code conversation adapter', () => {
  it('is the adapter for Claude, and Codex has none until it has a source', () => {
    expect(conversationAdapter('claude')).toBe(claudeConversation)
    expect(conversationAdapter('codex')).toBeUndefined()
  })

  it('shows what the person typed, not Claude Code’s own notes', () => {
    expect(promptText('<system-reminder>be brief</system-reminder>\nfix it')).toBe('fix it')
    expect(
      promptText('<command-name>/compact</command-name><command-args>keep tests</command-args>')
    ).toBe('/compact keep tests')
    expect(promptText('<local-command-stdout>done</local-command-stdout>')).toBe('')
    expect(promptText('[Request interrupted by user for tool use]')).toBe('')
  })

  it('names what a tool works on', () => {
    expect(describeTool(use('Read', { file_path: '/src/a.ts', limit: 3 })).summary).toBe(
      '/src/a.ts'
    )
    expect(
      describeTool(use('Bash', { command: 'yarn test\nyarn lint', description: 'checks' })).summary
    ).toBe('yarn test …')
    expect(describeTool(use('Grep', { pattern: 'TODO', path: 'src' })).summary).toBe('TODO')
    expect(describeTool(use('Mystery', { count: 3, label: 'thing' })).summary).toBe('thing')
  })

  it('says how a call went', () => {
    expect(describeTool(use('Read', {})).result).toBeUndefined()
    expect(describeTool(use('Read', {}, { text: 'a\nb\n\nc' })).result).toBe('3 lines')
    expect(describeTool(use('Edit', {}, { text: 'Updated file\nmore' })).result).toBe(
      'Updated file'
    )
    expect(
      describeTool(use('Read', {}, { text: 'ENOENT: no such file\n…', isError: true })).result
    ).toBe('ENOENT: no such file')
  })

  it('draws Edit, MultiEdit and Write as diffs of their file', () => {
    expect(
      describeTool(use('Edit', { file_path: '/a', old_string: 'x', new_string: 'y' })).edit
    ).toEqual({ path: '/a', patch: '-x\n+y', additions: 1, deletions: 1 })
    expect(
      describeTool(
        use('MultiEdit', {
          file_path: '/a',
          edits: [
            { old_string: 'a', new_string: 'b' },
            { old_string: 'c', new_string: 'd' }
          ]
        })
      ).edit
    ).toMatchObject({ additions: 2, deletions: 2 })
    expect(describeTool(use('Write', { file_path: '/b', content: '1\n2' })).edit).toMatchObject({
      additions: 2,
      deletions: 0
    })
    expect(describeTool(use('Read', { file_path: '/a' })).edit).toBeUndefined()
  })
})
