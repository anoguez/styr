import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { spawn, type IPty } from 'node-pty'
import { nanoid } from 'nanoid'
import { withoutSessionMarkers } from '@core/providers/index.js'
import type {
  TerminalMark,
  TerminalOutput,
  TerminalRuntimeState,
  TerminalSessionInfo
} from '@core/types.js'
import { shellIntegrationEnvironment } from './shellIntegration.js'
import { TerminalProtocolParser } from './terminalProtocol.js'
import { TerminalRuntime } from './terminalRuntime.js'

export interface SpawnOptions {
  cwd?: string
  shell?: string
  title?: string
  taskId?: string
  workspaceId?: string
  provider?: 'claude' | 'codex'
  replay?: boolean
  command?: string
  env?: Record<string, string>
}

interface Session {
  info: TerminalSessionInfo
  pty: IPty
  backlog: string
  sequence: number
  /** Characters of output ever produced; `marks` offsets count from the start of this. */
  streamLength: number
  marks: TerminalMark[]
  parser: TerminalProtocolParser
  runtime: TerminalRuntime
}

type DataListener = (id: string, output: TerminalOutput) => void
type ExitListener = (id: string, exitCode: number) => void
type RuntimeListener = (state: TerminalRuntimeState) => void

const BACKLOG_LIMIT = 200_000
const sessions = new Map<string, Session>()
const exitedTaskIds = new Map<string, { taskId: string; workspaceId?: string }>()
const dataListeners = new Set<DataListener>()
const exitListeners = new Set<ExitListener>()
const runtimeListeners = new Set<RuntimeListener>()
const exitedRuntimeStates = new Map<string, TerminalRuntimeState>()

/** The command boundary a runtime event marks, if it marks one. */
function commandMark(
  type: string,
  before: TerminalRuntimeState,
  after: TerminalRuntimeState,
  offset: number
): TerminalMark | undefined {
  if (type === 'COMMAND_STARTED' && after.runningCommand) {
    const { id, command, startedAt } = after.runningCommand
    return { offset, kind: 'start', id, command, at: startedAt }
  }
  if (type === 'COMMAND_FINISHED' && before.runningCommand && after.lastCommand) {
    const { id, endedAt, exitCode } = after.lastCommand
    return { offset, kind: 'end', id, exitCode, at: endedAt ?? Date.now() }
  }
  return undefined
}

function resolveCwd(cwd?: string): string {
  return cwd && existsSync(cwd) ? cwd : homedir()
}

/**
 * The app's environment for a new terminal, minus agent session markers it may have inherited (see
 * `withoutSessionMarkers`), plus `extra`, which is applied last so it is never stripped.
 */
function sanitisedEnv(extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  // xterm.js renders 24-bit colour, but programs only use it when COLORTERM says so. Without it,
  // TUIs such as Codex quantise their colours to the 256-colour palette, which turns a background
  // blended from the theme into flat grey.
  return { ...withoutSessionMarkers(env), ...extra, TERM: 'xterm-256color', COLORTERM: 'truecolor' }
}

export function onTerminalData(listener: DataListener): void {
  dataListeners.add(listener)
}

export function onTerminalExit(listener: ExitListener): void {
  exitListeners.add(listener)
}

export function onTerminalRuntimeState(listener: RuntimeListener): void {
  runtimeListeners.add(listener)
}

