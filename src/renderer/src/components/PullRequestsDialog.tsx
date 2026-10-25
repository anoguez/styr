import type { ReactNode } from 'react'
import { Button, Modal } from './ui.js'

export interface PullRequestLink {
  /** The repository the pull request belongs to. */
  repo: string
  url: string
}

/** A multi-repo task has one pull request per repository: pick which one to open. */
export function PullRequestsDialog({
  links,
  onClose
}: {
  links: PullRequestLink[]
  onClose: () => void
}): ReactNode {
  return (
    <Modal
      title="Pull requests"
      subtitle="This task has a pull request in each of these repositories."
      onClose={onClose}
      footer={<Button onClick={onClose}>Close</Button>}
    >
      <ul className="flex flex-col divide-y divide-edge overflow-hidden rounded-lg border border-edge-strong bg-chrome">
        {links.map((link) => (
          <li key={link.url}>
            <a
              href={link.url}
              target="_blank"
              rel="noreferrer"
              onClick={onClose}
              className="flex flex-col gap-0.5 px-3 py-2.5 hover:bg-raised"
            >
              <span className="text-[12.5px] font-medium text-ink">{link.repo}</span>
              <span className="truncate font-mono text-[10.5px] text-[var(--color-accent-text)]">
                {link.url}
              </span>
            </a>
          </li>
        ))}
      </ul>
    </Modal>
  )
}
