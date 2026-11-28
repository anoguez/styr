import { useMemo, useRef, type CSSProperties, type MutableRefObject, type ReactNode } from 'react'
import type { NativeUnavailableReason, ShortcutBindings, ThemeSettings } from '@core/types.js'
import { AGENT_PROVIDER_LABELS } from '@core/types.js'
import { syntaxFor, type ShellDialect } from '@core/shell.js'
import type { AgentProviderId } from '@core/providers/types.js'
import { linkRows } from '../lib/nativeTerminal/links.js'
import { useNativeEngine } from '../lib/nativeTerminal/useNativeEngine.js'
import { useAgentSession } from '../lib/nativeTerminal/useAgentSession.js'
import { useGridSelection } from '../lib/nativeTerminal/useGridSelection.js'
import { useGridInput } from '../lib/nativeTerminal/useGridInput.js'
import { useGridPointer } from '../lib/nativeTerminal/useGridPointer.js'
import { TerminalBlockList, type InputHint } from './TerminalBlockList.js'
import { AgentBlockList } from './AgentBlockList.js'
import { BackToChat } from './AgentChatView.js'
import { NativeGridLayer } from './NativeGridLayer.js'
import type { BlockActions } from './TerminalBlocks.js'
import type { BlockLayout, TerminalHandle, TerminalSelection } from './TerminalView.js'

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
  chat = false,
  onChatChange,
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
  /** The tab's Chat switch: draw a running agent as a chat (`AgentBlockList`) rather than its TUI. */
  chat?: boolean
  /** The chat asked for the CLI's own interface (off) — "<agent> view", "Answer in <agent>". */
  onChatChange?: (on: boolean) => void
  onFallback: (reason: NativeUnavailableReason, detail: string) => void
}): ReactNode {
  const host = useRef<HTMLDivElement>(null)
  const probe = useRef<HTMLSpanElement>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  /** The grid's hidden input: keys and input methods (IME) type into it, never into the page. */
  const imeRef = useRef<HTMLTextAreaElement | null>(null)
  const bindingsRef = useRef(bindings)
  bindingsRef.current = bindings
  const syntaxRef = useRef(syntaxFor(dialect))
  syntaxRef.current = syntaxFor(dialect)
  const onSelectionRef = useRef(onSelection)
  onSelectionRef.current = onSelection
  const onHoverRef = useRef(onHoverLine)
  onHoverRef.current = onHoverLine

  const { model, listRef, cell, cellRef, exitCode, palette, look, write } = useNativeEngine({
    sessionId,
    theme,
    host,
    probe,
    inputRef,
    imeRef,
    handle,
    onFullscreenChange,
    onBlocks,
    onBlockListChange,
    onFallback
  })

  const list = listRef.current?.state ?? null
  // A full-screen program in the block list gets the whole panel as a grid.
  const takeover = Boolean(list?.active.kind === 'running' && list.screen.current?.altScreen)
  const prompting = list !== null && list.active.kind === 'prompt'
  /** The screen the program is drawing, whose modes decide how keys are sent. */
  const state = list ? list.screen.current : (model.current?.current ?? null)

  const agent = useAgentSession({ sessionId, list, agentProvider, agentWaiting, chat, write })
  const { agentMode, provider } = agent
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

  const {
    selection,
    setSelection,
    selectionRef,
    hasGridSelection,
    clearSelection,
    gridSelectionText
  } = useGridSelection({ sessionId, gridRef, gridCols, onSelectionRef })

  const input = useGridInput({
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
  })

  const pointer = useGridPointer({
    sessionId,
    host,
    inputRef,
    imeRef,
    list,
    takeover,
    agentMode,
    typing,
    grid,
    state,
    cell,
    cellRef,
    gridRef,
    linkedRef,
    selectionRef,
    setSelection,
    clearSelection,
    gridSelectionText,
    selectedText: input.selectedText,
    onSelectionRef,
    onHoverRef
  })

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
      onKeyDown={input.onKeyDown}
      onPaste={input.onPaste}
      onCopy={input.onCopy}
      onWheel={pointer.onWheel}
      onMouseDown={pointer.onMouseDown}
      onMouseUp={pointer.onMouseUp}
      onMouseMove={pointer.onMouseMove}
      onMouseLeave={pointer.onMouseLeave}
      onFocus={(event) => {
        // Keys go to the grid's hidden input, so an input method can compose.
        if (event.target === host.current && imeRef.current) imeRef.current.focus()
        if (input.leftTerminal(event.relatedTarget)) input.focusReport(true)
      }}
      onBlur={(event) => {
        if (input.leftTerminal(event.relatedTarget)) input.focusReport(false)
      }}
      onDragOver={input.onDragOver}
      onDrop={input.onDrop}
    >
      <span ref={probe} aria-hidden className="invisible absolute" style={font}>
        WWWWWWWWWW
      </span>
      {agentMode && provider ? (
        <AgentBlockList
          blocks={agent.blocks}
          working={agent.working}
          label={AGENT_PROVIDER_LABELS[provider]}
          approval={agent.approval}
          inputRef={inputRef}
          history={agent.history}
          commands={agent.conversation?.commands}
          attachedImages={agent.attachedImages}
          onSubmit={agent.onSubmit}
          onInterrupt={agent.onInterrupt}
          onAnswer={agent.onAnswer}
          onPasteImage={agent.onPasteImage}
          onShowTui={() => (onChatChange ? onChatChange(false) : agent.showTui())}
        />
      ) : null}
      {agent.ready && chat && agent.tuiRequested ? <BackToChat onClick={agent.showChat} /> : null}
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
      <NativeGridLayer
        grid={grid}
        linkedGrid={linkedGrid}
        selection={selection}
        cell={cell}
        palette={palette}
        font={font}
        composition={input.composition}
        imeRef={imeRef}
        imeHandlers={input.imeHandlers}
        exitCode={exitCode}
      />
    </div>
  )
}
