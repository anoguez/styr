import { describe, expect, it } from 'vitest'
import { DEFAULT_APPROVAL_OPTIONS, type ConversationAdapter } from '@core/agentConversation.js'
import type { AgentConversation } from '@core/agentConversation.js'
import { approvalRequest } from './agentApproval.js'

const conversation = (approval?: Record<string, unknown>): AgentConversation =>
  ({ approval }) as unknown as AgentConversation

const adapterFor = (described: Record<string, unknown> | undefined): ConversationAdapter =>
  ({ describeTool: () => described }) as unknown as ConversationAdapter

describe('approvalRequest', () => {
  it('shows the channel request with its own options, not answered by keys', () => {
    const options = [{ id: 'yes', label: 'Yes', kind: 'allow' }]
    const request = approvalRequest(
      conversation({ id: 'a1', prompt: 'Run it?', options }),
      undefined,
      null
    )
    expect(request).toEqual({ prompt: 'Run it?', options, keys: false })
  })

  it('falls back to the default options when the channel names none', () => {
    const request = approvalRequest(conversation({ id: 'a1', prompt: 'Run it?' }), undefined, null)
    expect(request?.options).toEqual(DEFAULT_APPROVAL_OPTIONS)
  })

  it('adds the tool and what the adapter says it works on', () => {
    const edit = { path: 'a.ts', patch: '', additions: 1, deletions: 0 }
    const request = approvalRequest(
      conversation({ id: 'a1', prompt: 'Edit?', tool: 'Edit', input: { file: 'a.ts' } }),
      adapterFor({ summary: 'a.ts', edit }),
      null
    )
    expect(request).toMatchObject({ tool: 'Edit', summary: 'a.ts', edit, keys: false })
  })

  it('keeps the tool without a description when there is no adapter or it describes nothing', () => {
    const approval = { id: 'a1', prompt: 'Run?', tool: 'Bash' }
    expect(approvalRequest(conversation(approval), undefined, null)).not.toHaveProperty('summary')
    const plain = approvalRequest(conversation(approval), adapterFor(undefined), null)
    expect(plain).toMatchObject({ tool: 'Bash' })
    expect(plain).not.toHaveProperty('summary')
    expect(plain).not.toHaveProperty('edit')
  })

  it('answers by keys from what the agent status says while it waits', () => {
    expect(approvalRequest(conversation(), undefined, 'Needs permission')).toEqual({
      prompt: 'Needs permission',
      options: DEFAULT_APPROVAL_OPTIONS,
      keys: true
    })
    expect(approvalRequest(null, undefined, 'Needs permission')?.keys).toBe(true)
  })

  it('prefers the channel request over the status', () => {
    const request = approvalRequest(conversation({ id: 'a1', prompt: 'Run?' }), undefined, 'x')
    expect(request).toMatchObject({ prompt: 'Run?', keys: false })
  })

  it('is null with neither', () => {
    expect(approvalRequest(null, undefined, null)).toBeNull()
    expect(approvalRequest(conversation(), undefined, '')).toBeNull()
  })
})
