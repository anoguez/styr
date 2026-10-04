import { useEffect, useMemo, useRef, type MutableRefObject, type ReactNode } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import type { ShortcutBindings, ThemeSettings } from '@core/types.js'
import { terminalTheme } from '../lib/palette.js'
import { isAppShortcut, multilineSequence } from '../lib/terminalKeys.js'
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
  focus: () => void
}

export function TerminalView({
  sessionId,
  active,
  theme,
  bindings,
  handle,
  onSelection,
  onFullscreenChange
}: {
  sessionId: string
  active: boolean
  theme: ThemeSettings
  bindings: ShortcutBindings
  handle?: MutableRefObject<TerminalHandle | null>
  onSelection?: (selection: TerminalSelection | null) => void
  /** True while a full-screen program (alternate screen: vim, htop, an agent CLI) is showing. */
  onFullscreenChange?: (fullscreen: boolean) => void
}): ReactNode {
  const xtermTheme = useMemo(() => terminalTheme(theme), [theme])
  const host = useRef<HTMLDivElement>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const bindingsRef = useRef(bindings)
  bindingsRef.current = bindings
  const onSelectionRef = useRef(onSelection)
  onSelectionRef.current = onSelection
  const onFullscreenRef = useRef(onFullscreenChange)
  onFullscreenRef.current = onFullscreenChange

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
    terminal.loadAddon(new WebLinksAddon())
    terminal.open(element)

    terminal.attachCustomKeyEventHandler((event) => {
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

    const output = new TerminalOutputSynchronizer((data) => terminal.write(data))
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
    if (handle) {
      handle.current = {
        focus: () => terminal.focus(),
        text: () => {
          const buffer = terminal.buffer.active
          const lines: string[] = []
          for (let row = 0; row < buffer.length; row++) {
            const line = buffer.getLine(row)
            if (!line) continue
            const text = line.translateToString(true)
            // A wrapped row continues the previous one, so rejoin rather than split a long line.
            if (line.isWrapped && lines.length > 0) lines[lines.length - 1] += text
            else lines.push(text)
          }
          return lines.join('\n').trimEnd()
        }
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
    const offSelection = terminal.onSelectionChange(() => {
      if (!terminal.hasSelection()) onSelectionRef.current?.(null)
    })
    const input = terminal.onData((data) => window.api.terminal.write(sessionId, data))
    const observer = new ResizeObserver(pushSize)
    observer.observe(element)

    return () => {
      offData()
      offExit()
      offBuffer.dispose()
      offSelection.dispose()
      element.removeEventListener('mouseup', reportSelection)
      if (handle) handle.current = null
      onFullscreenRef.current?.(false)
      input.dispose()
      observer.disconnect()
      terminal.dispose()
      fitRef.current = null
      terminalRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  useEffect(() => {
    if (active) requestAnimationFrame(() => fitRef.current?.fit())
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
