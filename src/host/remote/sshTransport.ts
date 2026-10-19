import { spawn } from 'node:child_process'
import { sshArgs } from '@core/remote.js'
import type { RemoteWorkspaceLink } from '@core/types.js'
import type { TransportChild } from './connection.js'

/**
 * The real transport: the system `ssh`, found on PATH (OpenSSH ships with macOS, Linux and
 * Windows 10+), with no shell in between. Styr stores no credentials: keys, agents and
 * `~/.ssh/config` are ssh's business, and batch mode means it never prompts.
 */
export function sshTransport(link: RemoteWorkspaceLink): TransportChild {
  const child = spawn('ssh', sshArgs(link), { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  let ended = false
  const exitListeners: ((code: number | null, error?: Error) => void)[] = []
  const end = (code: number | null, error?: Error): void => {
    if (ended) return
    ended = true
    for (const listener of exitListeners) listener(code, error)
  }
  child.once('error', (error) => end(null, error))
  child.once('exit', (code) => end(code))
  // A broken pipe while the child exits is reported by its exit, not as an unhandled error.
  child.stdin.on('error', () => undefined)
  return {
    write: (data) => {
      if (!child.stdin.destroyed) child.stdin.write(data)
    },
    onStdout: (listener) => child.stdout.on('data', listener),
    onStderr: (listener) => child.stderr.on('data', listener),
    onExit: (listener) => exitListeners.push(listener),
    kill: () => {
      child.kill()
    }
  }
}
