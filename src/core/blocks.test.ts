import { describe, expect, it } from 'vitest'
import { canTransition, isFinalBlockState, orderBlocks, updateBlock } from './blocks.js'
import { BLOCK_KINDS, type CommandBlock, type StyrBlock } from './types.js'

function block(id: string, createdAt: number, parentId?: string): StyrBlock {
  return {
    id,
    kind: 'output',
    sessionId: 's1',
    ...(parentId ? { parentId } : {}),
    state: 'pending',
    createdAt,
    updatedAt: createdAt,
    payload: { text: '', truncated: false }
  }
}

const command: CommandBlock = {
  id: 'c1',
  kind: 'command',
  sessionId: 's1',
  state: 'pending',
  createdAt: 1,
  updatedAt: 1,
  payload: { command: 'ls', cwd: '/', startedAt: 1 }
}

describe('block lifecycle', () => {
  it('covers every block kind the terminal must support from day one', () => {
    expect([...BLOCK_KINDS].sort()).toEqual(
      [
        'active-terminal',
        'agent-message',
        'agent-tool-call',
        'approval',
        'command',
        'diff',
        'output'
      ].sort()
    )
  })

  it('moves forward and never out of a final state', () => {
    expect(canTransition('pending', 'streaming')).toBe(true)
    expect(canTransition('streaming', 'awaiting-input')).toBe(true)
    expect(canTransition('awaiting-input', 'streaming')).toBe(true)
    expect(canTransition('streaming', 'pending')).toBe(false)
    expect(canTransition('completed', 'streaming')).toBe(false)
    expect(canTransition('completed', 'completed')).toBe(false)
    expect(canTransition('streaming', 'streaming')).toBe(true)
    expect(isFinalBlockState('failed')).toBe(true)
    expect(isFinalBlockState('awaiting-input')).toBe(false)
  })

  it('merges payload and state through one update path for every kind', () => {
    const running = updateBlock(command, { state: 'streaming', at: 2 })
    const done = updateBlock(running, {
      state: 'completed',
      payload: { exitCode: 0, endedAt: 3 },
      at: 3
    })
    expect(done).toMatchObject({
      state: 'completed',
      updatedAt: 3,
      payload: { command: 'ls', exitCode: 0, endedAt: 3 }
    })
  })

  it('ignores an update to a final block or an illegal transition', () => {
    const done = updateBlock(command, { state: 'completed', at: 2 })
    expect(updateBlock(done, { payload: { command: 'rm' }, at: 3 })).toBe(done)
    const streaming = updateBlock(command, { state: 'streaming', at: 2 })
    expect(updateBlock(streaming, { state: 'pending', at: 3 })).toBe(streaming)
  })

  it('never moves updatedAt backwards', () => {
    const later = updateBlock(command, { state: 'streaming', at: 10 })
    expect(updateBlock(later, { payload: { cwd: '/tmp' }, at: 5 }).updatedAt).toBe(10)
  })
})

describe('orderBlocks', () => {
  it('orders by creation with children after their parent', () => {
    const ordered = orderBlocks([
      block('b', 2),
      block('a-child', 3, 'a'),
      block('a', 1),
      block('c', 4)
    ])
    expect(ordered.map((entry) => entry.id)).toEqual(['a', 'a-child', 'b', 'c'])
  })

  it('treats a block with an unknown parent as a root', () => {
    expect(orderBlocks([block('x', 2, 'missing'), block('y', 1)]).map((entry) => entry.id)).toEqual(
      ['y', 'x']
    )
  })

  it('keeps every block of a parent cycle', () => {
    const ordered = orderBlocks([block('p', 1, 'q'), block('q', 2, 'p')])
    expect(ordered.map((entry) => entry.id).sort()).toEqual(['p', 'q'])
  })
})
