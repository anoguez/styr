import {
  useLayoutEffect,
  type ChangeEvent,
  type ClipboardEvent,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject
} from 'react'
import type { AgentCommand } from '@core/agentConversation.js'
import { matchCommands, slashQuery } from '../lib/nativeTerminal/commandMenu.js'
import { inputAction, stepHistory, type HistoryCursor } from '../lib/nativeTerminal/commandInput.js'
import type { RunPalette } from '../lib/nativeTerminal/style.js'

/*
 * Styr's own `❯` input, shared by the native engine's block list (a shell's commands) and the agent
 * chat on either engine (`AgentBlockList`): history, the slash-command menu, image paste.
 */

export interface InputHint {
  /** The key, as `shortcutHint` writes it. */
  keys: string
  label: string
}

export interface Look {
  palette: RunPalette
  /** One terminal row, in pixels. */
  lineHeight: number
}

/** What `useCommandInput` takes: the input's program, its history and what its keys do. */
export interface CommandInputOptions {
  inputRef: RefObject<HTMLTextAreaElement | null>
  history: string[]
  /** The line as typed; the caller sends it in whatever form its program expects. */
  onSubmit: (text: string) => void
  onClearBlocks?: () => void
  /** Escape, when it means something here (interrupting an agent). */
  onEscape?: () => void
  /** An image pasted with no text, for a program that takes one; absent, the paste is ignored. */
  onPasteImage?: () => void
  /** The program's slash commands, offered in a menu while `/name` is typed. */
  commands?: AgentCommand[]
}

/** The input's state and handlers, whatever draws it: the terminal's `❯` line or the chat's field. */
export interface CommandInputState {
  text: string
  /** Something was typed since the input appeared. */
  typed: boolean
  /** The slash commands that fit what is typed, and the one picked; empty when the menu is shut. */
  matches: AgentCommand[]
  choice: AgentCommand | undefined
  /** Sends what is typed, as Enter does (a button's click). */
  submit: () => void
  /** Sends a command picked from the menu. */
  pick: (command: AgentCommand) => void
  onChange: (event: ChangeEvent<HTMLTextAreaElement>) => void
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void
  onPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void
}

/**
 * The keys of Styr's input, shared by every look of it: history, the slash-command menu, Escape,
 * image paste. The program sees a line only once it is submitted.
 */
export function useCommandInput({
  inputRef,
  history,
  commands,
  onSubmit,
  onClearBlocks,
  onEscape,
  onPasteImage
}: CommandInputOptions): CommandInputState {
  const [text, setText] = useState('')
  const [typed, setTyped] = useState(false)
  const cursor = useRef<HistoryCursor>({ index: null, draft: '' })
  const [picked, setPicked] = useState(0)
  // Escape closes the menu for the text as typed; typing on opens it again.
  const [closedFor, setClosedFor] = useState<string | null>(null)
  const query = commands && commands.length > 0 ? slashQuery(text) : null
  const matches = query !== null && closedFor !== text ? matchCommands(query, commands ?? []) : []
  const choice = matches[Math.min(picked, matches.length - 1)]

  const reset = (): void => {
    setText('')
    setPicked(0)
    cursor.current = { index: null, draft: '' }
  }

  const submit = (): void => {
    if (!text.trim()) return
    onSubmit(text)
    setText('')
    cursor.current = { index: null, draft: '' }
  }

  /** Keys the open command menu takes; true when it took this one. */
  const menuKey = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!choice || event.nativeEvent.isComposing) return false
    const plain = !event.ctrlKey && !event.metaKey && !event.altKey
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const step = event.key === 'ArrowDown' ? 1 : -1
      setPicked((index) => (index + step + matches.length) % matches.length)
    } else if (event.key === 'Tab' && plain) {
      setText(`/${choice.name} `)
      setPicked(0)
    } else if (event.key === 'Enter' && plain && !event.shiftKey) {
      onSubmit(`/${choice.name}`)
      reset()
    } else if (event.key === 'Escape') {
      setClosedFor(text)
    } else return false
    event.preventDefault()
    event.stopPropagation()
    return true
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    const element = event.currentTarget
    if (menuKey(event)) return
    if (event.key === 'Escape' && onEscape && !event.nativeEvent.isComposing) {
      event.preventDefault()
      event.stopPropagation()
      onEscape()
      return
    }
    const action = inputAction(
      { ...event, key: event.key, isComposing: event.nativeEvent.isComposing },
      { text, start: element.selectionStart, end: element.selectionEnd }
    )
    if (action.kind === 'default') return
    event.preventDefault()
    // The surface's own keys (Ask agent, change directory…) must not reach the shell either.
    event.stopPropagation()
    if (action.kind === 'submit') {
      submit()
    } else if (action.kind === 'discard') {
      setText('')
      cursor.current = { index: null, draft: '' }
    } else if (action.kind === 'clearBlocks') {
      onClearBlocks?.()
    } else if (action.kind === 'history') {
      const next = stepHistory(history, cursor.current, text, action.step)
      if (!next) return
      cursor.current = next.cursor
      setText(next.text)
      requestAnimationFrame(() => {
        const end = next.text.length
        inputRef.current?.setSelectionRange(end, end)
      })
    }
  }

  return {
    text,
    typed,
    matches,
    choice,
    submit,
    pick: (command) => {
      onSubmit(`/${command.name}`)
      reset()
      inputRef.current?.focus()
    },
    onChange: (event) => {
      setText(event.target.value)
      setTyped(true)
      setPicked(0)
      if (cursor.current.index !== null) cursor.current = { ...cursor.current, index: null }
    },
    onKeyDown,
    onPaste: (event) => {
      const { clipboardData } = event
      if (!onPasteImage || clipboardData.getData('text/plain')) return
      const image = [...clipboardData.items].some(
        (item) => item.kind === 'file' && item.type.startsWith('image/')
      )
      if (!image) return
      event.preventDefault()
      event.stopPropagation()
      onPasteImage()
    }
  }
}

