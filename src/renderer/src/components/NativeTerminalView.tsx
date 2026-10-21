import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type CompositionEvent,
  type CSSProperties,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
  type MutableRefObject,
  type WheelEvent,
  type ReactNode
} from 'react'
import type {
  EngineFrameLine,
  NativeUnavailableReason,
  ShortcutBindings,
  ThemeSettings
} from '@core/types.js'
import { AGENT_PROVIDER_LABELS } from '@core/types.js'
import { syntaxFor, type ShellDialect } from '@core/shell.js'
import { terminalTheme } from '../lib/palette.js'
import { clipboardKey, isAppShortcut, multilineSequence } from '../lib/terminalKeys.js'
import { usesControlAsPrimary } from '@core/shortcuts.js'
import { ScreenModel } from '../lib/nativeTerminal/screen.js'
import {
  BlockFeed,
  lineAtOffset,
  nativeBlockLayout,
  viewportTop
} from '../lib/nativeTerminal/blocks.js'
import {
  cellAt,
  encodeMouse,
  mouseButton,
  reportsMouse,
  type MouseButton,
  type MouseReport
} from '../lib/nativeTerminal/mouse.js'
import { isOpenableLink, linkRows } from '../lib/nativeTerminal/links.js'
import { rowCells } from '../lib/nativeTerminal/cells.js'
import {
  isEmptySelection,
  orderedRange,
  selectionSpans,
  selectionText,
  type GridSelection
} from '../lib/nativeTerminal/selection.js'
import { BlockListStore } from '../lib/nativeTerminal/blockList.js'
import { onSessionExit } from '../lib/terminalEvents.js'
import { TerminalBlockList, type InputHint } from './TerminalBlockList.js'
import { AgentBlockList, type ApprovalRequest } from './AgentBlockList.js'
import {
  AGENT_ENTER_DELAY_MS,
  agentPrompt,
  promptRoute
} from '../lib/nativeTerminal/commandInput.js'
import { isSlashCommand } from '../lib/nativeTerminal/commandMenu.js'
import { agentProgramProvider } from '@core/handoff.js'
import {
  agentBlocks,
  approvalOptions,
  DEFAULT_APPROVAL_OPTIONS,
  promptHistory,
  type AgentConversation,
  type ConversationAdapter
} from '@core/agentConversation.js'
import { conversationAdapter } from '@core/providers/conversation.js'
import type { AgentProviderId } from '@core/providers/types.js'
import type { BlockActions } from './TerminalBlocks.js'
import { encodeKey, pasteSequence } from '../lib/nativeTerminal/keys.js'
import { paletteFromTheme, runStyle, type RunPalette } from '../lib/nativeTerminal/style.js'
import type { BlockLayout, TerminalHandle, TerminalSelection } from './TerminalView.js'

const LINE_HEIGHT = 1.25
/**
 * Pixels the block list takes from the width before output starts: its padding, a block's padding
 * and the output's indent under the command, and the scrollbar. Programs are told the columns that
 * fit after it, so their lines wrap where they will be shown.
 */
const LIST_INSET = 56

interface Cell {
  width: number
  height: number
}

/**
 * Styr Terminal's view: draws the frames a native engine in the main process sends, and sends keys
 * to the same PTY xterm.js would. Output is untrusted, so every character goes in as text content —
 * nothing it contains is parsed as markup or turned into an action. Any failure hands the session to
 * `onFallback`, which mounts xterm.js in its place; the PTY is never touched.
 */
