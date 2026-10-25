import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync
} from 'node:fs'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import { card, column, launchStyr, type StyrApp } from './harness'

// What an upgrade and the network listener must survive, on throwaway profiles. See
// docs/architecture/testing.md ("Stability tests").

const fixture = resolve(__dirname, 'fixtures', 'upgrade')

/** The index schema the app is built with, read from its source. */
function schemaVersion(): number {
  const source = readFileSync(resolve(__dirname, '..', 'src', 'host', 'taskIndex.ts'), 'utf8')
  const match = /const SCHEMA_VERSION = (\d+)/.exec(source)
  if (!match) throw new Error('SCHEMA_VERSION not found in taskIndex.ts')
  return Number(match[1])
}

/** SQLite keeps `user_version` as a big-endian integer at byte 60 of the database file. */
const USER_VERSION_OFFSET = 60

function userVersion(file: string): number {
  return readFileSync(file).readUInt32BE(USER_VERSION_OFFSET)
}

function setUserVersion(file: string, version: number): void {
  const bytes = Buffer.alloc(4)
  bytes.writeUInt32BE(version)
  const fd = openSync(file, 'r+')
  try {
    writeSync(fd, bytes, 0, 4, USER_VERSION_OFFSET)
  } finally {
    closeSync(fd)
  }
}

function seedEarlierRelease(home: string): void {
  cpSync(join(fixture, 'Styr'), join(home, 'Styr'), { recursive: true })
  const config = readFileSync(join(fixture, 'config.json'), 'utf8').replaceAll('__HOME__', home)
  mkdirSync(join(home, '.styr'), { recursive: true })
  writeFileSync(join(home, '.styr', 'config.json'), config)
}

test.describe.configure({ mode: 'serial' })

let styr: StyrApp | undefined

// Playwright reads fixtures from the destructuring; this hook asks for none.
// eslint-disable-next-line no-empty-pattern
test.afterEach(async ({}, testInfo) => {
  if (styr) await styr.attachOnFailure(testInfo)
})

test.afterAll(async () => {
  await styr?.close()
})

test('an earlier release’s profile loads, and the index rebuilds after a schema bump', async () => {
  styr = await launchStyr('upgrade', {}, { seed: seedEarlierRelease, keepHome: true })
  const { home, storageDir } = styr
  const { page } = styr
  await expect(card(page, 'Written by an earlier version')).toBeVisible()
  await expect(column(page, 'In Progress').getByText('Written by an earlier version')).toBeVisible()
  expect(await page.evaluate(async () => (await window.api.settings.get()).storageDir)).toBe(
    storageDir
  )
  styr.expectNoErrors()
  await styr.close()

  // The index was written by an older schema; a task file also arrives while the app is closed.
  const index = join(storageDir, '.styr', 'index.db')
  expect(userVersion(index)).toBe(schemaVersion())
  for (const sidecar of ['-wal', '-shm']) rmSync(`${index}${sidecar}`, { force: true })
  setUserVersion(index, 1)
  const added = readFileSync(
    join(storageDir, 'tasks', 'TASK-0001-written-by-an-earlier-version.md'),
    'utf8'
  )
    .replace('TASK-0001', 'TASK-0003')
    .replace('Written by an earlier version', 'Added while Styr was closed')
    .replace('in_progress', 'backlog')
  writeFileSync(join(storageDir, 'tasks', 'TASK-0003-added-while-closed.md'), added)

  styr = await launchStyr('upgrade', {}, { home, keepHome: true })
  await expect(column(styr.page, 'Backlog').getByText('Added while Styr was closed')).toBeVisible()
  await expect(card(styr.page, 'Written by an earlier version')).toBeVisible()
  // The Done column may hide an old task (the cap, auto-archive): ask the index.
  const tasks = await styr.page.evaluate(() => window.api.tasks.list())
  expect(tasks.map((task) => task.id).sort()).toEqual(['TASK-0001', 'TASK-0002', 'TASK-0003'])
  styr.expectNoErrors()
  await styr.close()
  // The schema bump was written to the file (WAL mode: the header reaches it at checkpoint, close).
  expect(existsSync(index)).toBe(true)
  expect(userVersion(index)).toBe(schemaVersion())
  rmSync(home, { recursive: true, force: true })
  styr = undefined
})

test('a device that has not paired is refused by the remote access listener', async () => {
  const port = await freePort()
  styr = await launchStyr('access')
  const { page } = styr
  // The workspace is shared and the listener is up, on loopback only: the one address that needs
  // no network. An unpaired peer must still get nothing.
  const settings = await page.evaluate(() => window.api.settings.get())
  await page.evaluate((change) => window.api.settings.save(change), {
    workspaceId: settings.activeWorkspaceId,
    workspace: { ...settings, remoteAccess: true },
    global: { ...settings }
  } as never)
  const state = await page.evaluate((patch) => window.api.access.configure(patch), {
    enabled: true,
    bindAddress: '127.0.0.1',
    port
  })
  expect(state.listening, state.error).toBe(true)

  const outcome = await new Promise<{ code: number; messages: string[] }>((resolveOutcome) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`)
    const messages: string[] = []
    socket.onopen = () =>
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tasks:list', params: [] }))
    socket.onmessage = (event) => messages.push(String(event.data))
    socket.onclose = (event) => resolveOutcome({ code: event.code, messages })
    socket.onerror = () => undefined
  })
  // 4400/4401: bad request or unauthorized. Never an answer to the call.
  expect([4400, 4401]).toContain(outcome.code)
  expect(outcome.messages.join('')).not.toContain('"result"')

  await page.evaluate(() => window.api.access.configure({ enabled: false }))
  styr.expectNoErrors()
})

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolvePort(port))
    })
  })
}
