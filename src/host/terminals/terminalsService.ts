import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { nanoid } from 'nanoid'
import { resolveShell } from '@core/platformShell.js'
import { withoutSessionMarkers } from '@core/providers/index.js'
import type { TerminalOutput, TerminalRuntimeState, TerminalSessionInfo } from '@core/types.js'
import type { HostPorts } from '../ports.js'
import { shellIntegrationLaunch } from './shellIntegration.js'
import { TerminalTranscript } from './terminalTranscript.js'

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

/** The subset of node-pty's `IPty` a session uses. */
export interface PtyProcess {
  onData(listener: (data: string) => void): unknown
  onExit(listener: (event: { exitCode: number }) => void): unknown
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
}

export interface PtySpawnOptions {
  name: string
  cols: number
  rows: number
  cwd: string
  env: Record<string, string>
}

export interface TerminalsPorts {
  /** Starts a shell in a pseudo-terminal; `nodePty.ts` is the real one. */
  spawn(file: string, args: string[] | string, options: PtySpawnOptions): PtyProcess
  /**
   * Environment that points a Claude Code started in this terminal at Styr's usage mod (main's
   * `usageEnv`), given the plugin folders the app already has.
   */
  usageEnv(existing: string | undefined, terminalId: string): Record<string, string>
}

interface Session {
  info: TerminalSessionInfo
  pty: PtyProcess
  transcript: TerminalTranscript
}

type DataListener = (id: string, output: TerminalOutput) => void
type ExitListener = (id: string, exitCode: number) => void
type RuntimeListener = (state: TerminalRuntimeState) => void

function resolveCwd(cwd?: string): string {
  return cwd && existsSync(cwd) ? cwd : homedir()
}

/**
 * The terminal sessions: one PTY each, its transcript (backlog, command marks, runtime state) and
 * the listeners told about its output and exit. The PTY belongs here whatever engine draws it.
 */
