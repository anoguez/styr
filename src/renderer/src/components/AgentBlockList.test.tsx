import {
  Children,
  createElement,
  createRef,
  isValidElement,
  type ReactElement,
  type ReactNode
} from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BlockState, StyrBlock } from '@core/types/blocks.js'
import { AgentBlockList, type ApprovalRequest } from './AgentBlockList.js'

type Props = Parameters<typeof AgentBlockList>[0]
type Element = ReactElement<Record<string, unknown> & { children?: ReactNode }>

const envelope = { sessionId: 't1', createdAt: 0, updatedAt: 0 }
const message = (id: string, role: 'user' | 'assistant', text: string): StyrBlock => ({
  ...envelope,
  id,
  state: 'completed',
  kind: 'agent-message',
  payload: { role, text }
})
const toolCall = (id: string, state: BlockState, extra: object = {}): StyrBlock => ({
  ...envelope,
  id,
  state,
  kind: 'agent-tool-call',
  payload: { tool: 'Bash', summary: 'npm test', ...extra }
})
const diffOf = (parentId: string): StyrBlock => ({
  ...envelope,
  id: `d-${parentId}`,
  parentId,
  state: 'completed',
  kind: 'diff',
  payload: { path: 'a.ts', patch: '@@ -1 +1,2 @@\n-a\n+b\n+c\n', additions: 2, deletions: 1 }
})

/**
 * Every host element the list draws, its function components called in place, inside one probe
 * render: handlers called after it run their logic, and a state update is a no-op on the server.
 */
function draw(props: Partial<Props> = {}): { elements: Element[]; props: Props } {
  const all: Props = {
    blocks: [],
    working: false,
    label: 'Claude Code',
    approval: null,
    inputRef: createRef<HTMLTextAreaElement>(),
    history: [],
    onSubmit: vi.fn(),
    onInterrupt: vi.fn(),
    onAnswer: vi.fn(),
    onShowTui: vi.fn(),
    ...props
  }
  const elements: Element[] = []
  const walk = (node: ReactNode): void => {
    Children.forEach(node, (child) => {
      if (!isValidElement(child)) return
      const element = child as Element
      if (typeof element.type === 'function') {
        walk((element.type as (p: unknown) => ReactNode)(element.props))
        return
      }
      elements.push(element)
      walk(element.props.children)
    })
  }
  function Probe(): ReactNode {
    walk(AgentBlockList(all))
    return null
  }
  renderToStaticMarkup(createElement(Probe))
  return { elements, props: all }
}

const text = (node: ReactNode): string => {
  let out = ''
  Children.forEach(node, (child) => {
    if (typeof child === 'string' || typeof child === 'number') out += String(child)
    else if (isValidElement(child)) out += text((child as Element).props.children)
  })
  return out
}

/** The button whose label, title or text holds `name`. */
function button(elements: Element[], name: string): Element {
  const found = elements.find(
    (element) =>
      element.type === 'button' &&
      [element.props['aria-label'], element.props.title, text(element.props.children)].some(
        (label) => typeof label === 'string' && label.includes(name)
      )
  )
  if (!found) throw new Error(`no button “${name}”`)
  return found
}

const click = (element: Element): void => (element.props.onClick as () => void)()

