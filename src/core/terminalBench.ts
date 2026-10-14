import type { TerminalEngineId, TerminalMark } from './types.js'

/**
 * Timing for the terminal engine comparison (`scripts/terminal-bench/README.md`). With
 * `STYR_TERMINAL_BENCH=1` in a dev build, each engine reports when a command's output has been
 * drawn, measured from the shell's own `start` mark. No timers: a record is made when the
 * engine has handled the command's `end` mark, nothing samples in between. Like the engine
 * diagnostics, a record carries no terminal contents — not even the command line.
 */

export interface TerminalBenchRecord {
  engine: TerminalEngineId
  sessionId: string
  /** Epoch ms of the shell's `start` and `end` marks, and when the engine had drawn the output. */
  startAt: number
  endAt: number
  drawnAt: number
  /** `drawnAt - startAt`: the whole command as the person saw it. */
  totalMs: number
  /** `drawnAt - endAt`: how far drawing trailed the shell. */
  lagMs: number
}

/** Pairs each command's `start` mark with its `end`, for one session. */
export class CommandTimer {
  private readonly starts = new Map<string, TerminalMark>()

  constructor(
    private readonly engine: TerminalEngineId,
    private readonly sessionId: string
  ) {}

  /** Notes a mark; returns it when it ends a command whose start was seen, for `finish`. */
  observe(mark: TerminalMark): TerminalMark | undefined {
    if (mark.kind === 'start') {
      this.starts.set(mark.id, mark)
      return undefined
    }
    return mark.kind === 'end' && this.starts.has(mark.id) ? mark : undefined
  }

  /** The record for an `end` mark from `observe`, once its output has been drawn at `drawnAt`. */
  finish(end: TerminalMark, drawnAt: number): TerminalBenchRecord | undefined {
    const start = this.starts.get(end.id)
    if (!start) return undefined
    this.starts.delete(end.id)
    return {
      engine: this.engine,
      sessionId: this.sessionId,
      startAt: start.at,
      endAt: end.at,
      drawnAt,
      totalMs: drawnAt - start.at,
      lagMs: drawnAt - end.at
    }
  }
}

/** CPU and memory per Electron process type over one command (`app.getAppMetrics()`). */
export type BenchProcesses = Record<string, { cpuPercent: number; memoryMb: number }>

/** One log line per record, prefixed so a run's output can be filtered with `grep`. */
export function formatBenchRecord(record: TerminalBenchRecord, processes?: BenchProcesses): string {
  return `[terminal-bench] ${JSON.stringify(processes ? { ...record, processes } : record)}`
}

/** Whether a renderer report is shaped like a record, before it is logged. */
export function isBenchRecord(value: unknown): value is TerminalBenchRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    (record.engine === 'xterm' || record.engine === 'native') &&
    typeof record.sessionId === 'string' &&
    ['startAt', 'endAt', 'drawnAt', 'totalMs', 'lagMs'].every(
      (key) => typeof record[key] === 'number' && Number.isFinite(record[key])
    )
  )
}