export function NativeTerminalView({
  sessionId,
  dialect,
  active,
  theme,
  bindings,
  handle,
  onSelection,
  onFullscreenChange,
  onBlocks,
  onHoverLine,
  blockActions,
  canRetry = false,
  commandHints = [],
  onBlockListChange,
  agentProvider,
  agentWaiting,
  onFallback
}: {
  sessionId: string
  dialect?: ShellDialect
  active: boolean
  theme: ThemeSettings
  bindings: ShortcutBindings
  handle?: MutableRefObject<TerminalHandle | null>
  onSelection?: (selection: TerminalSelection | null) => void
  onFullscreenChange?: (fullscreen: boolean) => void
  /** Where the shell's commands sit in the buffer, as `TerminalView` reports them for xterm.js. */
  onBlocks?: (layout: BlockLayout) => void
  /** The buffer line under the pointer, or null when it is outside the terminal. */
  onHoverLine?: (line: number | null) => void
  /** What the block list's buttons do. */
  blockActions?: BlockActions
  canRetry?: boolean
  /** Keys shown beside the block list's empty command input. */
  commandHints?: InputHint[]
  /** The session started (true) or stopped showing as a block list. */
  onBlockListChange?: (on: boolean) => void
  /** The agent CLI a task session runs, for a command line that does not name it. */
  agentProvider?: AgentProviderId
  /** What the agent said while it waits on the person (a permission, a question); null otherwise. */
  agentWaiting?: string | null
  onFallback: (reason: NativeUnavailableReason, detail: string) => void
}): ReactNode {
  const host = useRef<HTMLDivElement>(null)
  const probe = useRef<HTMLSpanElement>(null)
  const model = useRef<ScreenModel | null>(null)
  const listRef = useRef<BlockListStore | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  /** The grid's hidden input: keys and input methods (IME) type into it, never into the page. */
  const imeRef = useRef<HTMLTextAreaElement | null>(null)
  const [, setVersion] = useState(0)
  const [exitCode, setExitCode] = useState<number | null>(null)
  const [cell, setCell] = useState<Cell>({ width: 8, height: 16 })
  const cellRef = useRef(cell)
  const palette = useMemo(() => paletteFromTheme(terminalTheme(theme)), [theme])
  // One object while neither changes, so memoised blocks and history chunks are not redrawn.
  const look = useMemo(() => ({ palette, lineHeight: cell.height }), [palette, cell.height])
  const bindingsRef = useRef(bindings)
  bindingsRef.current = bindings
  const syntaxRef = useRef(syntaxFor(dialect))
  syntaxRef.current = syntaxFor(dialect)
  const onSelectionRef = useRef(onSelection)
  onSelectionRef.current = onSelection
  const onFullscreenRef = useRef(onFullscreenChange)
  onFullscreenRef.current = onFullscreenChange
  const onFallbackRef = useRef(onFallback)
  onFallbackRef.current = onFallback
  const onBlocksRef = useRef(onBlocks)
  onBlocksRef.current = onBlocks
  const onHoverRef = useRef(onHoverLine)
  onHoverRef.current = onHoverLine
  const onBlockListRef = useRef(onBlockListChange)
  onBlockListRef.current = onBlockListChange

  const write = (data: string): void => {
    const screen = model.current?.current
    if (screen && screen.displayOffset > 0) window.api.terminal.native.scroll(sessionId, 'bottom')
    window.api.terminal.write(sessionId, data)
  }

  const fontSizeRef = useRef(theme.terminalFontSize)
  fontSizeRef.current = theme.terminalFontSize
  const pushSizeRef = useRef<(() => void) | null>(null)
  const renderRef = useRef<(() => void) | null>(null)

  // A font change alters the cell, so the grid is recomputed once the new style has applied.
  useEffect(() => {
    const frame = requestAnimationFrame(() => pushSizeRef.current?.())
    return () => cancelAnimationFrame(frame)
  }, [theme.terminalFont, theme.terminalFontSize])

  useEffect(() => {
    const element = host.current
    if (!element) return
    const screen = new ScreenModel()
    model.current = screen
    const list = new BlockListStore()
    listRef.current = list
    let listShown = false
    let disposed = false
    let attachId: number | null = null
    let frameRequest = 0
    let size = { cols: 0, rows: 0 }
    let fullscreen = false
    const blocks = new BlockFeed()

    const render = (): void => {
      if (frameRequest) return
      frameRequest = requestAnimationFrame(() => {
        frameRequest = 0
        const listed = list.state
        if ((listed !== null) !== listShown) {
          listShown = listed !== null
          onBlockListRef.current?.(listShown)
          pushSize()
        }
        // A block list is full-screen only while its running command is on the alternate screen.
        const state = listed ? listed.screen.current : screen.current
        const alternate = Boolean(state?.altScreen && (!listed || listed.active.kind === 'running'))
        if (state && alternate !== fullscreen) {
          fullscreen = alternate
          onFullscreenRef.current?.(fullscreen)
        }
        if (!listed && state) {
          onBlocksRef.current?.(nativeBlockLayout(state, blocks.blocks, cellRef.current.height))
        }
        setVersion((version) => version + 1)
      })
    }
    renderRef.current = render
    const fail = (reason: NativeUnavailableReason, detail: string): void => {
      if (disposed) return
      disposed = true
      onFallbackRef.current(reason, detail)
    }
    // The cell comes from the real font, so the grid matches what the glyphs need. A hidden view
    // measures nothing; it keeps the last cell until it is shown and the observer fires again.
    const measureCell = (): Cell => {
      const box = probe.current?.getBoundingClientRect()
      if (!box || box.width <= 0) return cellRef.current
      const next = { width: box.width / 10, height: fontSizeRef.current * LINE_HEIGHT }
      if (next.width !== cellRef.current.width || next.height !== cellRef.current.height) {
        cellRef.current = next
        setCell(next)
      }
      return next
    }
    const measure = (): { cols: number; rows: number } => {
      const { width, height } = measureCell()
      const box = element.getBoundingClientRect()
      const inset = listShown ? LIST_INSET : 0
      return {
        cols: Math.max(2, Math.floor((box.width - inset) / width)),
        rows: Math.max(1, Math.floor(box.height / height))
      }
    }

    const offFrame = window.api.terminal.native.onFrame((event) => {
      if (event.id !== sessionId) return
      // Acknowledged on arrival, whatever it is for: the host sends nothing more until it is.
      window.api.terminal.native.received(sessionId, event.attachId)
      // Before the attach reply the engine's id is unknown; the model holds the frame until then.
      if (attachId !== null && event.attachId !== attachId) return
      const moved = event.blocks ? blocks.received(event.attachId, event.blocks) : false
      const changed = event.frame ? screen.push(event.frame) : false
      if (changed || moved) render()
    })
    const offList = window.api.terminal.native.onBlocks((event) => {
      if (event.id !== sessionId) return
      window.api.terminal.native.received(sessionId, event.attachId)
      if (list.received(event)) render()
    })
    const offFailed = window.api.terminal.native.onFailed((failure) => {
      if (failure.id === sessionId) fail(failure.reason, failure.detail)
    })
    const offExit = onSessionExit(sessionId, ({ exitCode }) => setExitCode(exitCode))

    size = measure()
    void window.api.terminal.native.attach(sessionId, size.cols, size.rows).then(
      (result) => {
        if (disposed) return
        if (!result.ok) return fail(result.reason, result.detail)
        attachId = result.attachId
        blocks.attached(result.attachId, result.blocks)
        list.attached(result.attachId, result.blockList)
        screen.reset(result.frame)
        window.api.terminal.resize(sessionId, size.cols, size.rows)
        render()
      },
      (error: unknown) => fail('init-failed', String(error))
    )

    const pushSize = (): void => {
      const next = measure()
      if (next.cols === size.cols && next.rows === size.rows) return
      size = next
      window.api.terminal.native.resize(sessionId, size.cols, size.rows)
      window.api.terminal.resize(sessionId, size.cols, size.rows)
    }
    pushSizeRef.current = pushSize
    const observer = new ResizeObserver(pushSize)
    observer.observe(element)

    if (handle) {
      handle.current = {
        focus: () => (inputRef.current ?? imeRef.current ?? element).focus(),
        // The engine and its scrollback are in the main process.
        text: () => window.api.terminal.native.text(sessionId),
        lines: (from, to) => window.api.terminal.native.lines(sessionId, from, to)
      }
    }

    return () => {
      disposed = true
      cancelAnimationFrame(frameRequest)
      offFrame()
      offList()
      offFailed()
      offExit()
      observer.disconnect()
      pushSizeRef.current = null
      renderRef.current = null
      window.api.terminal.native.detach(sessionId)
      if (handle) handle.current = null
      if (fullscreen) onFullscreenRef.current?.(false)
      if (listShown) onBlockListRef.current?.(false)
      model.current = null
      listRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  // The blocks are placed by cell height, so a new cell re-reports them without waiting for output.
  useEffect(() => renderRef.current?.(), [cell])

  const list = listRef.current?.state ?? null
  // A full-screen program in the block list gets the whole panel as a grid.
  const takeover = Boolean(list?.active.kind === 'running' && list.screen.current?.altScreen)
  const prompting = list !== null && list.active.kind === 'prompt'
  /** The screen the program is drawing, whose modes decide how keys are sent. */
  const state = list ? list.screen.current : (model.current?.current ?? null)

  // An agent CLI running in the list is drawn by Styr from its conversation when its provider has
  // an adapter and the conversation is being written; otherwise, or on request, its own TUI shows.
  const running = list?.active.kind === 'running' ? list.active : null
  const provider = running ? (agentProgramProvider(running.command) ?? agentProvider) : undefined
  const adapter = provider ? conversationAdapter(provider) : undefined
  const conversation = useAgentConversation(sessionId)
  const [tuiFor, setTuiFor] = useState<string | null>(null)
  // An agent prompt's Enter goes after its paste (`agentPrompt`); dropped if the view goes first.
  const pendingEnter = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (pendingEnter.current) clearTimeout(pendingEnter.current)
    },
    []
  )
  // Images pasted into the CLI's own input wait there for the prompt, so it must be typed too.
  const [attachedImages, setAttachedImages] = useState(0)
  useEffect(() => setAttachedImages(0), [sessionId])
  const sendAgentPrompt = (text: string): void => {
    const inbox = conversation?.promptInbox === true && attachedImages === 0
    setAttachedImages(0)
    // Through the agent's own channel when it has one, so the prompt is the person's own words.
    if (promptRoute(text, inbox) === 'inbox') {
      void window.api.usage.sendPrompt(sessionId, text).then((sent) => {
        if (!sent) typeAgentPrompt(text)
      })
      return
    }
    typeAgentPrompt(text)
  }
  /** Types a prompt into the CLI's own input, for a CLI without a channel or when it refused. */
  const typeAgentPrompt = (text: string): void => {
    const { paste, enter } = agentPrompt(text)
    if (pendingEnter.current) clearTimeout(pendingEnter.current)
    write(paste)
    pendingEnter.current = setTimeout(() => {
      pendingEnter.current = null
      window.api.terminal.write(sessionId, enter)
    }, AGENT_ENTER_DELAY_MS)
  }
  const commandSent = useRef<{ at: string; messages: number } | null>(null)
  useEffect(() => {
    const sent = commandSent.current
    if (!sent || !conversation || conversation.at === sent.at) return
    if (conversation.working || conversation.messages.length !== sent.messages) {
      commandSent.current = null
      setTuiFor(null)
    }
  }, [conversation])
  const agentReady = Boolean(running && adapter && conversation)
  const agentMode = agentReady && tuiFor !== running?.id
  const agentBlockList = useMemo(
    () => (conversation && adapter ? agentBlocks(conversation, sessionId, adapter, provider) : []),
    [conversation, adapter, sessionId, provider]
  )
  const approval = useMemo(
    () => approvalRequest(conversation, adapter, agentWaiting ?? null),
    [conversation, adapter, agentWaiting]
  )
  /** Keys go to Styr's input rather than straight to the PTY. */
  const typing = prompting || agentMode
  const grid = list ? (takeover && !agentMode ? state : null) : state
  // Rows with their links split out; rows are cached by identity, so this is cheap per frame.
  const gridLines = grid?.lines
  const gridCols = grid?.cols ?? 0
  const linkedGrid = useMemo(
    () => (gridLines ? linkRows(gridLines, gridCols) : []),
    [gridLines, gridCols]
  )
  const gridRef = useRef(grid)
  gridRef.current = grid
  const linkedRef = useRef(linkedGrid)
  linkedRef.current = linkedGrid

  // The grid's own selection, in buffer lines, so it can reach into the scrollback.
  const [selection, setSelection] = useState<GridSelection | null>(null)
  const selectionRef = useRef(selection)
  selectionRef.current = selection
  const hasGridSelection = (): boolean =>
    selectionRef.current !== null && !isEmptySelection(selectionRef.current)
  const clearSelection = (): void => {
    if (!selectionRef.current) return
    selectionRef.current = null
    setSelection(null)
    onSelectionRef.current?.(null)
  }
  // A new width reflows the buffer, so the selected lines are no longer where they were.
  useEffect(() => clearSelection(), [gridCols])
  /** The selection's text, read from the engine's buffer so it reaches past the screen. */
  const gridSelectionText = async (picked: GridSelection): Promise<string> => {
    const { start, end } = orderedRange(picked)
    const lines = await window.api.terminal.native.styledLines(sessionId, start.line, end.line + 1)
    return selectionText(picked, lines, gridRef.current?.cols ?? 0)
  }

  // Typing goes to Styr's input at a prompt and straight to the PTY while a command runs; the
  // input comes and goes with the prompt, so focus follows it.
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

  const wheelRemainder = useRef(0)
  const onWheel = (event: WheelEvent<HTMLDivElement>): void => {
    // The block list and the agent view scroll as a page.
    if (list && (!takeover || agentMode)) return
    const lines = (event.deltaY + wheelRemainder.current) / cell.height
    const whole = Math.trunc(lines)
    wheelRemainder.current = (lines - whole) * cell.height
    if (whole === 0) return
    if (state && reportsMouse(state.modes, event.shiftKey)) {
      const report: MouseReport = {
        kind: 'press',
        button: whole < 0 ? 'wheelUp' : 'wheelDown',
        ...pointerCell(event),
        shiftKey: false,
        altKey: event.altKey,
        ctrlKey: event.ctrlKey
      }
      const sequence = encodeMouse(report, state.modes)
      if (sequence) window.api.terminal.write(sessionId, sequence.repeat(Math.abs(whole)))
      return
    }
    if (state?.altScreen) {
      // Without mouse reporting, a full-screen program scrolls with the arrow keys (as in xterm.js).
      const key = whole < 0 ? 'ArrowUp' : 'ArrowDown'
      const sequence = encodeKey(
        { key, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false },
        { modes: { appCursor: state.modes.appCursor }, altIsMeta: false }
      )
      if (sequence) window.api.terminal.write(sessionId, sequence.repeat(Math.abs(whole)))
      return
    }
    window.api.terminal.native.scroll(sessionId, -whole)
  }

  const hovered = useRef<number | null>(null)
  const hover = (line: number | null): void => {
    if (line === hovered.current) return
    hovered.current = line
    onHoverRef.current?.(line)
  }
  const focusGrid = (): void => (imeRef.current ?? host.current)?.focus()

  /** The grid cell under the pointer, kept on the screen. */
  const pointerCell = (event: {
    clientX: number
    clientY: number
  }): { col: number; row: number } => {
    const box = host.current?.getBoundingClientRect()
    const screen = gridRef.current
    if (!box || !screen) return { col: 0, row: 0 }
    return cellAt(event.clientX - box.left, event.clientY - box.top, cellRef.current, screen)
  }

  /** The web link in a grid cell, if there is one. */
  const linkAt = (point: { col: number; row: number }): string | undefined => {
    const row = linkedRef.current[point.row]
    const link = row ? rowCells(row)[point.col]?.link : undefined
    return isOpenableLink(link) ? link : undefined
  }

  const sendMouse = (report: MouseReport): void => {
    const modes = gridRef.current?.modes
    const sequence = modes ? encodeMouse(report, modes) : null
    if (sequence) window.api.terminal.write(sessionId, sequence)
  }

  // A press in the grid is followed to its release wherever the pointer goes.
  const stopDrag = useRef<(() => void) | null>(null)
  useEffect(() => () => stopDrag.current?.(), [])
  const follow = (
    move: (event: globalThis.MouseEvent) => void,
    up: (event: globalThis.MouseEvent) => void
  ): void => {
    stopDrag.current?.()
    const onUp = (event: globalThis.MouseEvent): void => {
      stop()
      up(event)
    }
    const stop = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', onUp)
      stopDrag.current = null
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', onUp)
    stopDrag.current = stop
  }

  const onMouseDown = (event: MouseEvent<HTMLDivElement>): void => {
    const screen = gridRef.current
    if (!screen || !host.current) return
    const point = pointerCell(event)
    const link = linkAt(point)
    // ⌘-click (Ctrl elsewhere) opens a link even while the program takes the mouse.
    const primary = usesControlAsPrimary() ? event.ctrlKey : event.metaKey
    const button = mouseButton(event.button)
    const modifiers = { shiftKey: false, altKey: event.altKey, ctrlKey: event.ctrlKey }

    if (button && reportsMouse(screen.modes, event.shiftKey) && !(primary && link)) {
      event.preventDefault()
      focusGrid()
      clearSelection()
      sendMouse({ kind: 'press', button, ...point, ...modifiers })
      let last = point
      follow(
        (move) => {
          const next = pointerCell(move)
          if (next.col === last.col && next.row === last.row) return
          last = next
          sendMouse({ kind: 'move', button, ...next, ...modifiers })
        },
        (up) => sendMouse({ kind: 'release', button, ...pointerCell(up), ...modifiers })
      )
      return
    }
    if (event.button !== 0) return
    event.preventDefault()
    focusGrid()
    const at = { line: viewportTop(screen) + point.row, col: point.col }
    const unit = event.detail >= 3 ? 'line' : event.detail === 2 ? 'word' : 'cell'
    const extend = event.shiftKey && selectionRef.current
    const started: GridSelection = {
      anchor: extend ? selectionRef.current!.anchor : at,
      head: at,
      unit: extend ? selectionRef.current!.unit : unit
    }
    selectionRef.current = started
    setSelection(started)
    onSelectionRef.current?.(null)
    follow(
      (move) => {
        const current = selectionRef.current
        const box = host.current?.getBoundingClientRect()
        const live = gridRef.current
        if (!current || !box || !live) return
        // Past the top or bottom edge the view scrolls, so a selection can reach into history.
        if (move.clientY < box.top) window.api.terminal.native.scroll(sessionId, 1)
        else if (move.clientY > box.bottom) window.api.terminal.native.scroll(sessionId, -1)
        const next = pointerCell(move)
        const head = { line: viewportTop(live) + next.row, col: next.col }
        if (head.line === current.head.line && head.col === current.head.col) return
        const moved = { ...current, head }
        selectionRef.current = moved
        setSelection(moved)
      },
      (up) => {
        const current = selectionRef.current
        if (!current || isEmptySelection(current)) {
          clearSelection()
          // A click, not a drag: the explicit gesture that opens a link.
          if (link && !extend) void window.api.terminal.openLink(link)
          return
        }
        const box = host.current?.getBoundingClientRect()
        void gridSelectionText(current).then((text) => {
          if (selectionRef.current !== current || !text.trim() || !box) return
          onSelectionRef.current?.({ text, x: up.clientX - box.left, y: up.clientY - box.top })
        })
      }
    )
  }

  const hoverCell = useRef<{ col: number; row: number } | null>(null)
  const onMouseMove = (event: MouseEvent<HTMLDivElement>): void => {
    if (!state || !host.current || list) return
    const offset = event.clientY - host.current.getBoundingClientRect().top
    hover(lineAtOffset(state, offset, cell.height))
    // Any-motion tracking (1003) wants the pointer even with no button down.
    if (state.modes.mouse === 'motion' && !stopDrag.current && !event.shiftKey) {
      const point = pointerCell(event)
      const last = hoverCell.current
      if (last && last.col === point.col && last.row === point.row) return
      hoverCell.current = point
      const button: MouseButton = 'none'
      sendMouse({ kind: 'move', button, ...point, shiftKey: false, altKey: false, ctrlKey: false })
    }
  }

  const onMouseUp = (event: MouseEvent<HTMLDivElement>): void => {
    // The grid follows its own presses (`onMouseDown`).
    if (grid) return
    const text = selectedText()
    if (!text.trim() || !host.current) {
      onSelectionRef.current?.(null)
      // A click in the list (not on one of its controls) goes back to typing.
      const target = event.target as HTMLElement
      if (typing && !target.closest('button, [role="menu"], textarea')) inputRef.current?.focus()
      return
    }
    const box = host.current.getBoundingClientRect()
    onSelectionRef.current?.({ text, x: event.clientX - box.left, y: event.clientY - box.top })
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
      const text = paths.map((path) => syntaxRef.current.quote(path)).join(' ') + ' '
      if (typing) return insertIntoInput(text)
      write(pasteSequence(text, state?.modes.bracketedPaste ?? false))
    }
    host.current?.focus()
  }

  const font: CSSProperties = {
    fontFamily: theme.terminalFont,
    fontSize: theme.terminalFontSize,
    lineHeight: `${cell.height}px`
  }

  return (
    <div
      ref={host}
      hidden={!active}
      tabIndex={0}
      role="log"
      aria-label="Terminal"
      data-terminal-engine="native"
      className="styr-native-terminal relative h-full w-full overflow-hidden whitespace-pre outline-none select-text"
      // The app's focus ring is an unlayered rule; a terminal shows focus by its cursor instead.
      style={{
        ...font,
        color: palette.foreground,
        backgroundColor: palette.background,
        outline: 'none'
      }}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
      onCopy={onCopy}
      onWheel={onWheel}
      onMouseDown={onMouseDown}
      onMouseUp={onMouseUp}
      onMouseMove={onMouseMove}
      onMouseLeave={() => {
        hover(null)
        hoverCell.current = null
      }}
      onFocus={(event) => {
        // Keys go to the grid's hidden input, so an input method can compose.
        if (event.target === host.current && imeRef.current) imeRef.current.focus()
        if (leftTerminal(event.relatedTarget)) focusReport(true)
      }}
      onBlur={(event) => {
        if (leftTerminal(event.relatedTarget)) focusReport(false)
      }}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <span ref={probe} aria-hidden className="invisible absolute" style={font}>
        WWWWWWWWWW
      </span>
      {agentMode && provider ? (
        <AgentBlockList
          blocks={agentBlockList}
          working={conversation?.working ?? false}
          label={AGENT_PROVIDER_LABELS[provider]}
          approval={approval}
          look={look}
          font={font}
          inputRef={inputRef}
          history={conversation && adapter ? promptHistory(conversation, adapter) : []}
          commands={conversation?.commands}
          attachedImages={attachedImages}
          onSubmit={(text) => {
            sendAgentPrompt(text)
            // A command may answer in the CLI's own interface (a picker, a dialog), which only its
            // view draws: show it, and come back once the conversation moves on.
            if (isSlashCommand(text) && running && conversation) {
              commandSent.current = { at: conversation.at, messages: conversation.messages.length }
              setTuiFor(running.id)
            }
          }}
          onInterrupt={() => window.api.terminal.write(sessionId, '\x1b')}
          onAnswer={(option) => {
            if (conversation?.approval)
              // Already answered in the CLI's own view when this fails: nothing left to do.
              window.api.usage
                .approval(sessionId, conversation.approval.id, option.id)
                .catch(() => {})
            // The TUI's dialog: Enter takes its default (allow once), Escape refuses.
            else window.api.terminal.write(sessionId, option.kind === 'deny' ? '\x1b' : '\r')
          }}
          onPasteImage={
            adapter?.pasteImageKey
              ? () => {
                  write(adapter.pasteImageKey!)
                  setAttachedImages((count) => count + 1)
                }
              : undefined
          }
          onShowTui={() => setTuiFor(running?.id ?? null)}
        />
      ) : null}
      {agentReady && !agentMode && provider ? (
        <button
          type="button"
          className="bg-raised text-dim border-edge-strong hover:text-ink absolute top-2 right-3 z-10 rounded-md border px-2 py-0.5 font-sans text-[11.5px]"
          onClick={() => setTuiFor(null)}
        >
          Styr view
        </button>
      ) : null}
      {list && !takeover && !agentMode ? (
        <TerminalBlockList
          state={list}
          look={look}
          font={font}
          inputRef={inputRef}
          hints={commandHints}
          canRetry={canRetry}
          actions={blockActions}
          onSubmit={write}
          onClearBlocks={() => window.api.terminal.native.clearBlocks(sessionId)}
        />
      ) : null}
      {grid && selection
        ? selectionSpans(selection, viewportTop(grid), grid.rows, grid.cols, grid.lines).map(
            (span) => (
              <div
                key={span.row}
                aria-hidden
                className="pointer-events-none absolute"
                style={{
                  top: span.row * cell.height,
                  left: span.from * cell.width,
                  width: (span.to - span.from) * cell.width,
                  height: cell.height,
                  background: palette.selection
                }}
              />
            )
          )
        : null}
      {linkedGrid.map((line) => (
        <Row key={line.row} line={line} cell={cell} palette={palette} />
      ))}
      {grid ? (
        <textarea
          ref={imeRef}
          aria-label="Terminal input"
          tabIndex={-1}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          className="pointer-events-none absolute resize-none overflow-hidden border-0 bg-transparent p-0 opacity-0"
          // At the cursor, so an input method's candidate window opens beside it.
          style={{
            ...font,
            left: grid.cursor.col * cell.width,
            top: grid.cursor.row * cell.height,
            width: cell.width,
            height: cell.height,
            outline: 'none'
          }}
          onCompositionStart={() => setComposition('')}
          onCompositionUpdate={(event) => setComposition(event.data)}
          onCompositionEnd={onCompositionEnd}
          onInput={onImeInput}
        />
      ) : null}
      {grid && composition ? (
        <span
          aria-hidden
          className="pointer-events-none absolute z-10 underline"
          style={{
            left: grid.cursor.col * cell.width,
            top: grid.cursor.row * cell.height,
            height: cell.height,
            color: palette.foreground,
            background: palette.background
          }}
        >
          {composition}
        </span>
      ) : null}
      {grid?.cursor.visible ? (
        <div
          aria-hidden
          className="pointer-events-none absolute"
          style={cursorStyle(grid.cursor.shape, grid.cursor.row, grid.cursor.col, cell, palette)}
        />
      ) : null}
      {exitCode !== null ? (
        <div className="text-faint absolute right-2 bottom-1 text-xs">
          process exited with code {exitCode}
        </div>
      ) : null}
    </div>
  )
}