export function createSession(options: SpawnOptions): TerminalSessionInfo {
  const id = nanoid(10)
  const cwd = resolveCwd(options.cwd)
  const shell = options.shell || process.env.SHELL || '/bin/zsh'
  const environment = sanitisedEnv(options.env)
  const child = spawn(shell, ['-l'], {
    name: 'xterm-256color',
    cols: 100,
    rows: 30,
    cwd,
    env: { ...environment, ...shellIntegrationEnvironment(shell, environment) }
  })

  const info: TerminalSessionInfo = {
    id,
    title: options.title ?? 'Terminal',
    cwd,
    ...(options.taskId ? { taskId: options.taskId } : {}),
    ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
    ...(options.provider ? { provider: options.provider } : {}),
    ...(options.replay ? { replay: true } : {})
  }
  const session: Session = {
    info,
    pty: child,
    backlog: '',
    sequence: 0,
    streamLength: 0,
    marks: [],
    parser: new TerminalProtocolParser(),
    runtime: new TerminalRuntime(id, cwd)
  }
  sessions.set(id, session)

  child.onData((data) => {
    const parsed = session.parser.parse(data)
    const chunkStart = session.streamLength
    const marks: TerminalMark[] = []
    let position = chunkStart
    for (const fragment of parsed.fragments) {
      if (fragment.kind === 'terminal') {
        session.runtime.appendOutput(fragment.data)
        position += fragment.data.length
      } else {
        const before = session.runtime.snapshot()
        session.runtime.apply(fragment.event)
        const after = session.runtime.snapshot()
        const mark = commandMark(fragment.event.type, before, after, position)
        if (mark) {
          session.marks.push(mark)
          marks.push({ ...mark, offset: mark.offset - chunkStart })
        }
        emitRuntimeState(after)
      }
    }
    session.streamLength = chunkStart + parsed.terminalData.length
    session.backlog = (session.backlog + parsed.terminalData).slice(-BACKLOG_LIMIT)
    const backlogStart = session.streamLength - session.backlog.length
    while (session.marks.length > 0 && session.marks[0]!.offset < backlogStart)
      session.marks.shift()
    session.sequence += 1
    const output: TerminalOutput = { data: parsed.terminalData, sequence: session.sequence, marks }
    for (const listener of dataListeners) listener(id, output)
  })
  child.onExit(({ exitCode }) => {
    session.runtime.terminate(exitCode)
    const runtimeState = session.runtime.snapshot()
    exitedRuntimeStates.set(id, runtimeState)
    emitRuntimeState(runtimeState)
    if (info.taskId) exitedTaskIds.set(id, { taskId: info.taskId, workspaceId: info.workspaceId })
    sessions.delete(id)
    for (const listener of exitListeners) listener(id, exitCode)
  })

  if (options.command) child.write(`${options.command}\r`)
  return info
}

export function writeToSession(id: string, data: string): void {
  sessions.get(id)?.pty.write(data)
}

export function resizeSession(id: string, cols: number, rows: number): void {
  sessions.get(id)?.pty.resize(Math.max(cols, 1), Math.max(rows, 1))
}

export function killSession(id: string): void {
  const session = sessions.get(id)
  if (!session) return
  session.pty.kill()
  sessions.delete(id)
}

export function sessionBacklog(id: string): TerminalOutput {
  const session = sessions.get(id)
  if (!session) return { data: '', sequence: 0, marks: [] }
  const start = session.streamLength - session.backlog.length
  return {
    data: session.backlog,
    sequence: session.sequence,
    marks: session.marks
      .filter((mark) => mark.offset >= start)
      .map((mark) => ({ ...mark, offset: mark.offset - start }))
  }
}

export function terminalRuntimeState(id: string): TerminalRuntimeState | undefined {
  return sessions.get(id)?.runtime.snapshot() ?? exitedRuntimeStates.get(id)
}

/** The task a session belongs to, with its workspace — ids repeat across workspaces. */
export function sessionTask(id: string): { taskId: string; workspaceId?: string } | undefined {
  const info = sessions.get(id)?.info
  return info?.taskId
    ? { taskId: info.taskId, workspaceId: info.workspaceId }
    : exitedTaskIds.get(id)
}

export function findSessionByTask(
  taskId: string,
  workspaceId?: string
): TerminalSessionInfo | undefined {
  return [...sessions.values()].find(
    (session) => session.info.taskId === taskId && session.info.workspaceId === workspaceId
  )?.info
}

export function listSessions(): TerminalSessionInfo[] {
  return [...sessions.values()].map((session) => session.info)
}

export function killAllSessions(): void {
  for (const id of [...sessions.keys()]) killSession(id)
}

function emitRuntimeState(state: TerminalRuntimeState): void {
  for (const listener of runtimeListeners) listener(state)
}
