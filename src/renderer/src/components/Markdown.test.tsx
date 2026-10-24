import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Markdown } from './Markdown.js'

const render = (text: string): string => renderToStaticMarkup(createElement(Markdown, { text }))

describe('Markdown', () => {
  it('renders headings, bullets, bold and code', () => {
    const html = render('### Features\n\n* a **bold** move\n- uses `code`\n\nplain text')
    expect(html).toContain('<h3')
    expect(html).toContain('Features')
    expect(html.match(/<li>/g)).toHaveLength(2)
    expect(html).toContain('<strong')
    expect(html).toContain('<code')
    expect(html).toContain('<p')
  })

  it('keeps http(s) links, opened safely', () => {
    const html = render('[notes](https://github.com/anoguez/styr/releases)')
    expect(html).toContain('href="https://github.com/anoguez/styr/releases"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noreferrer"')
  })

  it('turns other schemes into plain text', () => {
    const html = render('[click](javascript:alert(1)) and [d](data:text/html,x) [f](file:///etc)')
    expect(html).not.toContain('<a')
    expect(html).not.toContain('href')
    expect(html).toContain('click')
  })

  it('shows raw HTML as literal text', () => {
    const html = render('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('&lt;img')
  })
})
