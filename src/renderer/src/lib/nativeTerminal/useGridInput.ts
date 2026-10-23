import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type CompositionEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  type RefObject
} from 'react'
import type { ShortcutBindings } from '@core/types.js'
import type { ShellSyntax } from '@core/shell.js'
import { usesControlAsPrimary } from '@core/shortcuts.js'
import { clipboardKey, isAppShortcut, multilineSequence } from '../terminalKeys.js'
import { encodeKey, pasteSequence } from './keys.js'
import { droppedText } from './pointerMath.js'
import type { BlockListState } from './blockList.js'
import type { GridSelection } from './selection.js'
import type { ScreenState } from './useNativeEngine.js'

/**
 * Keys, clipboard, drag and drop, input methods (IME) and focus for the native view. Typing goes to
 * Styr's input at a prompt and straight to the PTY while a command runs; the input comes and goes
 * with the prompt, so focus follows it.
 */
export function useGridInput({
  sessionId,
  host,
  inputRef,
  imeRef,
  active,
  list,
  agentMode,
  typing,
  grid,
  state,
  bindingsRef,
  syntaxRef,
  selectionRef,
  hasGridSelection,
  clearSelection,
  gridSelectionText,
  write
}: {
  sessionId: string
  host: RefObject<HTMLDivElement | null>
  inputRef: RefObject<HTMLTextAreaElement | null>
  /** The grid's hidden input: keys and input methods (IME) type into it, never into the page. */
  imeRef: RefObject<HTMLTextAreaElement | null>
  active: boolean
  list: BlockListState | null
  agentMode: boolean
  /** Keys go to Styr's input rather than straight to the PTY. */
  typing: boolean
  grid: ScreenState | null
  /** The screen the program is drawing, whose modes decide how keys are sent. */
  state: ScreenState | null
  bindingsRef: RefObject<ShortcutBindings>
  syntaxRef: RefObject<ShellSyntax>
  selectionRef: RefObject<GridSelection | null>
  hasGridSelection: () => boolean
  clearSelection: () => void
  gridSelectionText: (picked: GridSelection) => Promise<string>
  write: (data: string) => void
}) {
  const segmentKey = list ? `${list.active.kind}:${list.active.id}:${agentMode}` : 'grid'
  const focusRef = useRef<() => void>(() => {})
  focusRef.current = () => {
    if (!host.current) return
    // Without scrolling: a command that ends while the reader is scrolled up leaves them there.
    if (typing && inputRef.current) inputRef.current.focus({ preventScroll: true })
    else if (
      !host.current.contains(document.activeElement) ||
      document.activeElement === document.body
    )
      (imeRef.current ?? host.current).focus()
  }
  useEffect(() => {
    if (!active) return
    const frame = requestAnimationFrame(() => focusRef.current())
    return () => cancelAnimationFrame(frame)
  }, [active, segmentKey])

  const selectedText = (): string => {
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed || !host.current) return ''
    return host.current.contains(selection.anchorNode) ? selection.toString() : ''
  }

  /** From Styr's command input, which handles its own keys (the grid's hidden input does not). */
  const fromInput = (target: EventTarget): boolean =>
    target instanceof HTMLTextAreaElement && target !== imeRef.current

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    // The command input handles its own keys.
    if (fromInput(event.target)) return
    const native = event.nativeEvent
    // An input method is composing: its keys are its own until it commits the text.
    if (native.isComposing || native.keyCode === 229) return
    const gridSelected = grid !== null && hasGridSelection()
    const clipboard = clipboardKey(native, gridSelected || selectedText() !== '')
    if (clipboard === 'copy') {
      event.preventDefault()
      if (gridSelected) return copyGridSelection()
      void navigator.clipboard.writeText(selectedText())
      window.getSelection()?.removeAllRanges()
      return
    }
    // Left to the browser, whose paste event arrives in onPaste.
    if (clipboard === 'paste') return
    const multiline = multilineSequence(native)
    if (multiline !== null) {
      event.preventDefault()
      write(multiline)
      return
    }
    if (isAppShortcut(native, bindingsRef.current)) return
    if (typing) {
      // Focus moves before the key's default action, so the character lands in the input.
      inputRef.current?.focus()
      return
    }
    const sequence = encodeKey(native, {
      modes: { appCursor: state?.modes.appCursor ?? false },
      altIsMeta: usesControlAsPrimary()
    })
    if (sequence === null) return
    event.preventDefault()
    clearSelection()
    write(sequence)
  }

  /** Copies the grid's selection, which is read from the engine, so after the copy event. */
  const copyGridSelection = (): void => {
    const picked = selectionRef.current
    if (!picked) return
    void gridSelectionText(picked).then((text) => navigator.clipboard.writeText(text))
    clearSelection()
  }

  // ⌘C on macOS arrives as the menu's copy, not as a key the grid sees.
  const onCopy = (event: ClipboardEvent<HTMLDivElement>): void => {
    if (grid === null || !hasGridSelection()) return
    event.preventDefault()
    copyGridSelection()
  }

  /** Puts text into the command input as if typed, so it can still be edited before running. */
  const insertIntoInput = (text: string): void => {
    inputRef.current?.focus()
    document.execCommand('insertText', false, text)
  }

  const onPaste = (event: ClipboardEvent<HTMLDivElement>): void => {
    if (fromInput(event.target)) return
    const text = event.clipboardData.getData('text/plain')
    if (!text) return
    event.preventDefault()
    if (typing) return insertIntoInput(text)
    write(pasteSequence(text, state?.modes.bracketedPaste ?? false))
  }

  const focusReport = (focused: boolean): void => {
    if (state?.modes.focusEvents)
      window.api.terminal.write(sessionId, focused ? '\x1b[I' : '\x1b[O')
  }
  /** Focus moving inside the terminal (to its hidden input, say) is not the terminal's focus. */
  const leftTerminal = (related: EventTarget | null): boolean =>
    !(related instanceof Node && host.current?.contains(related))

  // An input method's text arrives when it commits; until then it is shown at the cursor.
  const [composition, setComposition] = useState('')
  const onCompositionEnd = (event: CompositionEvent<HTMLTextAreaElement>): void => {
    setComposition('')
    event.currentTarget.value = ''
    if (!event.data) return
    clearSelection()
    write(event.data)
  }
  /** Text typed without a key the grid encodes: the emoji picker, dictation, an accent menu. */
  const onImeInput = (event: FormEvent<HTMLTextAreaElement>): void => {
    if ((event.nativeEvent as InputEvent).isComposing) return
    const text = event.currentTarget.value
    event.currentTarget.value = ''
    if (!text) return
    clearSelection()
    write(text)
  }

  const onDragOver = (event: DragEvent<HTMLDivElement>): void => {
    if (!event.dataTransfer.types.includes('Files')) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }
  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    const files = Array.from(event.dataTransfer.files)
    if (files.length === 0) return
    event.preventDefault()
    const paths = window.api.terminal.pathsForFiles(files)
    if (paths.length > 0) {
      const text = droppedText(paths, (path) => syntaxRef.current.quote(path))
      if (typing) return insertIntoInput(text)
      write(pasteSequence(text, state?.modes.bracketedPaste ?? false))
    }
    host.current?.focus()
  }

  return {
    onKeyDown,
    onCopy,
    onPaste,
    onDragOver,
    onDrop,
    focusReport,
    leftTerminal,
    selectedText,
    composition,
    imeHandlers: {
      onCompositionStart: () => setComposition(''),
      onCompositionUpdate: (event: CompositionEvent<HTMLTextAreaElement>) =>
        setComposition(event.data),
      onCompositionEnd,
      onInput: onImeInput
    }
  }
}
