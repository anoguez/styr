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
