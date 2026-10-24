import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The server answers the IPC channels under the same names. This reads the desktop's handlers
// and the server's table from source, as the IPC contract test does, so a channel added to one
// and not the other fails here instead of failing for remote workspaces only.

const ROOT = fileURLToPath(new URL('../..', import.meta.url))

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) ? [path] : []
  })
}

function matches(text: string, pattern: RegExp): string[] {
  return [...text.matchAll(pattern)].map((match) => match[1] ?? '')
}

const main = sourceFiles(join(ROOT, 'src/main'))
  .map((file) => readFileSync(file, 'utf8'))
  .join('\n')
// The shared table (`src/host/channelTable.ts`) is what both hosts answer; `ipc.ts` registers it
// in a loop, so the desktop's channels are its literal handlers plus the table's.
const hostSource = readFileSync(join(ROOT, 'src/host/channelTable.ts'), 'utf8')
const desktop = new Set([
  ...matches(main, /ipcMain\.(?:handle|on)\(\s*'([^']+)'/g),
  ...matches(hostSource, /^\s+'([a-z]+:[A-Za-z]+)': channel\(/gm)
])
const server = new Set(matches(hostSource, /^\s+'([a-z]+:[A-Za-z]+)': channel\(/gm))
/** Channels the hub answers itself (`hub.ts`), because the PTY size follows focus. */
const HUB = new Set(['terminal:resize'])

/**
 * The desktop-only handlers (`docs/architecture/host.md`, What stays in `src/main/`): they act on
 * the machine the window is on, so a remote workspace's client keeps answering them locally.
 */
const DESKTOP_ONLY = new Set([
  'tasks:openInEditor',
  'tasks:reveal',
  'terminal:openInCode',
  'terminal:revealDirectory',
  'terminal:openLink',
  // The tabs of the last session are machine-local state of the desktop app (`terminalTabs.ts`).
  'terminal:setLayout',
  'terminal:pendingLayout',
  'terminal:restoreLayout',
  'terminal:dismissLayout',
  'settings:listApps',
  'settings:pickDirectory',
  'settings:pickApp',
  'settings:pickFiles',
  'app:titleBarColors',
  'app:info',
  'app:changelog',
  // The tray's request for this machine's window.
  'app:takeCommand',
  'updates:state',
  'updates:check',
  'updates:install',
  'updates:notes',
  // The Styr Terminal engine runs where it draws, on the client, over the terminal data stream.
  'terminal:engineAvailability',
  'terminal:engineEnvironment',
  'terminal:engineSelected',
  'terminal:benchEnabled',
  'terminal:bench',
  'terminal:nativeAttach',
  'terminal:nativeResize',
  'terminal:nativeScroll',
  'terminal:nativeText',
  'terminal:nativeLines',
  'terminal:nativeStyledLines',
  'terminal:nativeDetach',
  'terminal:nativeClearBlocks',
  'terminal:nativeReceived',
  // Remote access: this computer's own listener and the devices paired with it
  // (`src/main/networkAccess.ts`).
  'access:state',
  'access:configure',
  'access:pair',
  'access:cancelPair',
  'access:revoke',
  // The client's own connections to remote hosts (`src/main/remote.ts`).
  'remote:state',
  'remote:retry',
  'remote:switchBack',
  'remote:addWorkspace',
  // Setting up and running a host's server, over ssh from this computer (`hostSetup.ts`).
  'remote:inspect',
  'remote:setup',
  'remote:runningAgents',
  'remote:upgrade',
  'remote:stopServer',
  'remote:disconnect',
  'remote:connect'
])

describe('the server channel table', () => {
  it('finds channels on both sides (the scan itself works)', () => {
    expect(desktop.size).toBeGreaterThan(80)
    expect(server.size).toBeGreaterThan(60)
  })

  it('answers every desktop channel that is not desktop-only', () => {
    const missing = [...desktop].filter(
      (channel) => !server.has(channel) && !HUB.has(channel) && !DESKTOP_ONLY.has(channel)
    )
    expect(missing).toEqual([])
  })

  it('has the desktop register the shared table, and keep no second copy of its channels', () => {
    const ipc = readFileSync(join(ROOT, 'src/main/ipc.ts'), 'utf8')
    expect(ipc).toContain('channelTable.invoke')
    const literal = new Set(matches(main, /ipcMain\.(?:handle|on)\(\s*'([^']+)'/g))
    expect([...server].filter((channel) => literal.has(channel))).toEqual([])
  })

  it('answers no desktop-only channel, and nothing the desktop does not have', () => {
    expect([...server].filter((channel) => DESKTOP_ONLY.has(channel))).toEqual([])
    expect([...server].filter((channel) => !desktop.has(channel))).toEqual([])
  })

  it('lists only desktop-only channels that still exist', () => {
    expect([...DESKTOP_ONLY].filter((channel) => !desktop.has(channel))).toEqual([])
  })
})