function Row({
  line,
  cell,
  palette
}: {
  line: EngineFrameLine
  cell: Cell
  palette: RunPalette
}): ReactNode {
  return (
    <div style={{ height: cell.height }}>
      {line.runs.map((run, index) => {
        const link = isOpenableLink(run.link) ? run.link : undefined
        return (
          <span
            key={index}
            className={`inline-block overflow-hidden align-top ${link ? 'cursor-pointer hover:underline' : ''}`}
            style={{ ...runStyle(run, palette), width: run.width * cell.width }}
            // An OSC 8 link's text need not say where it goes; the address is shown on hover.
            title={link}
          >
            {run.text}
          </span>
        )
      })}
    </div>
  )
}

function cursorStyle(
  shape: 'block' | 'underline' | 'bar',
  row: number,
  col: number,
  cell: Cell,
  palette: RunPalette
): CSSProperties {
  const base: CSSProperties = { left: col * cell.width, top: row * cell.height }
  if (shape === 'bar') return { ...base, width: 2, height: cell.height, background: palette.cursor }
  if (shape === 'underline') {
    return {
      ...base,
      top: (row + 1) * cell.height - 2,
      width: cell.width,
      height: 2,
      background: palette.cursor
    }
  }
  return {
    ...base,
    width: cell.width,
    height: cell.height,
    background: palette.cursor,
    opacity: 0.5
  }
}

