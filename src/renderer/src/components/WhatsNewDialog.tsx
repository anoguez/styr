import { useEffect, useState, type ReactNode } from 'react'
import {
  parseChangelog,
  sectionsBetween,
  WHATS_NEW_CAP,
  type ChangelogSection
} from '@core/changelog.js'
import { Markdown } from './Markdown.js'
import { Button, Modal } from './ui.js'

export const RELEASES_URL = 'https://github.com/anoguez/styr/releases'

/** The notes as markdown, so the bundled changelog and the GitHub body share one renderer. */
function sectionMarkdown(section: ChangelogSection, withVersion: boolean): string {
  const lines = withVersion
    ? [`## ${section.version}${section.date ? ` (${section.date})` : ''}`]
    : []
  for (const group of section.groups) {
    lines.push(`### ${group.title}`, ...group.items.map((item) => `* ${item}`), '')
  }
  return lines.join('\n')
}

function Link({ href, children }: { href: string; children: ReactNode }): ReactNode {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-[12px] text-[var(--color-accent-text)] hover:underline"
    >
      {children}
    </a>
  )
}

/**
 * What changed in a release. Installed: the bundled changelog for this version (or, after a skip,
 * every version since `since`). Incoming: the GitHub release body of a downloaded update, read
 * before restarting. Nothing here installs on its own; Restart is a click.
 */
export function WhatsNewDialog(
  props:
    | { mode: 'installed'; version: string; since?: string; onClose: () => void }
    | {
        mode: 'incoming'
        version: string
        notes: string | null
        /** The download has finished, so Restart works. */
        ready: boolean
        onRestart: () => void
        onClose: () => void
      }
): ReactNode {
  const { onClose, version } = props
  const [sections, setSections] = useState<ChangelogSection[] | null>(null)
  const installed = props.mode === 'installed'
  const since = props.mode === 'installed' ? props.since : undefined
  useEffect(() => {
    if (!installed) return
    let live = true
    void window.api.app.changelog().then((text) => {
      if (!live) return
      const all = text ? parseChangelog(text) : []
      setSections(
        since === undefined
          ? all.filter((section) => section.version === version)
          : sectionsBetween(all, since, version)
      )
    })
    return () => {
      live = false
    }
  }, [installed, since, version])

  if (props.mode === 'incoming') {
    return (
      <Modal
        title={`Styr ${version} is ready`}
        subtitle={props.ready ? undefined : 'Still downloading…'}
        onClose={onClose}
        footer={
          <>
            <Link href={`${RELEASES_URL}/tag/v${version}`}>View on GitHub</Link>
            <span className="flex-1" />
            <Button onClick={onClose}>Later</Button>
            <Button variant="primary" disabled={!props.ready} onClick={props.onRestart}>
              Restart to update
            </Button>
          </>
        }
      >
        {props.notes ? (
          <Markdown text={props.notes} />
        ) : (
          <p className="text-[12.5px] text-dim">Release notes unavailable offline.</p>
        )}
      </Modal>
    )
  }

  const shown = sections?.slice(0, WHATS_NEW_CAP) ?? []
  const truncated = (sections?.length ?? 0) > WHATS_NEW_CAP
  return (
    <Modal
      title={`What's new in ${version}`}
      onClose={onClose}
      footer={
        <>
          <Link href={RELEASES_URL}>View all releases</Link>
          <span className="flex-1" />
          <Button variant="primary" onClick={onClose}>
            Close
          </Button>
        </>
      }
    >
      {sections === null ? null : shown.length === 0 ? (
        <p className="text-[12.5px] text-dim">No release notes for this version.</p>
      ) : (
        <>
          {shown.map((section) => (
            <Markdown key={section.version} text={sectionMarkdown(section, shown.length > 1)} />
          ))}
          {truncated ? (
            <p className="mt-3 text-[12px] text-faint">Older releases are on the releases page.</p>
          ) : null}
        </>
      )}
    </Modal>
  )
}
