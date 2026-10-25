import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { appLaunch } from './harness'

// Drives the built app (`out/`, or the packaged one when STYR_APP_EXECUTABLE is set) through the paths a refactor is most likely to break. Everything
// lives in a throwaway HOME, so the run never reads or writes real settings, boards or agents.
// See docs/architecture/testing.md.

/** Vite's stub for a Node builtin in renderer code: the window loads blank. */
const EXTERNALIZED = /externalized for browser compatibility/i
/** The plain Save button, whose label carries its shortcut (not "Save as preset…" or "Save & Start"). */
const SAVE = /^Save(?! as preset| &)/
/** A failed IPC handler or an uncaught error in the main process. */
const MAIN_ERROR = /Error occurred in handler|Uncaught|Unhandled/i

const home = mkdtempSync(join(tmpdir(), 'styr-smoke-'))
/** `Settings.storageDir` defaults to `~/Styr`, and HOME is the temp folder. */
const storageDir = join(home, 'Styr')

/** Mirrors `workspaceDir`: the default workspace is the storage folder itself. */
function workspaceDir(id: string): string {
  return id === 'default' ? storageDir : join(storageDir, 'workspaces', id)
}

function taskFile(workspaceId: string, taskId: string): string {
  const dir = join(workspaceDir(workspaceId), 'tasks')
  const name = readdirSync(dir).find(
    (file) => file.startsWith(`${taskId}-`) && file.endsWith('.md')
  )
  if (!name) throw new Error(`${taskId} has no file in ${dir}`)
  return join(dir, name)
}

const readTask = (workspaceId: string, taskId: string): string =>
  readFileSync(taskFile(workspaceId, taskId), 'utf8')

/** The pid and every descendant of it, from `ps`. */
function processTree(root: number): number[] {
  const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .map((line) => line.trim().split(/\s+/).map(Number) as [number, number])
  const tree = [root]
  for (let i = 0; i < tree.length; i++)
    for (const [pid, ppid] of rows) if (ppid === tree[i] && !tree.includes(pid)) tree.push(pid)
  return tree
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

let app: ElectronApplication
let page: Page
/** Renderer errors since the last check; each step must leave it empty. */
const errors: string[] = []
/** The main process's output, attached when a step fails. */
const mainLog: string[] = []

function expectNoErrors(): void {
  expect(errors, 'renderer console errors').toEqual([])
  const main = mainLog
    .join('')
    .split('\n')
    .filter((line) => MAIN_ERROR.test(line))
  expect(main, 'main process errors').toEqual([])
}

async function activeWorkspace(): Promise<string> {
  return page.evaluate(async () => (await window.api.workspaces.list()).activeId)
}

/** A card on the board, found by its title. */
const card = (title: string) =>
  page.getByRole('button').filter({ has: page.getByText(title, { exact: true }) })

/** A board column, by its heading. */
const column = (label: string) =>
  page.locator('section').filter({ has: page.getByRole('heading', { name: label, exact: true }) })

async function openTask(title: string, id: string): Promise<void> {
  await card(title).hover()
  await card(title)
    .getByRole('button', { name: `Edit ${id}`, exact: true })
    .click()
}

async function createTask(title: string): Promise<void> {
  await page.getByRole('button', { name: 'New task', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'New task' })
  await dialog.getByLabel('Title').fill(title)
  await dialog.getByRole('button', { name: SAVE }).click()
  await expect(dialog).toBeHidden()
  await expect(column('Backlog').getByText(title)).toBeVisible()
}

test.beforeAll(async () => {
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
    XDG_CACHE_HOME: join(home, '.cache')
  }
  // Set by `electron-vite dev`; the smoke test loads the built renderer from `out/`.
  delete env.ELECTRON_RENDERER_URL
  app = await electron.launch({ ...appLaunch(home), env: env as Record<string, string> })
  app.process().stderr?.on('data', (chunk) => mainLog.push(String(chunk)))
  app.process().stdout?.on('data', (chunk) => mainLog.push(String(chunk)))
  page = await app.firstWindow().catch((error: Error) => {
    // Start-up threw before any window opened: show why.
    throw new Error(`${error.message}\n\nMain process output:\n${mainLog.join('')}`)
  })
  page.on('console', (message) => {
    if (message.type() === 'error' || EXTERNALIZED.test(message.text()))
      errors.push(`console.${message.type()}: ${message.text()}`)
  })
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
  // The window may have run its start-up before the listeners above existed; load it again so a
  // start-up error (a blank window) is seen.
  await page.reload()
})