/** The conversation of the agent CLI in a terminal, as its provider's source writes it. */
function useAgentConversation(sessionId: string): AgentConversation | null {
  const [conversation, setConversation] = useState<AgentConversation | null>(null)
  useEffect(() => {
    let live = true
    setConversation(null)
    void window.api.usage.conversation(sessionId).then((value) => {
      if (live && value) setConversation(value)
    })
    const off = window.api.usage.onConversation(({ terminalId, conversation: value }) => {
      if (terminalId === sessionId) setConversation(value)
    })
    return () => {
      live = false
      off()
    }
  }, [sessionId])
  return conversation
}

/**
 * What the view shows while the agent waits: the request its channel carries, with its options, or
 * else what Styr's agent status says, answered by keys in the TUI.
 */
function approvalRequest(
  conversation: AgentConversation | null,
  adapter: ConversationAdapter | undefined,
  waiting: string | null
): ApprovalRequest | null {
  const approval = conversation?.approval
  if (approval) {
    const described =
      approval.tool && adapter
        ? adapter.describeTool({
            id: approval.id,
            tool: approval.tool,
            input: approval.input ?? {}
          })
        : undefined
    return {
      prompt: approval.prompt,
      ...(approval.tool ? { tool: approval.tool } : {}),
      ...(described?.summary ? { summary: described.summary } : {}),
      ...(described?.edit ? { edit: described.edit } : {}),
      options: approvalOptions(approval),
      keys: false
    }
  }
  return waiting ? { prompt: waiting, options: DEFAULT_APPROVAL_OPTIONS, keys: true } : null
}
