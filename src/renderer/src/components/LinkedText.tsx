import type { ReactNode } from 'react'
import { findUrls } from '../lib/nativeTerminal/links.js'

/**
 * Text with its web URLs made clickable. The window's open handler sends a `target="_blank"` link to
 * the browser, as the task card's PR link does; anything that is not `http(s)` stays plain text.
 */
export function LinkedText({ text }: { text: string }): ReactNode {
  const urls = findUrls(text)
  if (urls.length === 0) return text
  const parts: ReactNode[] = []
  let at = 0
  for (const { start, end, url } of urls) {
    if (start > at) parts.push(text.slice(at, start))
    parts.push(
      <a
        key={start}
        href={url}
        target="_blank"
        rel="noreferrer"
        className="text-[var(--color-accent-text)] hover:underline"
      >
        {url}
      </a>
    )
    at = end
  }
  if (at < text.length) parts.push(text.slice(at))
  return parts
}
