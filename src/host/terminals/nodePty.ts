import { spawn } from 'node-pty'
import type { TerminalsPorts } from './terminalsService.js'

/**
 * The real PTY for the terminals service. Kept apart from the service so its tests never load
 * node-pty, which is built against Electron's ABI and does not load under plain `node`.
 */
export const nodePtySpawn: TerminalsPorts['spawn'] = (file, args, options) =>
  spawn(file, args, options)
