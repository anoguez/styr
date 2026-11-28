import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ChatMarkdown } from './ChatMarkdown.js'

const html = (text: string): string => renderToStaticMarkup(createElement(ChatMarkdown, { text }))

describe('ChatMarkdown', () => {
  it('draws fenced code as a block, untouched', () => {
    const out = html('Run this:\n```sh\nyarn test **now**\n```\nDone.')
    expect(out).toContain('<pre')
    expect(out).toContain('yarn test **now**')
    expect(out).not.toContain('<strong>now</strong>')
    expect(out).toContain('Done.')
  })

  it('runs an unclosed fence to the end as code', () => {
    expect(html('```\nconst a = 1')).toContain('const a = 1</pre>')
  })

  it('draws headings, bullet and numbered lists', () => {
    const out = html('## Summary\n- one\n- two\n\n1. first\n2. second')
    expect(out).toContain('Summary')
    expect(out).toContain('<ul')
    expect(out).toContain('<li>one</li>')
    expect(out).toContain('<ol')
    expect(out).toContain('<li>second</li>')
  })

  it('keeps line breaks inside a paragraph and applies inline rules', () => {
    const out = html('Fixed **two** tests\nin `a.ts`')
    expect(out).toContain('<br/>')
    expect(out).toContain('font-semibold')
    expect(out).toContain('>a.ts</code>')
  })

  it('shows markup as text and links only web addresses', () => {
    const out = html(
      '<img src=x onerror=alert(1)> [x](javascript:alert(1)) [docs](https://example.com)'
    )
    expect(out).toContain('&lt;img')
    expect(out).not.toContain('javascript:')
    expect(out).toContain('href="https://example.com"')
  })
})
