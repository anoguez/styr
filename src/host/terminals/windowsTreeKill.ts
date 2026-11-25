import { spawnSync } from 'node:child_process'
import type { PtyProcess } from './terminalsService.js'

/** Runs a command to completion; `spawnSync` in the app. */
export type RunSync = (
  file: string,
  args: string[],
  options: { stdio: 'ignore'; windowsHide: true; timeout: number }
) => unknown

/** Long enough for a busy machine, short enough that quitting never seems to hang. */
const TASKKILL_TIMEOUT_MS = 5_000

/**
 * Ends `pid` and everything it started, at once. Synchronous so it is done before the app
 * exits: quitting kills every terminal from `before-quit`, and the process ends right after.
 */
export function killProcessTree(pid: number, run: RunSync = spawnSync): void {
  run('taskkill', ['/PID', String(pid), '/T', '/F'], {
    stdio: 'ignore',
    windowsHide: true,
    timeout: TASKKILL_TIMEOUT_MS
  })
}

/**
 * On Windows, `kill()` first ends the shell's whole process tree, then lets node-pty close the
 * pseudo-console.
 *
 * node-pty's own kill (1.1, ConPTY) asks a forked helper to attach to the shell's console and list
 * what runs in it, but closes the console without waiting for the answer. When the console goes
 * first the helper fails ("AttachConsole failed"), nothing is listed, and whatever ran in the
 * terminal (the shell, an agent, a dev server) outlives the app. Killing by parent instead does
 * not depend on that race. Elsewhere `pty` is returned as it is: closing the pty hangs up the
 * session there, and the shell's processes get SIGHUP.
 */
export function withWindowsTreeKill<T extends PtyProcess & { readonly pid: number }>(
  pty: T,
  platform: NodeJS.Platform = process.platform,
  killTree: (pid: number) => void = killProcessTree
): T {
  if (platform !== 'win32') return pty
  const kill = pty.kill.bind(pty)
  pty.kill = () => {
    try {
      killTree(pty.pid)
    } finally {
      kill()
    }
  }
  return pty
}
