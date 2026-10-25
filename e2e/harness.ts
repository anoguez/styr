import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  _electron as electron,
  expect,
  type ElectronApplication,
  type Page,
  type TestInfo
} from '@playwright/test'

// Launches the built app (`out/`, or the packaged one: `STYR_APP_EXECUTABLE`) in a throwaway HOME, as the smoke test does, for the feature
// tests. Nothing here needs an agent CLI or the network. See docs/architecture/testing.md.

/** Vite's stub for a Node builtin in renderer code: the window loads blank. */
const EXTERNALIZED = /externalized for browser compatibility/i
/** A failed IPC handler or an uncaught error in the main process. */
const MAIN_ERROR = /Error occurred in handler|Uncaught|Unhandled/i

const root = resolve(__dirname, '..')

/**
 * What to launch: the built app in `out/`, or — when `STYR_APP_EXECUTABLE` names one — the
 * packaged app as shipped (asar, rebuilt native modules, signing), which the release jobs test
 * before they upload anything.
 */
export function appLaunch(home: string): { executablePath?: string; args: string[]; cwd: string } {
  const executablePath = process.env.STYR_APP_EXECUTABLE
  if (executablePath) {
    if (!existsSync(executablePath))
      throw new Error(`STYR_APP_EXECUTABLE names no file: ${executablePath}`)
  } else if (!existsSync(join(root, 'out', 'main', 'index.mjs')))
    throw new Error('No build in out/. Run `yarn test:smoke`, which builds first.')
  return {
    executablePath,
    cwd: root,
    args: [
      // The packaged executable runs its own app; only Electron itself is pointed at `.`.
      ...(executablePath ? [] : ['.']),
      `--user-data-dir=${join(home, 'userData')}`,
      // CI's Ubuntu forbids the unprivileged user namespaces Chromium's sandbox needs.
      ...(process.platform === 'linux' ? ['--no-sandbox'] : [])
    ]
  }
}

export interface StyrApp {
  app: ElectronApplication
  page: Page
  /** The throwaway HOME. */
  home: string
  /** `Settings.storageDir`: `~/Styr` under that HOME. */
  storageDir: string
  /** Renderer errors since the last `expectNoErrors`. */
  errors: string[]
  mainLog: string[]
  /**
   * Fails on a renderer error, or a main-process error not matching `allowed` (a handler that is
   * meant to refuse, say). Clears both, so each step checks only its own.
   */
  expectNoErrors(allowed?: RegExp): void
  /** Attaches the errors, the main process output and a screenshot to a failed test's report. */
  attachOnFailure(testInfo: TestInfo): Promise<void>
  close(): Promise<void>
}

/** `extra` adds to the app's environment for this launch only (say, an experimental switch). */
export async function launchStyr(
  name: string,
  extra: Record<string, string> = {}
): Promise<StyrApp> {
  const home = mkdtempSync(join(tmpdir(), `styr-${name}-`))
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    STYR_HOME: join(home, '.styr'),
    // The shell must not read the real dotfiles either: they can prompt or fail in a temp HOME.
    ZDOTDIR: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    XDG_CACHE_HOME: join(home, '.cache'),
    ...extra
  }
  // Set by `electron-vite dev`; the tests load the built renderer from `out/`.
  delete env.ELECTRON_RENDERER_URL
  const errors: string[] = []
  const mainLog: string[] = []
  const app = await electron.launch({ ...appLaunch(home), env: env as Record<string, string> })
  app.process().stderr?.on('data', (chunk) => mainLog.push(String(chunk)))
  app.process().stdout?.on('data', (chunk) => mainLog.push(String(chunk)))
  const page = await app.firstWindow().catch((error: Error) => {
    throw new Error(`${error.message}\n\nMain process output:\n${mainLog.join('')}`)
  })
  page.on('console', (message) => {
    if (message.type() === 'error' || EXTERNALIZED.test(message.text()))
      errors.push(`console.${message.type()}: ${message.text()}`)
  })
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
  // A fresh profile is welcomed by the setup wizard, which covers the board; these tests are
  // about other features, and the smoke test walks the wizard itself.
  await page.addInitScript(() => localStorage.setItem('styr.setup.seen', '1'))
  // The window may have run its start-up before the listeners above existed.
  await page.reload()
  await expect(page.getByRole('button', { name: 'New task', exact: true })).toBeVisible()

  return {
    app,
    page,
    home,
    storageDir: join(home, 'Styr'),
    errors,
    mainLog,
    expectNoErrors(allowed) {
      const main = mainLog
        .join('')
        .split('\n')
        .filter((line) => MAIN_ERROR.test(line) && !allowed?.test(line))
      const renderer = [...errors]
      errors.length = 0
      mainLog.length = 0
      expect(renderer, 'renderer console errors').toEqual([])
      expect(main, 'main process errors').toEqual([])
    },
    async attachOnFailure(testInfo) {
      if (testInfo.status === testInfo.expectedStatus) return
      if (errors.length > 0)
        await testInfo.attach('renderer errors', {
          body: errors.join('\n'),
          contentType: 'text/plain'
        })
      await testInfo.attach('main process', { body: mainLog.join(''), contentType: 'text/plain' })
      if (!page.isClosed())
        await testInfo.attach('window', {
          body: await page.screenshot({ path: testInfo.outputPath('window.png') }),
          contentType: 'image/png'
        })
    },
    async close() {
      await app.close().catch(() => undefined)
      rmSync(home, { recursive: true, force: true })
    }
  }
}

/** A task's file in the default workspace (the storage folder itself). */
export function readTaskFile(storageDir: string, taskId: string): string {
  const dir = join(storageDir, 'tasks')
  const name = readdirSync(dir).find(
    (file) => file.startsWith(`${taskId}-`) && file.endsWith('.md')
  )
  if (!name) throw new Error(`${taskId} has no file in ${dir}`)
  return readFileSync(join(dir, name), 'utf8')
}

/** Runs git with a fixed identity and none of the user's config. */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Styr e2e',
      GIT_AUTHOR_EMAIL: 'e2e@styr.invalid',
      GIT_COMMITTER_NAME: 'Styr e2e',
      GIT_COMMITTER_EMAIL: 'e2e@styr.invalid'
    }
  }).trim()
}

/** A card on the board, found by its title. */
export const card = (page: Page, title: string) =>
  page.getByRole('button').filter({ has: page.getByText(title, { exact: true }) })

/** A board column, by its heading. */
export const column = (page: Page, label: string) =>
  page.locator('section').filter({ has: page.getByRole('heading', { name: label, exact: true }) })

/** Runs a command from the palette by its label. Command mode is the input's leading `>`. */
export async function runCommand(page: Page, label: string): Promise<void> {
  await page.keyboard.press('ControlOrMeta+k')
  const input = page.getByPlaceholder('Run a command…')
  await expect(input).toBeVisible()
  await input.fill(`>${label}`)
  // The entry's name also carries its shortcut hint, so match the label as a prefix.
  await page.getByRole('button', { name: new RegExp(`^${label}`) }).click()
}
