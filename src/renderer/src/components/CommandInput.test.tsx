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
import { CommandInput } from './CommandInput.js'

type Props = Parameters<typeof CommandInput>[0]
type Handlers = {
  onKeyDown: (event: unknown) => void
  onPaste: (event: unknown) => void
  onChange: (event: unknown) => void
}

const look = { palette: {} as never, lineHeight: 18 }

/** The `<textarea>` CommandInput draws, found in the tree it returns. */
function textarea(node: ReactNode): Handlers | null {
  let found: Handlers | null = null
  Children.forEach(node, (child) => {
    if (found || !isValidElement(child)) return
    const element = child as ReactElement<{ children?: ReactNode } & Partial<Handlers>>
    if (element.type === 'textarea') found = element.props as Handlers
    else found = textarea(element.props.children)
  })
  return found
}

/**
 * Renders the input once inside a probe, and hands back its textarea's handlers: called after the
 * render, a state update is a no-op on the server, so each test reads what the input passed on.
 */
function input(props: Partial<Props> = {}): { field: Handlers; props: Props } {
  const all: Props = {
    look,
    inputRef: createRef<HTMLTextAreaElement>(),
    history: ['first', 'second'],
    hints: [{ keys: '⌘L', label: 'ask agent' }],
    label: 'Message Claude Code',
    onSubmit: vi.fn(),
    ...props
  }
  let tree: ReactNode = null
  function Probe(): ReactNode {
    tree = CommandInput(all)
    return null
  }
  renderToStaticMarkup(createElement(Probe))
  return { field: textarea(tree)!, props: all }
}

const key = (name: string, extra: Record<string, unknown> = {}) => ({
  key: name,
  shiftKey: false,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  currentTarget: { selectionStart: 0, selectionEnd: 0 },
  nativeEvent: { isComposing: false },
  preventDefault: vi.fn(),
  stopPropagation: vi.fn(),
  ...extra
})

const paste = (text: string, items: { kind: string; type: string }[]) => ({
  clipboardData: { getData: () => text, items },
  preventDefault: vi.fn(),
  stopPropagation: vi.fn()
})

describe('CommandInput', () => {
  beforeEach(() => vi.stubGlobal('requestAnimationFrame', (run: () => void) => run()))
  afterEach(() => vi.unstubAllGlobals())

  it('draws its label, prompt mark and key hints', () => {
    const html = renderToStaticMarkup(
      createElement(CommandInput, {
        look,
        inputRef: createRef<HTMLTextAreaElement>(),
        history: [],
        hints: [{ keys: '⌘L', label: 'ask agent' }],
        label: 'Message Claude Code',
        trailing: createElement('span', null, 'Claude Code view'),
        onSubmit: vi.fn()
      })
    )
    expect(html).toContain('aria-label="Message Claude Code"')
    expect(html).toContain('❯')
    expect(html).toContain('ask agent')
    expect(html).toContain('Claude Code view')
  })

  it('interrupts on Escape when that means something, and keeps the key from the terminal', () => {
    const onEscape = vi.fn()
    const { field } = input({ onEscape })
    const event = key('Escape')
    field.onKeyDown(event)
    expect(onEscape).toHaveBeenCalled()
    expect(event.preventDefault).toHaveBeenCalled()
    expect(event.stopPropagation).toHaveBeenCalled()
  })

  it('leaves Escape to the page while the agent is idle, and a key in composition alone', () => {
    const { field } = input()
    const escape = key('Escape')
    field.onKeyDown(escape)
    expect(escape.preventDefault).not.toHaveBeenCalled()
    const composing = key('Enter', { nativeEvent: { isComposing: true } })
    field.onKeyDown(composing)
    expect(composing.preventDefault).not.toHaveBeenCalled()
  })

  it('sends nothing for an empty line, but takes the Enter', () => {
    const { field, props } = input()
    const enter = key('Enter')
    field.onKeyDown(enter)
    expect(enter.preventDefault).toHaveBeenCalled()
    expect(props.onSubmit).not.toHaveBeenCalled()
  })

  it('steps through history with Up, and takes Ctrl+C, Ctrl+L and Tab', () => {
    const onClearBlocks = vi.fn()
    const { field } = input({ onClearBlocks })
    for (const event of [
      key('ArrowUp'),
      key('ArrowDown'),
      key('c', { ctrlKey: true }),
      key('l', { ctrlKey: true }),
      key('Tab')
    ]) {
      field.onKeyDown(event)
      expect(event.preventDefault).toHaveBeenCalled()
    }
    expect(onClearBlocks).toHaveBeenCalled()
  })

  it('takes a pasted image for a program that accepts one, and leaves text to the field', () => {
    const onPasteImage = vi.fn()
    const { field } = input({ onPasteImage })
    const image = paste('', [{ kind: 'file', type: 'image/png' }])
    field.onPaste(image)
    expect(onPasteImage).toHaveBeenCalledTimes(1)
    expect(image.preventDefault).toHaveBeenCalled()

    const text = paste('hello', [{ kind: 'string', type: 'text/plain' }])
    field.onPaste(text)
    const file = paste('', [{ kind: 'file', type: 'application/pdf' }])
    field.onPaste(file)
    expect(onPasteImage).toHaveBeenCalledTimes(1)
    expect(text.preventDefault).not.toHaveBeenCalled()
    expect(file.preventDefault).not.toHaveBeenCalled()
  })

  it('ignores a pasted image when the program cannot take one', () => {
    const { field } = input()
    const image = paste('', [{ kind: 'file', type: 'image/png' }])
    field.onPaste(image)
    expect(image.preventDefault).not.toHaveBeenCalled()
  })

  it('accepts typing', () => {
    const { field } = input()
    expect(() => field.onChange({ target: { value: '/com' } })).not.toThrow()
  })
})
