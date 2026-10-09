import type { ReactNode } from 'react'
import type { AgentRow } from '../lib/agentRows.js'
import { Button, Modal } from './ui.js'

/** Confirms forgetting an agent's chat (and closing its terminal); the task and worktree stay. */
export function RemoveAgentDialog({
  row,
  onConfirm,
  onClose
}: {
  row: AgentRow
  onConfirm: () => void
  onClose: () => void
}): ReactNode {
  return (
    <Modal
      title="Remove this agent?"
      subtitle={`${row.task.id} · ${row.task.title}`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" onClick={onConfirm}>
            Remove
          </Button>
        </>
      }
    >
      <p className="text-[12.5px] text-dim">
        {row.session
          ? 'Its terminal is closed and the chat is forgotten. '
          : 'The chat is forgotten. '}
        The task and its worktree are kept, and you can start a new agent on it later.
      </p>
    </Modal>
  )
}
