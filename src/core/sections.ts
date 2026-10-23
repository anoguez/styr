// Named `## Heading` sections inside a task description. Pure text: the description never holds the
// activity block (`markdown.ts` splits it off), so a section helper cannot touch it.

interface Span {
  /** Index of the heading line's first character. */
  start: number
  /** Index just past the section: the next `## ` heading, or the end of the text. */
  end: number
  /** Index where the body starts, after the heading line. */
  bodyStart: number
}

const H2_RE = /^## (.*?)[ \t]*$/
const FENCE_RE = /^\s{0,3}(```|~~~)/

/** Finds the section by heading, case-insensitively; headings inside code fences do not count. */
function locate(description: string, heading: string): Span | undefined {
  const wanted = heading.trim().toLowerCase()
  let offset = 0
  let fenced = false
  let found: Pick<Span, 'start' | 'bodyStart'> | undefined
  for (const line of description.split('\n')) {
    const next = offset + line.length + 1
    if (FENCE_RE.test(line)) fenced = !fenced
    else if (!fenced) {
      const match = H2_RE.exec(line.replace(/\r$/, ''))
      if (match) {
        if (found) return { ...found, end: offset }
        if ((match[1] ?? '').toLowerCase() === wanted) found = { start: offset, bodyStart: next }
      }
    }
    offset = next
  }
  return found ? { ...found, end: description.length } : undefined
}

/** The text under `## <heading>`, trimmed, or undefined when the description has no such section. */
export function getSection(description: string, heading: string): string | undefined {
  const span = locate(description, heading)
  return span ? description.slice(span.bodyStart, span.end).trim() : undefined
}

/**
 * Replaces the body of `## <heading>`, or appends the section when there is none. The other
 * sections and the text around it are kept as written.
 */
export function setSection(description: string, heading: string, body: string): string {
  const section = `## ${heading.trim()}\n\n${body.trim()}`
  const span = locate(description, heading)
  if (!span) return [description.trimEnd(), section].filter(Boolean).join('\n\n')
  const before = description.slice(0, span.start).trimEnd()
  const after = description.slice(span.end).trimStart()
  return [before, section, after].filter(Boolean).join('\n\n')
}
