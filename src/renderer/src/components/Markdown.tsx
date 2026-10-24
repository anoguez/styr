import type { ReactNode } from 'react'

/**
 * A tiny, dependency-free markdown renderer for release notes: headings (`#`–`###`), `*`/`-`
 * bullets, paragraphs, `**bold**`, `` `code` `` and `[text](url)`. It builds React elements and
 * never sets HTML, so markup in the source is shown as literal text. A link is kept only for an
 * `http(s)` URL; any other scheme (`javascript:`, `data:`) becomes plain text.
 */

const INLINE = /\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g

function isWebUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  for (const match of text.matchAll(INLINE)) {
    const at = match.index
    if (at > last) out.push(text.slice(last, at))
    const [whole, bold, code, label, url] = match
    if (bold !== undefined) {
      out.push(
        <strong key={at} className="font-semibold text-ink">
          {inline(bold)}
        </strong>
      )
    } else if (code !== undefined) {
      out.push(
        <code key={at} className="rounded bg-raised px-1 font-mono text-[11.5px] text-ink">
          {code}
        </code>
      )
    } else if (label !== undefined && url !== undefined) {
      out.push(
        isWebUrl(url) ? (
          <a
            key={at}
            href={url}
            target="_blank"
            rel="noreferrer"
            className="text-[var(--color-accent-text)] hover:underline"
          >
            {label}
          </a>
        ) : (
          label
        )
      )
    }
    last = at + whole.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

const HEADING_CLASS = [
  'mt-4 text-[14px] font-semibold text-ink first:mt-0',
  'mt-4 text-[13px] font-semibold text-ink first:mt-0',
  'mt-3 text-[11px] font-semibold uppercase tracking-[0.06em] text-faint first:mt-0'
]

export function Markdown({ text }: { text: string }): ReactNode {
  const blocks: ReactNode[] = []
  let bullets: string[] = []
  let paragraph: string[] = []
  const flush = (): void => {
    if (bullets.length > 0) {
      const items = bullets
      blocks.push(
        <ul key={blocks.length} className="my-1.5 list-disc space-y-1 pl-5 marker:text-faint">
          {items.map((item, i) => (
            <li key={i}>{inline(item)}</li>
          ))}
        </ul>
      )
      bullets = []
    }
    if (paragraph.length > 0) {
      blocks.push(
        <p key={blocks.length} className="my-1.5">
          {inline(paragraph.join(' '))}
        </p>
      )
      paragraph = []
    }
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    const heading = /^(#{1,3})\s+(.*)$/.exec(line)
    const bullet = /^[*-]\s+(.*)$/.exec(line)
    if (heading) {
      flush()
      const level = heading[1]!.length
      blocks.push(
        <h3 key={blocks.length} className={HEADING_CLASS[level - 1]}>
          {inline(heading[2]!)}
        </h3>
      )
    } else if (bullet) {
      if (paragraph.length > 0) flush()
      bullets.push(bullet[1]!)
    } else if (line === '') {
      flush()
    } else {
      if (bullets.length > 0) flush()
      paragraph.push(line)
    }
  }
  flush()
  return <div className="text-[12.5px] leading-[1.55] text-dim">{blocks}</div>
}
