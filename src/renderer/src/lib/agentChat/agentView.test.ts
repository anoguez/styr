import { beforeEach, describe, expect, it } from 'vitest'
import {
  agentViewFor,
  agentViewKey,
  forgetAgentViews,
  rememberAgentView,
  type ViewStorage
} from './agentView.js'

const memoryStorage = (): ViewStorage & { data: Map<string, string> } => {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value)
  }
}

const throwing: ViewStorage = {
  getItem: () => {
    throw new Error('blocked')
  },
  setItem: () => {
    throw new Error('blocked')
  }
}

describe('agent tab views', () => {
  beforeEach(forgetAgentViews)

  it('opens a tab that was never switched as Settings says', () => {
    const store = memoryStorage()
    expect(agentViewFor('s1', 'terminal', store)).toBe('terminal')
    expect(agentViewFor('s2', 'chat', store)).toBe('chat')
    // Following the default is not a choice: nothing is stored for it.
    expect(store.data.size).toBe(0)
  })

  it('remembers each tab’s own choice over the default', () => {
    const store = memoryStorage()
    rememberAgentView('s1', 'chat', store)
    expect(agentViewFor('s1', 'terminal', store)).toBe('chat')
    expect(agentViewFor('s2', 'terminal', store)).toBe('terminal')
    rememberAgentView('s1', 'terminal', store)
    expect(agentViewFor('s1', 'chat', store)).toBe('terminal')
  })

  it('keeps the choice across a reload through storage', () => {
    const store = memoryStorage()
    rememberAgentView('s1', 'chat', store)
    forgetAgentViews()
    expect(agentViewFor('s1', 'terminal', store)).toBe('chat')
  })

  it('ignores a stored value it does not know', () => {
    const store = memoryStorage()
    store.data.set('styr.agentView.s1', 'grid')
    expect(agentViewFor('s1', 'terminal', store)).toBe('terminal')
  })

  it('still remembers in memory when storage throws', () => {
    expect(() => rememberAgentView('s1', 'chat', throwing)).not.toThrow()
    expect(agentViewFor('s1', 'terminal', throwing)).toBe('chat')
    expect(agentViewFor('s2', 'terminal', throwing)).toBe('terminal')
  })

  it('keys a task’s agent tab by workspace and task, so a relaunch or a new run keeps it', () => {
    const store = memoryStorage()
    const before = agentViewKey({ id: 'session-1', taskId: 'TASK-0007', workspaceId: 'w1' })
    rememberAgentView(before, 'chat', store)
    forgetAgentViews()
    // Restored after a relaunch: a new session id, the same task.
    const after = agentViewKey({ id: 'session-9', taskId: 'TASK-0007', workspaceId: 'w1' })
    expect(agentViewFor(after, 'terminal', store)).toBe('chat')
    // The same task id in another workspace is another task.
    const other = agentViewKey({ id: 'session-9', taskId: 'TASK-0007', workspaceId: 'w2' })
    expect(agentViewFor(other, 'terminal', store)).toBe('terminal')
    expect(agentViewKey({ id: 'session-3' })).toBe('session-3')
  })
})
