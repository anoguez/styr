import { useEffect, useMemo, useRef, type MutableRefObject, type ReactNode } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import type { ShortcutBindings, ThemeSettings } from '@core/types.js'
import { terminalTheme } from '../lib/palette.js'
import { clipboardKey, isAppShortcut, multilineSequence } from '../lib/terminalKeys.js'
import { BlockTracker, type BlockLayout } from '../lib/blockTracker.js'
import { syntaxFor, type ShellDialect } from '@core/shell.js'
import { TerminalOutputSynchronizer } from '../lib/terminalOutput.js'

export interface TerminalSelection {
  text: string
  /** Where the selection ended, relative to the terminal's own box. */
  x: number
  y: number
}

/** What the surface may ask of xterm without owning it. */
export interface TerminalHandle {
  /** The whole scrollback and screen as plain text. */
  text: () => string
  /** Buffer lines `from` (inclusive) to `to` (exclusive) as plain text. */
  lines: (from: number, to: number) => string
  focus: () => void
}

export type { BlockLayout }

export function TerminalView({
  sessionId,
  dialect,
  active,
  theme,
  bindings,
  handle,
  onSelection,
  onFullscreenChange,
  onBlocks,
  onHoverLine
}: {
  sessionId: string
  /** What the session's shell speaks, for quoting dropped paths. */
  dialect?: ShellDialect
  active: boolean
  theme: ThemeSettings
  bindings: ShortcutBindings
  handle?: MutableRefObject<TerminalHandle | null>
  onSelection?: (selection: TerminalSelection | null) => void
  /** True while a full-screen program (alternate screen: vim, htop, an agent CLI) is showing. */
  onFullscreenChange?: (fullscreen: boolean) => void
  /** Where the shell's commands sit in the buffer; reported as output arrives and as it scrolls. */
  onBlocks?: (layout: BlockLayout) => void
  /** The buffer line under the pointer, or null when it is outside the terminal. */
  onHoverLine?: (line: number | null) => void
}): ReactNode {
  const xtermTheme = useMemo(() => terminalTheme(theme), [theme])
  const host = useRef<HTMLDivElement>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const bindingsRef = useRef(bindings)
  bindingsRef.current = bindings
  // Read from the drop handler, which is bound once with the terminal (it is never remounted).
  const syntaxRef = useRef(syntaxFor(dialect))
  syntaxRef.current = syntaxFor(dialect)
  const onSelectionRef = useRef(onSelection)
  onSelectionRef.current = onSelection
  const onFullscreenRef = useRef(onFullscreenChange)
  onFullscreenRef.current = onFullscreenChange
  const onBlocksRef = useRef(onBlocks)
  onBlocksRef.current = onBlocks
  const onHoverRef = useRef(onHoverLine)
  onHoverRef.current = onHoverLine

  useEffect(() => {
    const element = host.current
    if (!element) return

    const terminal = new Terminal({
      fontFamily: theme.terminalFont,
      fontSize: theme.terminalFontSize,
      lineHeight: 1.25,
      cursorBlink: true,
      allowProposedApi: true,
      theme: xtermTheme
    })
    const fit = new FitAddon()
    fitRef.current = fit
    terminalRef.current = terminal
    terminal.loadAddon(fit)
    terminal.loadAddon(
      new WebLinksAddon((event, uri) => {
        // The addon's default opens about:blank and then navigates it, which the main process's
        // window-open handler sends to the browser as "about:blank". Ask for the real URL instead.
        if (event.button === 0) void window.api.terminal.openLink(uri)
      })
    )
    terminal.open(element)

    terminal.attachCustomKeyEventHandler((event) => {
      const clipboard = clipboardKey(event, terminal.hasSelection())
      if (clipboard === 'copy') {
        event.preventDefault()
        void navigator.clipboard.writeText(terminal.getSelection())
        terminal.clearSelection()
        return false
      }
      // Left to the browser, whose paste event xterm turns into a (bracketed) paste.
      if (clipboard === 'paste') return false
      const sequence = multilineSequence(event)
      if (sequence !== null) {
        event.preventDefault()
        window.api.terminal.write(sessionId, sequence)
        return false
      }
      return !isAppShortcut(event, bindingsRef.current)
    })

    const pushSize = (): void => {
      try {
        fit.fit()
      } catch {
        return
      }
      window.api.terminal.resize(sessionId, terminal.cols, terminal.rows)
    }

    const tracker = new BlockTracker(terminal, element, (layout) => onBlocksRef.current?.(layout))
    const output = new TerminalOutputSynchronizer({
      write: (data) => {
        if (data) terminal.write(data)
      },
      // An empty write is queued behind the data before it, so its callback runs exactly when the
      // cursor is where the shell was when it sent the mark.
      mark: (mark) => terminal.write('', () => tracker.mark(mark))
    })
    const offData = window.api.terminal.onData(({ id, ...event }) => {
      if (id === sessionId) output.writeLive(event)
    })
    void window.api.terminal.backlog(sessionId).then((backlog) => {
      output.writeBacklog(backlog)
      pushSize()
    })
    const offExit = window.api.terminal.onExit(({ id, exitCode }) => {
      if (id === sessionId)
        terminal.write(`\r\n\x1b[90m[process exited with code ${exitCode}]\x1b[0m\r\n`)
    })
    const rangeText = (from: number, to: number): string => {
      const buffer = terminal.buffer.active
      const lines: string[] = []
      for (let row = Math.max(0, from); row < Math.min(to, buffer.length); row++) {
        const line = buffer.getLine(row)
        if (!line) continue
        const text = line.translateToString(true)
        // A wrapped row continues the previous one, so rejoin rather than split a long line.
        if (line.isWrapped && lines.length > 0) lines[lines.length - 1] += text
        else lines.push(text)
      }
      return lines.join('\n').trimEnd()
    }
    if (handle) {
      handle.current = {
        focus: () => terminal.focus(),
        lines: (from, to) => rangeText(from, to),
        text: () => rangeText(0, terminal.buffer.active.length)
      }
    }
    const reportScreen = (): void =>
      onFullscreenRef.current?.(terminal.buffer.active.type === 'alternate')
    const offBuffer = terminal.buffer.onBufferChange(reportScreen)
    const reportSelection = (event: MouseEvent): void => {
      const text = terminal.getSelection()
      if (!text.trim()) return
      const box = element.getBoundingClientRect()
      onSelectionRef.current?.({ text, x: event.clientX - box.left, y: event.clientY - box.top })
    }
    element.addEventListener('mouseup', reportSelection)
    let hovered: number | null = null
    const hover = (event: MouseEvent): void => {
      const line = tracker.lineAt(event.clientY)
      if (line === hovered) return
      hovered = line
      onHoverRef.current?.(line)
    }
    const leave = (): void => {
      hovered = null
      onHoverRef.current?.(null)
    }
    element.addEventListener('mousemove', hover)
    element.addEventListener('mouseleave', leave)
    const offSelection = terminal.onSelectionChange(() => {
      if (!terminal.hasSelection()) onSelectionRef.current?.(null)
    })
    const allowDrop = (event: DragEvent): void => {
      if (!event.dataTransfer?.types.includes('Files')) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
    }
    const drop = (event: DragEvent): void => {
      const files = Array.from(event.dataTransfer?.files ?? [])
      if (files.length === 0) return
      event.preventDefault()
      const paths = window.api.terminal.pathsForFiles(files)
      // paste() applies bracketed paste, so an agent CLI reads the paths as pasted text
      // (Claude Code turns a pasted image path into an attachment).
      if (paths.length > 0) {
        terminal.paste(paths.map((p) => syntaxRef.current.quote(p)).join(' ') + ' ')
      }
      terminal.focus()
    }
    element.addEventListener('dragover', allowDrop)
    element.addEventListener('drop', drop)
    const input = terminal.onData((data) => window.api.terminal.write(sessionId, data))
    const observer = new ResizeObserver(pushSize)
    observer.observe(element)

    return () => {
      offData()
      offExit()
      offBuffer.dispose()
      offSelection.dispose()
      element.removeEventListener('mouseup', reportSelection)
      element.removeEventListener('mousemove', hover)
      element.removeEventListener('mouseleave', leave)
      element.removeEventListener('dragover', allowDrop)
      element.removeEventListener('drop', drop)
      if (handle) handle.current = null
      onFullscreenRef.current?.(false)
      tracker.dispose()
      input.dispose()
      observer.disconnect()
      terminal.dispose()
      fitRef.current = null
      terminalRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  useEffect(() => {
    if (!active) return
    // The host is `hidden` until now, so xterm can only take focus once it is shown. Switching
    // tabs should leave the user typing, not clicking into the terminal first.
    const frame = requestAnimationFrame(() => {
      fitRef.current?.fit()
      terminalRef.current?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [active])

  useEffect(() => {
    const terminal = terminalRef.current
    if (!terminal) return
    terminal.options.fontFamily = theme.terminalFont
    terminal.options.fontSize = theme.terminalFontSize
    terminal.options.theme = xtermTheme
    requestAnimationFrame(() => fitRef.current?.fit())
  }, [theme.terminalFont, theme.terminalFontSize, xtermTheme])

  return <div ref={host} className="h-full w-full" hidden={!active} />
}
