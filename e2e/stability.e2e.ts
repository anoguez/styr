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
import { generateKeyPairSync, createPublicKey, type KeyObject } from 'node:crypto'
import { join, resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import { createSecureClientHandshake } from '../src/host/remoteAccess/secureClient'
import type { SecureFrameChannel } from '../src/host/remoteAccess/secureSession'
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
  styr = await launchStyr('access')
  const { page } = styr
  // The workspace is shared and the listener is up; the test connects over loopback, the one
  // address that needs no network. An unpaired peer must still get nothing.
  const settings = await page.evaluate(() => window.api.settings.get())
  await page.evaluate((change) => window.api.settings.save(change), {
    workspaceId: settings.activeWorkspaceId,
    workspace: { ...settings, remoteAccess: true },
    global: { ...settings }
  } as never)
  const state = await page.evaluate(() => window.api.access.configure({ enabled: true }))
  expect(state.listening, state.error).toBe(true)
  // The port it found free (7878, or the next free one).
  const port = state.port

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

/**
 * A phone, as the Styr app is: protocol 2 from the URI a QR carries, its own Ed25519 key, then one
 * JSON-RPC call over the sealed session. Runs in plain Node against the Electron app, so the two
 * crypto stacks (Node's OpenSSL here, Electron's BoringSSL there) must agree.
 */
class Phone {
  private readonly key: KeyObject = generateKeyPairSync('ed25519').privateKey
  deviceId?: string
  /** After `request`: the code this phone shows while the desktop decides. */
  approvalCode?: string

  constructor(
    private readonly uri: URL,
    /** Ask to pair by approval, as a phone that found the computer on the network does. */
    private readonly asking = false
  ) {}

  /** Pairs with the QR's secret (once), or signs in with the device id; the session or the close code. */
  async connect(): Promise<Session | { code: number }> {
    const client = createSecureClientHandshake({
      ...(this.asking && !this.deviceId
        ? {}
        : { pinnedFingerprint: this.uri.searchParams.get('fp')! }),
      identity: {
        privateKey: this.key,
        publicKey: createPublicKey(this.key)
          .export({ type: 'spki', format: 'der' })
          .toString('base64')
      },
      signIn: this.deviceId
        ? { type: 'auth', deviceId: this.deviceId }
        : this.asking
          ? { type: 'request', name: 'Test phone' }
          : { type: 'pair', name: 'Test phone', secret: this.uri.searchParams.get('secret')! },
      maxMessageBytes: 8 * 1024 * 1024
    })
    const socket = new WebSocket(`ws://127.0.0.1:${this.uri.searchParams.get('port')}/`)
    return new Promise((done) => {
      socket.onopen = () => socket.send(client.start())
      socket.onclose = (event) => done({ code: event.code })
      socket.onmessage = (event) => {
        const step = client.receive(String(event.data))
        if (step.kind === 'send') {
          if (step.approval) this.approvalCode = step.approval.code
          for (const frame of step.frames) socket.send(frame)
        }
        if (step.kind === 'ready') {
          this.deviceId ??= step.deviceId
          // Every sealed message from here on, in order: dropping one breaks the channel for good.
          const session: Session = { channel: step.channel, socket, received: [] }
          socket.onmessage = (next) => {
            const text = step.channel.open(String(next.data))
            if (text !== undefined) session.received.push(text)
          }
          socket.onclose = null
          done(session)
        }
      }
    })
  }
}

/** A signed-in session, and every message the host sent on it so far. */
interface Session {
  channel: SecureFrameChannel
  socket: WebSocket
  received: string[]
}

/** One JSON-RPC call over a signed-in session; skips the server's notifications. */
async function call(
  session: Session,
  method: string,
  params: unknown[] = []
): Promise<{ result?: unknown; error?: { message: string } }> {
  const id = Math.floor(Math.random() * 1e9)
  for (const frame of session.channel.seal(
    JSON.stringify({ jsonrpc: '2.0', id, method, params })
  )) {
    session.socket.send(frame)
  }
  for (;;) {
    for (const text of session.received) {
      const message = JSON.parse(text) as {
        id?: number
        result?: unknown
        error?: { message: string }
      }
      if (message.id === id) return message
    }
    await new Promise((wait) => setTimeout(wait, 10))
  }
}

test('a device pairs with the desktop app from its QR, signs in again, and is cut off on removal', async () => {
  styr = await launchStyr('pairing')
  const { page } = styr
  const settings = await page.evaluate(() => window.api.settings.get())
  await page.evaluate((change) => window.api.settings.save(change), {
    workspaceId: settings.activeWorkspaceId,
    workspace: { ...settings, remoteAccess: true },
    global: { ...settings }
  } as never)
  const state = await page.evaluate(() => window.api.access.configure({ enabled: true }))
  expect(state.listening, state.error).toBe(true)
  const pairing = await page.evaluate(() => window.api.access.pair())
  const phone = new Phone(new URL(pairing.uri))

  // Pairing runs the whole Noise handshake in the Electron main process.
  const first = await phone.connect()
  expect('channel' in first, `closed with ${'code' in first ? first.code : ''}`).toBe(true)
  if (!('channel' in first)) return
  expect((await call(first, 'tasks:list')).result).toEqual(expect.any(Array))
  first.socket.close()
  expect((await page.evaluate(() => window.api.access.state())).devices).toHaveLength(1)

  // Again, without the QR: the device's own key signs it in.
  const again = await phone.connect()
  expect('channel' in again).toBe(true)
  if (!('channel' in again)) return
  const closed = new Promise<number>((done) => (again.socket.onclose = (event) => done(event.code)))

  // Removing it on the desktop ends the live session at once (4403) and refuses the next.
  await page.evaluate((id) => window.api.access.revoke(id), phone.deviceId!)
  expect(await closed).toBe(4403)
  expect(await phone.connect()).toEqual({ code: 4401 })

  await page.evaluate(() => window.api.access.configure({ enabled: false }))
  styr.expectNoErrors()
})

test('a device on the network asks to pair, and the desktop allows it after comparing codes', async () => {
  styr = await launchStyr('approval')
  const { page } = styr
  await page.getByRole('button', { name: /^Settings/ }).click()
  const settings = page.locator('[aria-label="Settings"]')
  await settings.getByRole('button', { name: /^Connections/ }).click()
  await settings.getByRole('button', { name: 'Get started' }).click()
  await page
    .locator('[aria-label="Connect a device to this computer"]')
    .getByRole('button', { name: 'Get started' })
    .click()
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByRole('img', { name: 'Pairing QR code' })).toBeVisible()

  // The phone knows the computer's address and port (from the network), not its QR.
  const state = await page.evaluate(() => window.api.access.state())
  const phone = new Phone(new URL(`styr://pair?port=${state.port}`), true)
  const asked = phone.connect()
  const prompt = page.getByRole('alertdialog', { name: 'Test phone wants to connect' })
  await expect(prompt).toBeVisible()
  // Both screens show the same code.
  await expect.poll(() => phone.approvalCode).toMatch(/^\d{6}$/)
  await expect(prompt.getByLabel(`Code ${phone.approvalCode}`)).toBeVisible()
  await prompt.getByRole('button', { name: 'Allow' }).click()

  const session = await asked
  expect('channel' in session).toBe(true)
  if (!('channel' in session)) return
  expect((await call(session, 'tasks:list')).result).toEqual(expect.any(Array))
  await expect(page.getByText('Test phone is connected')).toBeVisible()
  session.socket.close()
  await page.getByRole('button', { name: 'Done' }).click()
  await settings.getByRole('button', { name: 'Close' }).first().click()
  await page.evaluate(() => window.api.access.configure({ enabled: false }))
  styr.expectNoErrors()
})