/**
 * Styr's `❯` input, for a shell's commands and an agent's prompts alike: the program sees a line
 * only once it is submitted.
 */
export function CommandInput({
  look,
  inputRef,
  history,
  hints,
  label = 'Command',
  trailing,
  commands,
  onSubmit,
  onClearBlocks,
  onEscape,
  onPasteImage
}: CommandInputOptions & {
  look: Look
  hints: InputHint[]
  label?: string
  /** Shown at the end of the row whatever is typed. */
  trailing?: ReactNode
}): ReactNode {
  const input = useCommandInput({
    inputRef,
    history,
    commands,
    onSubmit,
    onClearBlocks,
    onEscape,
    onPasteImage
  })
  const { text, typed, matches, choice } = input
  return (
    <section aria-label="Prompt" className="-mx-0.5 shrink-0 px-2 py-[3px]">
      <div className="flex min-h-[22px] items-start gap-2">
        <span aria-hidden className="text-accent" style={{ lineHeight: `${look.lineHeight}px` }}>
          ❯
        </span>
        <div className="relative min-w-0 flex-1">
          {choice ? <CommandMenu commands={matches} picked={choice} onPick={input.pick} /> : null}
          <textarea
            ref={inputRef}
            value={text}
            rows={Math.max(1, text.split('\n').length)}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            aria-label={label}
            aria-expanded={choice ? true : undefined}
            aria-controls={choice ? 'styr-command-menu' : undefined}
            className="text-ink caret-accent block w-full resize-none border-0 bg-transparent p-0 outline-none focus-visible:outline-none"
            // Inline, because the app's focus ring is an unlayered rule that utilities cannot beat.
            style={{ font: 'inherit', lineHeight: `${look.lineHeight}px`, outline: 'none' }}
            onChange={input.onChange}
            onKeyDown={input.onKeyDown}
            onPaste={input.onPaste}
          />
          {!typed && text === '' && hints.length > 0 ? (
            <span
              aria-hidden
              className="text-faint pointer-events-none absolute top-0 right-0 flex items-center gap-2.5 font-sans text-[11.5px]"
              style={{ height: look.lineHeight }}
            >
              {hints.map((hint) => (
                <span key={hint.label}>
                  <span className="font-mono text-[10.5px]">{hint.keys}</span> {hint.label}
                </span>
              ))}
            </span>
          ) : null}
        </div>
        {trailing}
      </div>
    </section>
  )
}

/** The program's slash commands that fit what is typed, above the input, as its own menu has them. */
export function CommandMenu({
  commands,
  picked,
  onPick
}: {
  commands: AgentCommand[]
  picked: AgentCommand
  onPick: (command: AgentCommand) => void
}): ReactNode {
  const list = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [picked])
  return (
    <div
      ref={list}
      id="styr-command-menu"
      role="listbox"
      aria-label="Commands"
      className="border-edge-strong bg-panel absolute bottom-full left-0 z-20 mb-1 max-h-64 w-[min(36rem,100%)] overflow-y-auto rounded-lg border p-1 font-sans shadow-xl"
    >
      {commands.map((command) => {
        const selected = command === picked
        return (
          <div
            key={command.name}
            role="option"
            aria-selected={selected}
            className={`flex cursor-pointer items-baseline gap-3 rounded-md px-2 py-1 text-[12px] ${
              selected ? 'bg-raised text-ink' : 'text-dim'
            }`}
            // Mouse down, not click: the input keeps its focus.
            onMouseDown={(event) => {
              event.preventDefault()
              onPick(command)
            }}
          >
            <span className="text-ink shrink-0 font-mono text-[11.5px]">/{command.name}</span>
            <span className="text-faint min-w-0 truncate">{command.description}</span>
          </div>
        )
      })}
    </div>
  )
}