export function createTerminalsService(ports: TerminalsPorts) {
  const sessions = new Map<string, Session>()
  const exitedTaskIds = new Map<string, { taskId: string; workspaceId?: string }>()
  const dataListeners = new Set<DataListener>()
  const exitListeners = new Set<ExitListener>()
  const runtimeListeners = new Set<RuntimeListener>()
  const exitedRuntimeStates = new Map<string, TerminalRuntimeState>()

  /**
   * The app's environment for a new terminal, minus agent session markers it may have inherited
   * (see `withoutSessionMarkers`), plus `extra`, which is applied last so it is never stripped.
   */
  function sanitisedEnv(
    terminalId: string,
    extra?: Record<string, string>
  ): Record<string, string> {
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) env[key] = value
    }
    // xterm.js renders 24-bit colour, but programs only use it when COLORTERM says so. Without it,
    // TUIs such as Codex quantise their colours to the 256-colour palette, which turns a background
    // blended from the theme into flat grey.
    return {
      ...withoutSessionMarkers(env),
      ...ports.usageEnv(env.CLAUDE_CODE_PLUGIN_DIRS, terminalId),
      ...extra,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor'
    }
  }

  function emitRuntimeState(state: TerminalRuntimeState): void {
    for (const listener of runtimeListeners) listener(state)
  }

  function onTerminalData(listener: DataListener): void {
    dataListeners.add(listener)
  }

  function onTerminalExit(listener: ExitListener): void {
    exitListeners.add(listener)
  }

  function onTerminalRuntimeState(listener: RuntimeListener): void {
    runtimeListeners.add(listener)
  }

  function createSession(options: SpawnOptions): TerminalSessionInfo {
    const id = nanoid(10)
    const cwd = resolveCwd(options.cwd)
    const shell = resolveShell(options.shell)
    const environment = { ...shell.environment, ...sanitisedEnv(id, options.env) }
    const launch = shellIntegrationLaunch(shell, environment)
    const child = ports.spawn(shell.path, launch.args, {
      name: 'xterm-256color',
      cols: 100,
      rows: 30,
      cwd,
      env: { ...environment, ...launch.env }
    })

    const info: TerminalSessionInfo = {
      id,
      title: options.title ?? 'Terminal',
      cwd,
      dialect: shell.syntax.dialect,
      ...(options.taskId ? { taskId: options.taskId } : {}),
      ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
      ...(options.provider ? { provider: options.provider } : {}),
      ...(options.replay ? { replay: true } : {})
    }
    const session: Session = {
      info,
      pty: child,
      transcript: new TerminalTranscript(id, cwd)
    }
    sessions.set(id, session)

    child.onData((data) => {
      const update = session.transcript.append(data)
      for (const state of update.runtimeStates) emitRuntimeState(state)
      for (const listener of dataListeners) listener(id, update.output)
    })
    child.onExit(({ exitCode }) => {
      const runtimeState = session.transcript.terminate(exitCode)
      exitedRuntimeStates.set(id, runtimeState)
      emitRuntimeState(runtimeState)
      if (info.taskId) exitedTaskIds.set(id, { taskId: info.taskId, workspaceId: info.workspaceId })
      sessions.delete(id)
      for (const listener of exitListeners) listener(id, exitCode)
    })

    if (options.command) child.write(`${options.command}\r`)
    return info
  }

  function writeToSession(id: string, data: string): void {
    sessions.get(id)?.pty.write(data)
  }

  function resizeSession(id: string, cols: number, rows: number): void {
    sessions.get(id)?.pty.resize(Math.max(cols, 1), Math.max(rows, 1))
  }

  function killSession(id: string): void {
    const session = sessions.get(id)
    if (!session) return
    session.pty.kill()
    sessions.delete(id)
  }

  function sessionBacklog(id: string): TerminalOutput {
    const session = sessions.get(id)
    if (!session) return { data: '', sequence: 0, marks: [] }
    return session.transcript.backlog()
  }

  function terminalRuntimeState(id: string): TerminalRuntimeState | undefined {
    return sessions.get(id)?.transcript.runtimeState() ?? exitedRuntimeStates.get(id)
  }

  /** The task a session belongs to, with its workspace — ids repeat across workspaces. */
  function sessionTask(id: string): { taskId: string; workspaceId?: string } | undefined {
    const info = sessions.get(id)?.info
    return info?.taskId
      ? { taskId: info.taskId, workspaceId: info.workspaceId }
      : exitedTaskIds.get(id)
  }

  function findSessionByTask(
    taskId: string,
    workspaceId?: string
  ): TerminalSessionInfo | undefined {
    return [...sessions.values()].find(
      (session) => session.info.taskId === taskId && session.info.workspaceId === workspaceId
    )?.info
  }

  function listSessions(): TerminalSessionInfo[] {
    return [...sessions.values()].map((session) => session.info)
  }

  function killAllSessions(): void {
    for (const id of [...sessions.keys()]) killSession(id)
  }

  return {
    onTerminalData,
    onTerminalExit,
    onTerminalRuntimeState,
    createSession,
    writeToSession,
    resizeSession,
    killSession,
    sessionBacklog,
    terminalRuntimeState,
    sessionTask,
    findSessionByTask,
    listSessions,
    killAllSessions
  }
}

export type TerminalsService = ReturnType<typeof createTerminalsService>

/**
 * The terminal events every renderer receives, sent through the host's `broadcast`. The caller
 * subscribes them (`onTerminalData` …), so it decides what else runs on the same event and when.
 */
export function terminalBroadcasts(broadcast: HostPorts['broadcast']) {
  return {
    data: (id: string, output: TerminalOutput) => broadcast('terminal:data', { id, ...output }),
    runtimeState: (state: TerminalRuntimeState) => broadcast('terminal:runtimeState', state),
    exit: (id: string, exitCode: number) => broadcast('terminal:exit', { id, exitCode })
  }
}