test('a device asking to pair is refused while no Add device window is open', async () => {
  styr = await launchStyr('approval-closed')
  const { page } = styr
  const state = await page.evaluate(() => window.api.access.configure({ enabled: true }))
  const phone = new Phone(new URL(`styr://pair?port=${state.port}`), true)
  expect(await phone.connect()).toEqual({ code: 4401 })
  expect((await page.evaluate(() => window.api.access.state())).devices).toEqual([])
  await page.evaluate(() => window.api.access.configure({ enabled: false }))
  styr.expectNoErrors()
})

test('another computer on the network: pair by approval, open its shared workspace, see its board', async () => {
  // Computer A shares its Default workspace, with a task on it.
  const a = await launchStyr('lan-a')
  let b: StyrApp | undefined
  try {
    await a.page.evaluate(() => window.api.tasks.create({ title: 'Made on computer A' }))
    await a.page.getByRole('button', { name: /^Settings/ }).click()
    const settingsA = a.page.locator('[aria-label="Settings"]')
    await settingsA.getByRole('button', { name: /^Connections/ }).click()
    await settingsA.getByRole('button', { name: 'Get started' }).click()
    await a.page
      .locator('[aria-label="Connect a device to this computer"]')
      .getByRole('button', { name: 'Get started' })
      .click()
    await a.page.getByRole('button', { name: 'Continue' }).click()
    await expect(a.page.getByRole('img', { name: 'Pairing QR code' })).toBeVisible()
    const port = (await a.page.evaluate(() => window.api.access.state())).port

    // Computer B, with remote workspaces on, adds A by its address.
    b = await launchStyr('lan-b')
    const settings = await b.page.evaluate(() => window.api.settings.get())
    await b.page.evaluate(
      (next) =>
        window.api.settings.save({
          workspaceId: next.activeWorkspaceId,
          global: next,
          workspace: next
        } as never),
      { ...settings, experimental: { ...settings.experimental, remoteWorkspaces: true } }
    )
    await b.page.getByRole('button', { name: /^Settings/ }).click()
    const settingsB = b.page.locator('[aria-label="Settings"]')
    await settingsB.getByRole('button', { name: /^Connections/ }).click()
    await settingsB.getByRole('radio', { name: 'Other computers' }).click()
    await settingsB.getByRole('button', { name: 'Add computer' }).click()
    await b.page.getByLabel('Address').fill(`127.0.0.1:${port}`)
    await b.page.getByLabel('Name').fill('Computer A')
    await b.page.getByRole('button', { name: 'Connect', exact: true }).click()

    // Both screens show the same code; A allows it.
    const shown = b.page.getByLabel(/^Code \d{6}$/)
    await expect(shown).toBeVisible()
    const code = (await shown.getAttribute('aria-label'))!.slice('Code '.length)
    const prompt = a.page.getByRole('alertdialog', { name: /wants to connect$/ })
    await expect(prompt.getByLabel(`Code ${code}`)).toBeVisible()
    await prompt.getByRole('button', { name: 'Allow' }).click()

    // B lists what A shares, and opens it: A's board, on B.
    const open = b.page.getByRole('heading', { name: 'Open a workspace on Computer A' })
    await expect(open).toBeVisible()
    await b.page.getByRole('button', { name: 'Open', exact: true }).click()
    await expect(b.page.getByText('Made on computer A')).toBeVisible({ timeout: 20_000 })
    const tasks = await b.page.evaluate(() => window.api.tasks.list())
    expect(tasks.map((task) => task.title)).toContain('Made on computer A')

    // Each connection A saw: the pairing, the list of what it shares, and the one B keeps open.
    expect((await b.page.evaluate(() => window.api.remote.state())).hosts).toMatchObject([
      { status: 'connected', serverWorkspace: { id: 'default' } }
    ])
    a.expectNoErrors()
    b.expectNoErrors()
  } finally {
    await b?.close()
    await a.close()
  }
})
