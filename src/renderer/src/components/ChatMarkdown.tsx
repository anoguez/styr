import type { ReactNode } from 'react'
import { inline } from './Markdown.js'

/** `#`, `##` and `###` in the app's title sizes; deeper headings keep the body's. */
const HEADING_SIZE: Record<number, string> = {
  1: 'text-[20px] leading-tight',
  2: 'text-[15px]',
  3: 'text-[14px]'
}

/**
 * The app's chat type: inline code in the mono face a little smaller than the text around it. The
 * caller sets the body size.
 */
export const chatProse =
  '[&_code]:bg-card [&_code]:border-edge [&_code]:border [&_code]:text-[0.84em]'

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
      <p key={blocks.length} className="my-2 first:mt-0 last:mb-0">
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
        className={`marker:text-dim my-2 space-y-1.5 pl-6 first:mt-0 last:mb-0 ${ordered ? 'list-decimal' : 'list-disc'}`}
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
        className="border-edge bg-card text-ink my-2 overflow-x-auto rounded-[10px] border p-3 font-mono text-[12.5px] leading-normal whitespace-pre first:mt-0 last:mb-0"
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
        <p
          key={blocks.length}
          className={`text-ink mt-3 mb-1.5 font-semibold first:mt-0 ${HEADING_SIZE[heading[1]!.length] ?? ''}`}
        >
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
