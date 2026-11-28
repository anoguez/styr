import type { ReactNode } from 'react'
import { inline } from './Markdown.js'

/**
 * An agent's reply as the phone's chat draws it: fenced code blocks, `#` headings, `-`/`*`/`1.`
 * lists and paragraphs that keep the agent's line breaks, with `Markdown`'s inline rules (bold,
 * code, http(s) links). Built from React elements only, so markup in the reply is literal text; an
 * unclosed fence (a reply still streaming, or folded) runs to the end as code.
 */
export function ChatMarkdown({ text }: { text: string }): ReactNode {
  const blocks: ReactNode[] = []
  let lines: string[] = []
  let list: { ordered: boolean; items: string[] } | null = null
  let code: string[] | null = null

  const flushParagraph = (): void => {
    if (lines.length === 0) return
    const shown = lines
    blocks.push(
      <p key={blocks.length} className="my-0.5">
        {shown.map((line, at) => (
          <span key={at}>
            {at > 0 ? <br /> : null}
            {inline(line)}
          </span>
        ))}
      </p>
    )
    lines = []
  }
  const flushList = (): void => {
    if (!list) return
    const { ordered, items } = list
    const Tag = ordered ? 'ol' : 'ul'
    blocks.push(
      <Tag
        key={blocks.length}
        className={`marker:text-faint my-0.5 pl-5 ${ordered ? 'list-decimal' : 'list-disc'}`}
      >
        {items.map((item, at) => (
          <li key={at}>{inline(item)}</li>
        ))}
      </Tag>
    )
    list = null
  }
  const flushCode = (): void => {
    if (!code) return
    blocks.push(
      <pre
        key={blocks.length}
        className="border-edge bg-raised/60 text-ink my-1 overflow-x-auto rounded-md border px-2 py-1 whitespace-pre"
      >
        {code.join('\n')}
      </pre>
    )
    code = null
  }

  for (const raw of text.split(/\r?\n/)) {
    if (code) {
      if (/^\s*```/.test(raw)) flushCode()
      else code.push(raw)
      continue
    }
    if (/^\s*```/.test(raw)) {
      flushParagraph()
      flushList()
      code = []
      continue
    }
    const line = raw.trimEnd()
    const heading = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line)
    const bullet = /^\s*[*-]\s+(.*)$/.exec(line)
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    if (heading) {
      flushParagraph()
      flushList()
      blocks.push(
        <p key={blocks.length} className="text-ink mt-1.5 mb-0.5 font-semibold first:mt-0">
          {inline(heading[2]!)}
        </p>
      )
    } else if (bullet || numbered) {
      flushParagraph()
      const ordered = numbered !== null
      if (list && list.ordered !== ordered) flushList()
      list ??= { ordered, items: [] }
      list.items.push((bullet ?? numbered)![1]!)
    } else if (line.trim() === '') {
      flushParagraph()
      flushList()
    } else {
      flushList()
      lines.push(line)
    }
  }
  flushParagraph()
  flushList()
  flushCode()
  return <>{blocks}</>
}
