import { expect, test } from '@playwright/test'
import { launchStyr, type StyrApp } from './harness'

// The Styr Terminal engine in the sandboxed window (docs/architecture/terminal-engine.md). The
// package is private, so this runs only where `STYR_TERMINAL_PATH` names a build of it, as
// `nativeEngine.integration.test.ts` does; public CI skips it.

const enginePath = process.env.STYR_TERMINAL_PATH

test.skip(!enginePath, 'STYR_TERMINAL_PATH names no Styr Terminal build')

let styr: StyrApp

test.beforeAll(async () => {
  styr = await launchStyr('native', { STYR_EXPERIMENTAL_TERMINAL: '1' })
})

// Playwright reads fixtures from the destructuring; this hook asks for none.
// eslint-disable-next-line no-empty-pattern
test.afterEach(async ({}, testInfo) => {
  await styr.attachOnFailure(testInfo)
})

test.afterAll(async () => {
  await styr?.close()
})

test('a Styr Terminal tab runs a command in the sandboxed window', async () => {
  const { page } = styr
  await page.getByRole('button', { name: /^Toggle the terminal panel/ }).click()
  const sessions = (): Promise<string[]> =>
    page.evaluate(async () => (await window.api.terminal.list()).map((session) => session.id))
  const before = await sessions()
  await page.getByRole('button', { name: '+ Shell' }).click()
  await expect.poll(async () => (await sessions()).length).toBe(before.length + 1)
  const id = (await sessions()).find((session) => !before.includes(session))!
  const terminal = page.locator('.styr-native-terminal').last()
  await expect(terminal).toBeVisible()
  await expect
    .poll(() =>
      page.evaluate(async (id) => (await window.api.terminal.runtimeState(id))?.promptReady, id)
    )
    .toBe(true)
  await terminal.click()
  await page.keyboard.type('echo styr-native\n')
  await expect(terminal.getByText(/^styr-native\s*$/)).toHaveCount(1)
  await page
    .getByRole('button', { name: /^Close / })
    .last()
    .click()
  await expect.poll(sessions).toEqual(before)
  styr.expectNoErrors()
})

test('a Styr Terminal tab detaches into its own window and docks back', async () => {
  const { app, page, errors } = styr
  const sessions = (): Promise<string[]> =>
    page.evaluate(async () => (await window.api.terminal.list()).map((session) => session.id))
  const before = await sessions()
  await page.getByRole('button', { name: '+ Shell' }).click()
  await expect.poll(async () => (await sessions()).length).toBe(before.length + 1)
  const id = (await sessions()).find((session) => !before.includes(session))!
  await expect
    .poll(() =>
      page.evaluate(async (id) => (await window.api.terminal.runtimeState(id))?.promptReady, id)
    )
    .toBe(true)
  const terminal = page.locator('.styr-native-terminal').last()
  await terminal.click()
  await page.keyboard.type('echo native-before\n')
  await expect(terminal.getByText(/^native-before\s*$/)).toHaveCount(1)

  const opened = app.waitForEvent('window')
  await page
    .getByRole('button', { name: /^Close / })
    .last()
    .locator('..')
    .click({ button: 'right' })
  await page.getByRole('menuitem', { name: /^Detach to window/ }).click()
  const detached = await opened
  detached.on('console', (message) => {
    if (message.type() === 'error') errors.push(`detached console.error: ${message.text()}`)
  })
  detached.on('pageerror', (error) => errors.push(`detached pageerror: ${error.message}`))
  // The new window's engine attaches after the main window's let go, and draws the scrollback.
  const away = detached.locator('.styr-native-terminal')
  await expect(away.getByText(/^native-before\s*$/)).toHaveCount(1)
  await away.click()
  await detached.keyboard.type('echo native-detached\n')
  await expect(away.getByText(/^native-detached\s*$/)).toHaveCount(1)

  const closed = detached.waitForEvent('close')
  await detached.getByRole('button', { name: 'Dock to main window' }).click()
  await closed
  await expect(
    page
      .locator('.styr-native-terminal')
      .last()
      .getByText(/^native-detached\s*$/)
  ).toHaveCount(1)
  await page
    .getByRole('button', { name: /^Close / })
    .last()
    .click()
  await expect.poll(sessions).toEqual(before)
  styr.expectNoErrors()
})