describe('agent chat interactions', () => {
  beforeEach(() => vi.stubGlobal('requestAnimationFrame', (run: () => void) => run()))
  afterEach(() => vi.unstubAllGlobals())

  it('answers an approval with the option clicked', () => {
    const approval: ApprovalRequest = {
      prompt: 'Run npm test?',
      summary: 'npm test',
      edit: { patch: '@@ -1 +1 @@\n-one\n+two\n', additions: 1, deletions: 1 },
      options: [
        { id: 'yes', label: 'Allow once', kind: 'allow' },
        { id: 'always', label: 'Always', kind: 'allow-always' },
        { id: 'no', label: 'Deny', kind: 'deny' }
      ],
      keys: true
    }
    const { elements, props } = draw({ approval })
    for (const label of ['Allow once', 'Always', 'Deny']) click(button(elements, label))
    expect(vi.mocked(props.onAnswer).mock.calls.map(([option]) => option.id)).toEqual([
      'yes',
      'always',
      'no'
    ])
    // Answered by the TUI's keys: the buttons say which.
    expect(text(button(elements, 'Allow once').props.children)).toContain('↵')
    expect(text(button(elements, 'Deny').props.children)).toContain('esc')
    // An edit shows its change in the card.
    expect(elements.some((element) => element.props.children === '+')).toBe(true)
    click(button(elements, 'Answer in Claude Code'))
    expect(props.onShowTui).toHaveBeenCalledOnce()
  })

  it('sends a question to the terminal', () => {
    const { elements, props } = draw({
      approval: { prompt: 'Which?', options: [], keys: false, inTui: true }
    })
    click(button(elements, 'Answer in Terminal'))
    expect(props.onShowTui).toHaveBeenCalledOnce()
  })

  it('interrupts a turn from the composer, which leaves the CLI’s view to the tab’s switch', () => {
    const { elements, props } = draw({ working: true })
    click(button(elements, 'Interrupt'))
    expect(props.onInterrupt).toHaveBeenCalledOnce()
    expect(elements.some((element) => text(element.props.children) === 'Claude Code view')).toBe(
      false
    )
  })

  it('draws no status row above an idle composer', () => {
    const { elements } = draw()
    expect(elements.some((element) => String(element.props.className).includes('pb-1.5'))).toBe(
      false
    )
    const busy = draw({ working: true }).elements
    expect(busy.some((element) => String(element.props.className).includes('pb-1.5'))).toBe(true)
  })

  it('keeps Send off until something is typed, and sends nothing empty', () => {
    const { elements, props } = draw()
    const send = button(elements, 'Send')
    expect(send.props.disabled).toBe(true)
    click(send)
    expect(props.onSubmit).not.toHaveBeenCalled()
  })

  it('copies a message and a tool call’s text to the clipboard', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const { elements } = draw({ blocks: [message('m1', 'user', 'Debounce the watcher')] })
    click(button(elements, 'Copy message'))
    expect(writeText).toHaveBeenCalledWith('Debounce the watcher')
    await Promise.resolve()
    const copy = elements.find((element) => element.props['aria-label'] === 'Copy message')!
    ;(copy.props.onMouseLeave as () => void)()
  })

  it('marks every state of a tool call by its shape and opens it on click', () => {
    const states: BlockState[] = ['pending', 'streaming', 'completed', 'failed', 'cancelled']
    // A message between the calls keeps each one its own row rather than a group.
    const apart = (extra: object = {}): StyrBlock[] =>
      states.flatMap((state, at) => [
        toolCall(`t${at}`, state, extra),
        message(`m${at}`, 'assistant', 'Next.')
      ])
    const { elements } = draw({ blocks: apart({ result: 'Exit code 1' }) })
    const html = renderToStaticMarkup(
      createElement(AgentBlockList, { ...draw().props, blocks: apart() })
    )
    expect(html.match(/animate-spin/g)).toHaveLength(2)
    expect(html).toContain('✓')
    expect(html).toContain('✕')
    expect(html).toContain('−')
    expect(html).toContain('Bash npm test, running')
    const rows = elements.filter((element) => element.props['aria-expanded'] === false)
    expect(rows).toHaveLength(states.length)
    for (const row of rows) click(row)
  })

  it('folds calls in a row into a group that shows the running call live and opens to them', () => {
    const running = toolCall('t3', 'streaming', { summary: 'yarn build\nmore' })
    const blocks = [toolCall('t1', 'completed'), toolCall('t2', 'failed'), running, diffOf('t2')]
    const html = renderToStaticMarkup(createElement(AgentBlockList, { ...draw().props, blocks }))
    expect(html).toContain('aria-label="Bash ×3, 3 calls, running"')
    expect(html).toMatch(/role="status"[^>]*>yarn build</)
    expect(html).toContain('border-danger')
    expect(html).toContain('+2')
    // Folded, the calls themselves are not drawn; a click opens the group to them.
    expect(html).not.toContain('Bash npm test, failed')
    const { elements } = draw({ blocks })
    const group = elements.find((element) => element.props['aria-expanded'] === false)!
    click(group)

    const done = renderToStaticMarkup(
      createElement(AgentBlockList, {
        ...draw().props,
        blocks: [toolCall('t1', 'completed'), toolCall('t2', 'failed')]
      })
    )
    expect(done).toContain('2 calls')
    expect(done).toContain('1 failed')
  })

  it('stays on the newest row until the person scrolls up', () => {
    const { elements } = draw({ blocks: [message('m1', 'assistant', 'Hi')] })
    const scroller = elements.find((element) => typeof element.props.onScroll === 'function')!
    const scroll = (top: number): void =>
      (scroller.props.onScroll as (event: unknown) => void)({
        currentTarget: { scrollHeight: 2000, clientHeight: 500, scrollTop: top }
      })
    scroll(1500)
    scroll(100)
  })
})
