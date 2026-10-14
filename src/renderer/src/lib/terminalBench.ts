import { CommandTimer } from '@core/terminalBench.js'
import type { TerminalEngineId, TerminalMark } from '@core/types.js'

/** Asked once per window: whether the main process was started with `STYR_TERMINAL_BENCH=1`. */
let enabled: Promise<boolean> | undefined

/**
 * Times commands in an xterm.js view for the engine comparison (`core/terminalBench.ts`). Call
 * `drawn` when the view has parsed a mark; an `end` is reported on the next paint. With the
 * benchmark off (always, in a packaged app) the timer is never made and `drawn` does nothing.
 */
export function benchTimer(
  engine: TerminalEngineId,
  sessionId: string
): {
  drawn: (mark: TerminalMark) => void
} {
  let timer: CommandTimer | undefined
  enabled ??= window.api.terminal.bench.enabled().catch(() => false)
  void enabled.then((on) => {
    if (on) timer = new CommandTimer(engine, sessionId)
  })
  return {
    drawn: (mark) => {
      const end = timer?.observe(mark)
      if (!end) return
      requestAnimationFrame(() => {
        const record = timer?.finish(end, Date.now())
        if (record) window.api.terminal.bench.report(record)
      })
    }
  }
}
