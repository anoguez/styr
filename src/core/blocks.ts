import type { BlockState, StyrBlock } from './types.js'

/** The states a block may move to from each state. A final state has none. */
const TRANSITIONS: Record<BlockState, readonly BlockState[]> = {
  pending: ['streaming', 'awaiting-input', 'completed', 'failed', 'cancelled'],
  streaming: ['awaiting-input', 'completed', 'failed', 'cancelled'],
  'awaiting-input': ['streaming', 'completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: []
}

export function isFinalBlockState(state: BlockState): boolean {
  return TRANSITIONS[state].length === 0
}

export function canTransition(from: BlockState, to: BlockState): boolean {
  return from === to ? !isFinalBlockState(from) : TRANSITIONS[from].includes(to)
}

/**
 * A change to one block: a new state, new payload fields, or both. The payload is merged, so an
 * update carries only what changed (a streamed chunk of text is the caller's to append).
 */
export interface BlockUpdate<B extends StyrBlock = StyrBlock> {
  state?: BlockState
  payload?: Partial<B['payload']>
  at: number
}

/**
 * Applies `update` to `block`, or returns `block` unchanged when the update is not allowed — a final
 * block is immutable, and a state may only move along `TRANSITIONS`. Every kind goes through here,
 * which is what makes the lifecycle shared.
 */
export function updateBlock<B extends StyrBlock>(block: B, update: BlockUpdate<B>): B {
  const state = update.state ?? block.state
  if (!canTransition(block.state, state)) return block
  return {
    ...block,
    state,
    updatedAt: Math.max(block.updatedAt, update.at),
    payload: update.payload ? { ...block.payload, ...update.payload } : block.payload
  }
}

/** A session's blocks in display order: by creation, with children right after their parent. */
export function orderBlocks(blocks: readonly StyrBlock[]): StyrBlock[] {
  const byCreation = [...blocks].sort(
    (left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id)
  )
  const ids = new Set(byCreation.map((block) => block.id))
  const children = new Map<string, StyrBlock[]>()
  const roots: StyrBlock[] = []
  for (const block of byCreation) {
    if (block.parentId && ids.has(block.parentId) && block.parentId !== block.id) {
      const siblings = children.get(block.parentId) ?? []
      siblings.push(block)
      children.set(block.parentId, siblings)
    } else roots.push(block)
  }
  const ordered: StyrBlock[] = []
  const visit = (block: StyrBlock, seen: Set<string>): void => {
    if (seen.has(block.id)) return
    seen.add(block.id)
    ordered.push(block)
    for (const child of children.get(block.id) ?? []) visit(child, seen)
  }
  const seen = new Set<string>()
  for (const root of roots) visit(root, seen)
  // A parent cycle has no root; keep its blocks rather than lose them.
  for (const block of byCreation) visit(block, seen)
  return ordered
}
