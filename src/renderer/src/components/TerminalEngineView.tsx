import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react'
import type { NativeUnavailableReason, TerminalEngineId } from '@core/types.js'
import type { EngineSelection } from '@core/terminalEngine.js'
import { engineChoice } from '../lib/nativeTerminal/engineChoice.js'
import { NativeTerminalView } from './NativeTerminalView.js'
import { TerminalView } from './TerminalView.js'

const FALLBACK_LABEL: Record<NativeUnavailableReason, string> = {
  disabled: 'turned off',
  'unsupported-platform': 'not available on this platform',
  'missing-package': 'not included in this build',
  'incompatible-version': 'an incompatible version',
  'init-failed': 'failed to start',
  'runtime-error': 'stopped unexpectedly'
}

type Choice = TerminalEngineId | 'pending'

/**
 * Picks the engine for one terminal view and switches to xterm.js if the native engine fails. The
 * engine is chosen once, when the view mounts: changing the setting affects new terminals, never a
 * running one, since remounting would cost its scrollback. With the experiment off this renders
 * `TerminalView` straight away — the standard path does not wait on anything.
 */
export function TerminalEngineView({
  nativeTerminal,
  ...props
}: ComponentProps<typeof TerminalView> & {
  /** `experimental.nativeTerminal` from Settings. */
  nativeTerminal: boolean
}): ReactNode {
  const { sessionId } = props
  const [engine, setEngine] = useState<Choice>(() =>
    engineChoice().wantsNative(nativeTerminal) ? 'pending' : 'xterm'
  )
  const [notice, setNotice] = useState<string | null>(null)
  const initial = useRef({ engine, nativeTerminal })

  useEffect(() => {
    const report = (selection: EngineSelection): void =>
      window.api.terminal.reportEngine({ sessionId, ...selection })
    if (initial.current.engine === 'xterm') {
      report({ requested: 'xterm', selected: 'xterm' })
      return
    }
    let cancelled = false
    void engineChoice()
      .select(initial.current.nativeTerminal)
      .then((selection) => {
        if (cancelled) return
        report(selection)
        setEngine(selection.selected)
        if (selection.fallbackReason) setNotice(noticeFor(selection.fallbackReason))
      })
    return () => {
      cancelled = true
    }
  }, [sessionId])

  const fallBack = (reason: NativeUnavailableReason, detail: string): void => {
    window.api.terminal.reportEngine({
      sessionId,
      requested: 'native',
      selected: 'xterm',
      fallbackReason: reason,
      detail
    })
    setNotice(noticeFor(reason))
    setEngine('xterm')
  }

  return (
    <div className="relative h-full w-full">
      {engine === 'native' ? (
        <NativeTerminalView
          sessionId={props.sessionId}
          dialect={props.dialect}
          active={props.active}
          theme={props.theme}
          bindings={props.bindings}
          handle={props.handle}
          onSelection={props.onSelection}
          onFullscreenChange={props.onFullscreenChange}
          onFallback={fallBack}
        />
      ) : engine === 'xterm' ? (
        <TerminalView {...props} />
      ) : (
        <div className="h-full w-full" hidden={!props.active} />
      )}
      {notice && props.active ? (
        <div
          role="status"
          className="bg-raised text-dim border-edge absolute top-1 right-1 z-10 flex items-center gap-2 rounded border px-2 py-1 text-xs"
        >
          <span>{notice}</span>
          <button className="text-faint hover:text-ink" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </div>
      ) : null}
    </div>
  )
}

function noticeFor(reason: NativeUnavailableReason): string {
  return `Styr Terminal ${FALLBACK_LABEL[reason]} — using the standard terminal.`
}