// Playwright reads fixtures from the destructuring; this hook asks for none.
// eslint-disable-next-line no-empty-pattern
test.afterEach(async ({}, testInfo) => {
  // What went wrong when a step failed — errors, main-process output, the window — for the report.
  if (testInfo.status !== testInfo.expectedStatus && errors.length > 0)
    await testInfo.attach('renderer errors', { body: errors.join('\n'), contentType: 'text/plain' })
  if (testInfo.status !== testInfo.expectedStatus)
    await testInfo.attach('main process', { body: mainLog.join(''), contentType: 'text/plain' })
  if (testInfo.status !== testInfo.expectedStatus && !page.isClosed())
    await testInfo.attach('window', {
      body: await page.screenshot({ path: testInfo.outputPath('window.png') }),
      contentType: 'image/png'
    })
})

test.afterAll(async () => {
  // Normally closed by the last step; this covers a failure part-way through.
  await app?.close().catch(() => undefined)
  rmSync(home, { recursive: true, force: true })
})

test('smoke', async () => {
  await test.step('a fresh profile is welcomed by the setup wizard, which can be skipped', async () => {
    const wizard = page.getByRole('dialog', { name: 'Welcome to Styr' })
    await expect(wizard).toBeVisible()
    await wizard.getByRole('button', { name: /^Skip setup/ }).click()
    await expect(wizard.getByRole('heading', { name: 'You’re ready' })).toBeVisible()
    await wizard.getByRole('button', { name: /^Open board/ }).click()
    await expect(wizard).toBeHidden()
    expectNoErrors()
  })

  await test.step('the board renders with no renderer errors', async () => {
    await page.waitForLoadState('domcontentloaded')
    for (const label of ['Backlog', 'In Progress', 'In Review', 'Done'])
      await expect(page.getByRole('heading', { name: label, exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'New task', exact: true })).toBeVisible()
    // The renderer is sandboxed, and its preload reached it: `window.api` is all it has. CI's
    // Linux runs Chromium with --no-sandbox (harness), so the OS sandbox is checked elsewhere.
    if (process.platform !== 'linux') {
      const renderers = await app.evaluate(({ app }) =>
        app.getAppMetrics().filter((metric) => metric.type === 'Tab')
      )
      expect(renderers.map((metric) => metric.sandboxed)).toEqual([true])
    }
    expect(
      await page.evaluate(() => ({
        api: typeof window.api.tasks.list,
        require: typeof (window as { require?: unknown }).require,
        process: typeof (window as { process?: unknown }).process
      }))
    ).toEqual({ api: 'function', require: 'undefined', process: 'undefined' })
    expectNoErrors()
  })

  await test.step('the MCP server named in the setup command is on disk and starts', async () => {
    // Launched by plain `node`, which cannot read inside an asar archive: packaged, the entry must
    // sit under `app.asar.unpacked` (`asarUnpack` in electron-builder.yml).
    const command = await page.evaluate(() => window.api.app.mcpCommand('claude'))
    const entry = /["']?([^"']*\.mjs)["']?/.exec(command)?.[1]
    if (!entry) throw new Error(`no MCP entry in: ${command}`)
    expect(existsSync(entry), `MCP entry ${entry}`).toBe(true)
    if (process.env.STYR_APP_EXECUTABLE) expect(entry).toContain('app.asar.unpacked')
    // A stdio server ends when its input does; a missing import fails it before then.
    const result = spawnSync(process.execPath, [entry], {
      input: '',
      encoding: 'utf8',
      timeout: 20_000,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '', STYR_HOME: join(home, '.styr') }
    })
    expect(result.stderr, 'MCP server output').not.toMatch(/Cannot find|ERR_MODULE_NOT_FOUND|Error/)
    expect(result.status, 'MCP server exit').toBe(0)
  })

  await test.step('create, edit and move a task; the file follows', async () => {
    await createTask('Smoke task')
    expect(readTask('default', 'TASK-0001')).toMatch(/^title: Smoke task$/m)

    await openTask('Smoke task', 'TASK-0001')
    const dialog = page.getByRole('dialog', { name: 'Smoke task' })
    await dialog.getByLabel('Title').fill('Smoke task edited')
    await dialog.getByLabel('Description (markdown)').fill('Edited by the smoke test.')
    await dialog.getByRole('button', { name: SAVE }).click()
    await expect(dialog).toBeHidden()
    await expect.poll(() => readTask('default', 'TASK-0001')).toMatch(/^title: Smoke task edited$/m)
    expect(readTask('default', 'TASK-0001')).toContain('Edited by the smoke test.')

    // To In Progress through the dialog's status menu, opened the other way: a double-click.
    await card('Smoke task edited').getByText('Smoke task edited', { exact: true }).dblclick()
    const again = page.getByRole('dialog', { name: 'Smoke task edited' })
    await again.getByLabel('Status').selectOption('in_progress')
    await again.getByRole('button', { name: SAVE }).click()
    await expect(again).toBeHidden()
    await expect(column('In Progress').getByText('Smoke task edited')).toBeVisible()
    await expect.poll(() => readTask('default', 'TASK-0001')).toMatch(/^status: in_progress$/m)

    // And on to In Review by dragging the card. It is grabbed at its id (TASK-0001), bottom left:
    // the hover actions cover the title on a narrow card (the board shares a 1024 px window with
    // the Agents panel on the macOS and Windows runners) and swallow the pointer. The board uses
    // `closestCorners`, which averages the four corner distances, so a tall empty column only wins
    // over the card's own slot when the card sits near the column's middle. It is dropped centred
    // in the column.
    const cardBox = await card('Smoke task edited').boundingBox()
    const id = await card('Smoke task edited').getByText('TASK-0001', { exact: true }).boundingBox()
    const to = await column('In Review').locator('> div').boundingBox()
    if (!cardBox || !id || !to) throw new Error('card or column not laid out')
    const grab = { x: id.x + 8, y: id.y + id.height / 2 }
    await page.mouse.move(grab.x, grab.y)
    await page.mouse.down()
    await page.mouse.move(grab.x + 12, grab.y, { steps: 5 })
    await page.mouse.move(
      to.x + (to.width - cardBox.width) / 2 + (grab.x - cardBox.x),
      to.y + (to.height - cardBox.height) / 2 + (grab.y - cardBox.y),
      { steps: 20 }
    )
    // Release only once dnd-kit has seen the card over the column (its screen-reader announcement).
    await expect(page.getByRole('status').filter({ hasText: 'Draggable item' })).toContainText(
      'over droppable area column:in_review'
    )
    await page.mouse.up()
    await expect(column('In Review').getByText('Smoke task edited')).toBeVisible()
    await expect.poll(() => readTask('default', 'TASK-0001')).toMatch(/^status: in_review$/m)
    // dnd-kit swallows every click for 50 ms after a drop (a capture listener on the document).
    // No person clicks that fast; the test does, so it waits that out before the next step.
    await page.waitForTimeout(100)
    expectNoErrors()
  })

  await test.step('a task file written outside the app appears on the board', async () => {
    const now = new Date().toISOString()
    writeFileSync(
      join(workspaceDir('default'), 'tasks', 'TASK-0050-written-externally.md'),
      [
        '---',
        'id: TASK-0050',
        'title: Written externally',
        'status: backlog',
        'agentSession:',
        '  provider: claude',
        '  id: smoke-session',
        `createdAt: '${now}'`,
        `updatedAt: '${now}'`,
        '---',
        'Dropped in by the smoke test, as an editor or `git pull` would.',
        ''
      ].join('\n')
    )
    await expect(column('Backlog').getByText('Written externally')).toBeVisible()
    expectNoErrors()
  })

  await test.step('a plain terminal runs a command and closes', async () => {
    await page.getByRole('button', { name: /^Toggle the terminal panel/ }).click()
    const sessions = (): Promise<string[]> =>
      page.evaluate(async () => (await window.api.terminal.list()).map((session) => session.id))
    const before = await sessions()
    await page.getByRole('button', { name: '+ Shell' }).click()
    await expect.poll(async () => (await sessions()).length).toBe(before.length + 1)
    const id = (await sessions()).find((session) => !before.includes(session))!
    const terminal = page.locator('.xterm').last()
    await expect(terminal).toBeVisible()
    // Typing before the prompt is up can lose keys to the shell's start-up.
    await expect
      .poll(() =>
        page.evaluate(async (id) => (await window.api.terminal.runtimeState(id))?.promptReady, id)
      )
      .toBe(true)
    await terminal.click()
    await page.keyboard.type('echo styr-smoke\n')
    // The output line, not the echoed command: it is alone on its row.
    await expect(
      terminal.locator('.xterm-rows > div').filter({ hasText: /^styr-smoke\s*$/ })
    ).toHaveCount(1)

    const closeTab = page.getByRole('button', { name: /^Close / }).last()
    await closeTab.click()
    await expect.poll(sessions).toEqual(before)
    expectNoErrors()
  })

  await test.step('a second workspace has its own board', async () => {
    const first = await activeWorkspace()
    await page
      .getByRole('button', { name: /Default/ })
      .first()
      .click()
    await page.getByRole('menuitem', { name: /New workspace/ }).click()
    await page.getByPlaceholder('Client A').fill('Smoke B')
    await page.getByRole('button', { name: 'Create workspace' }).click()
    await expect.poll(activeWorkspace).not.toBe(first)
    const second = await activeWorkspace()

    // An empty board, then its own TASK-0001.
    await expect(page.getByText('Smoke task edited')).toHaveCount(0)
    await createTask('Smoke task in B')
    expect(readTask(second, 'TASK-0001')).toMatch(/^title: Smoke task in B$/m)
    expect(readTask(first, 'TASK-0001')).toMatch(/^title: Smoke task edited$/m)

    // Back to the first: its cards, not the second's.
    await page
      .getByRole('button', { name: /Smoke B/ })
      .first()
      .click()
    await page.getByRole('menuitemradio', { name: /Default/ }).click()
    await expect.poll(activeWorkspace).toBe(first)
    await expect(column('In Review').getByText('Smoke task edited')).toBeVisible()
    await expect(page.getByText('Smoke task in B')).toHaveCount(0)
    expectNoErrors()
  })

  await test.step('an agent status record shows in the sidebar', async () => {
    const record = {
      taskId: 'TASK-0050',
      event: 'PreToolUse',
      at: new Date().toISOString(),
      payload: { session_id: 'smoke-session' }
    }
    writeFileSync(
      join(workspaceDir('default'), '.styr', 'agents', 'TASK-0050.json'),
      `${JSON.stringify(record)}\n`
    )
    const sidebar = page.getByRole('complementary')
    const row = sidebar.getByRole('button', { name: /Written externally/ }).first()
    await expect(row).toBeVisible()
    await expect(row).toContainText('Working')
    expectNoErrors()
  })

  await test.step('Settings opens, saves and closes with nothing changed', async () => {
    const before = await page.evaluate(() => window.api.settings.get())
    await page.getByRole('button', { name: /^Settings/ }).click()
    // A bare `Modal`: labelled, but with no dialog role.
    const settings = page.locator('[aria-label="Settings"]')
    await expect(settings).toBeVisible()
    const save = settings.getByRole('button', { name: SAVE })
    await expect(save).toBeDisabled()

    // Save is only enabled with a change, so make one, save it, undo it and save again.
    await settings.getByRole('button', { name: 'Increase Most recent tasks' }).click()
    await save.click()
    await expect(settings.getByText('All changes saved')).toBeVisible()
    await settings.getByRole('button', { name: 'Decrease Most recent tasks' }).click()
    await save.click()
    await expect(settings.getByText('All changes saved')).toBeVisible()

    await settings.getByRole('button', { name: 'Close' }).first().click()
    await expect(settings).toBeHidden()
    expect(await page.evaluate(() => window.api.settings.get())).toEqual(before)
    expectNoErrors()
  })

  await test.step('quits cleanly with no stray processes', async () => {
    // A live shell at quit time, so killing PTYs on the way out is covered too.
    await page.getByRole('button', { name: '+ Shell' }).click()
    await expect
      .poll(() => page.evaluate(async () => (await window.api.terminal.list()).length))
      .toBeGreaterThan(0)
    const tree = processTree(app.process().pid!)
    expect(tree.length).toBeGreaterThan(1)

    const exited = new Promise<number | null>((resolve) => app.process().once('exit', resolve))
    await app.close()
    expect(await exited).toBe(0)
    await expect.poll(() => tree.filter(alive), { timeout: 10_000 }).toEqual([])
    expectNoErrors()
  })
})
