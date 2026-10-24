import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { card, column, git, launchStyr, readTaskFile, runCommand, type StyrApp } from './harness'

// The features behind the host layer, driven through the built app: a task's changes, landing
// merged work, the Performance panel, the Worklog and a REST source. One app, steps in order, no
// agent CLI and no network (the REST source is served from this process). See
// docs/architecture/testing.md.

test.describe.configure({ mode: 'serial' })

let styr: StyrApp
/** A repository with a bare `origin`, so landing has a remote to fetch. */
let repo: string
let origin: string
let server: Server
let restUrl: string
const restItems = [
  {
    id: 'r-1',
    title: 'From the REST source',
    body: 'Served by the test.',
    url: 'https://example.invalid/r-1'
  },
  { id: 'r-2', title: 'Also from the REST source', body: '', url: 'https://example.invalid/r-2' }
]

test.beforeAll(async () => {
  styr = await launchStyr('features')
  repo = join(styr.home, 'repo')
  origin = join(styr.home, 'origin.git')
  git(styr.home, 'init', '-q', '--bare', '-b', 'main', origin)
  git(styr.home, 'init', '-q', '-b', 'main', repo)
  writeFileSync(join(repo, 'a.txt'), 'one\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-qm', 'init')
  git(repo, 'remote', 'add', 'origin', origin)
  git(repo, 'push', '-q', 'origin', 'main')

  server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(restItems))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  restUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/items`
})

// Playwright reads fixtures from the destructuring; this hook asks for none.
// eslint-disable-next-line no-empty-pattern
test.afterEach(async ({}, testInfo) => {
  await styr.attachOnFailure(testInfo)
})

test.afterAll(async () => {
  await styr?.close()
  server?.close()
})

/** Saves a change to the settings the way the Settings dialog does (one call, both files). */
async function saveSettings(
  change: (settings: Awaited<ReturnType<typeof window.api.settings.get>>) => object
): Promise<void> {
  const settings = await styr.page.evaluate(() => window.api.settings.get())
  const next = { ...settings, ...change(settings) }
  await styr.page.evaluate(
    (next) =>
      window.api.settings.save({
        workspaceId: next.activeWorkspaceId,
        global: next,
        workspace: next
      } as never),
    next
  )
}

/** The worktree Styr would make for a task beside the repository (`worktreeLocation: beside`). */
const worktreeOf = (taskId: string): string => join(`${repo}.worktrees`, taskId)

test("a worktree task's changes show on its card and in the Changes dialog", async () => {
  const { page } = styr
  const task = await page.evaluate(
    (repoPath) => window.api.tasks.create({ title: 'Has changes', repoPath, useWorktree: true }),
    repo
  )
  const worktree = worktreeOf(task.id)
  git(repo, 'worktree', 'add', '-q', '-b', `styr/${task.id}`, worktree)
  writeFileSync(join(worktree, 'a.txt'), 'one\ntwo\n')
  writeFileSync(join(worktree, 'b.txt'), 'new file\n')
  git(worktree, 'add', '.')
  git(worktree, 'commit', '-qm', 'work')
  await page.evaluate(
    ([id, path]) => window.api.tasks.update(id, { worktreePath: path, status: 'in_progress' }),
    [task.id, worktree] as const
  )

  const stat = column(page, 'In Progress').getByRole('button', {
    name: 'View changes: 2 files, +2 −0',
    exact: true
  })
  await expect(stat).toBeVisible()
  await stat.click()

  const dialog = page.getByRole('dialog', { name: 'Changes — Has changes' })
  await expect(dialog).toBeVisible()
  const files = dialog.getByRole('listbox', { name: 'Changed files' })
  await expect(files.getByRole('option')).toHaveCount(2)
  await files.getByRole('option', { name: /a\.txt/ }).click()
  await expect(dialog.getByText('two', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: 'Close' }).click()
  await expect(dialog).toBeHidden()
  styr.expectNoErrors()
})

test('a review comment on a diff line is kept and goes into Request changes', async () => {
  const { page } = styr
  const openChanges = async () => {
    await column(page, 'In Progress')
      .getByRole('button', { name: 'View changes: 2 files, +2 −0', exact: true })
      .click()
    const dialog = page.getByRole('dialog', { name: 'Changes — Has changes' })
    await dialog
      .getByRole('listbox', { name: 'Changed files' })
      .getByRole('option', { name: /a\.txt/ })
      .click()
    await expect(dialog.getByText('two', { exact: true })).toBeVisible()
    return dialog
  }

  let dialog = await openChanges()
  await expect(dialog.getByRole('button', { name: 'Request changes' })).toBeDisabled()
  await dialog.getByTitle('Comment on line 2').click()
  await dialog.getByRole('textbox', { name: 'Comment' }).fill('Say two in capitals')
  // Esc in the composer cancels it, not the dialog.
  await dialog.getByRole('textbox', { name: 'Comment' }).press('Escape')
  await expect(dialog.getByRole('textbox', { name: 'Comment' })).toBeHidden()
  await expect(dialog).toBeVisible()
  await dialog.getByTitle('Comment on line 2').click()
  await dialog.getByRole('textbox', { name: 'Comment' }).fill('Say two in capitals')
  await dialog.getByRole('button', { name: 'Add comment' }).click()
  await expect(dialog.getByText('Pending', { exact: true })).toBeVisible()
  await expect(dialog.getByText('1 pending comment')).toBeVisible()
  const reviewFile = join(styr.storageDir, '.styr', 'reviews', 'TASK-0001.json')
  await expect
    .poll(() => existsSync(reviewFile) && readFileSync(reviewFile, 'utf8'))
    .toContain('Say two in capitals')
  await dialog.getByRole('button', { name: 'Close' }).click()
  await expect(dialog).toBeHidden()

  dialog = await openChanges()
  await expect(dialog.getByText('Say two in capitals')).toBeVisible()
  // The footer's count opens the Comments tab; an entry jumps back to its comment.
  await dialog.getByRole('button', { name: '1 pending comment' }).click()
  const list = dialog.getByRole('list', { name: 'Comments' })
  await list.getByRole('button', { name: /Line 2/ }).click()
  await expect(list.getByRole('button', { name: /Line 2/ })).toHaveAttribute('aria-current', 'true')
  await dialog.getByRole('radio', { name: 'List' }).click()
  await dialog.getByRole('button', { name: 'Request changes' }).click()
  const sheet = page.getByRole('dialog', { name: 'Request changes' })
  await expect(sheet.getByText('Send to Claude on TASK-0001')).toBeVisible()
  await expect(sheet.getByText('Starts the agent with the comments.')).toBeVisible()
  await sheet.getByRole('button', { name: 'What the agent receives' }).click()
  await expect(sheet.locator('pre')).toContainText('- a.txt:2  two\n  Say two in capitals')
  await expect(sheet.getByText('Closes this dialog.')).toBeVisible()
  // A comment's row closes the sheet and shows the comment, still pending.
  await sheet.getByRole('button', { name: /Line 2/ }).click()
  await expect(sheet).toBeHidden()
  await expect(dialog.getByText('Pending', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: 'Request changes' }).click()
  await expect(sheet).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(sheet).toBeHidden()
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Close' }).click()
  await expect(dialog).toBeHidden()
  styr.expectNoErrors()
})

test('work merged on the host moves the task to Done and removes its worktree', async () => {
  const { page } = styr
  await page.evaluate(() => window.api.tasks.update('TASK-0001', { status: 'in_review' }))
  await expect(column(page, 'In Review').getByText('Has changes')).toBeVisible()

  // The PR merges on the host: the branch lands on origin's main, not on the local one.
  git(repo, 'push', '-q', 'origin', 'styr/TASK-0001:main')
  await runCommand(page, 'Check for merged work')

  await expect(column(page, 'Done').getByText('Has changes')).toBeVisible()
  const file = readTaskFile(styr.storageDir, 'TASK-0001')
  expect(file).toMatch(/^status: done$/m)
  expect(file).toContain('Work landed on main; moved to done.')
  await expect.poll(() => existsSync(worktreeOf('TASK-0001'))).toBe(false)
  expect(git(repo, 'branch', '--list', 'styr/TASK-0001')).toBe('')
  styr.expectNoErrors()
})

test('the Performance panel samples the app', async () => {
  const { page } = styr
  await runCommand(page, 'Show performance')
  await expect(page.getByRole('heading', { name: 'Performance' })).toBeVisible()
  const report = page.locator('pre').filter({ hasText: 'Task change handling' })
  await expect(report).toContainText(/Task change handling \(last \d+\): median \d+ ms/)
  await expect(report).toContainText('Tasks 1 · open terminals 0')
  await expect(report).toContainText('Processes')
  // The header's ✕ is also named Close; the footer's button comes last.
  await page.getByRole('button', { name: 'Close', exact: true }).last().click()
  await expect(page.getByRole('heading', { name: 'Performance' })).toBeHidden()
  styr.expectNoErrors()
})

test("the Worklog lists a task's agent sessions in the period", async () => {
  const { page } = styr
  await saveSettings((settings) => ({
    experimental: { ...settings.experimental, worklog: true }
  }))
  const now = new Date().toISOString()
  mkdirSync(join(styr.storageDir, 'tasks'), { recursive: true })
  writeFileSync(
    join(styr.storageDir, 'tasks', 'TASK-0040-worked-on.md'),
    [
      '---',
      'id: TASK-0040',
      'title: Worked on',
      'status: in_progress',
      'sessions:',
      '  - id: e2e-session',
      '    provider: claude',
      `    startedAt: '${now}'`,
      '    label: Implement the task',
      `createdAt: '${now}'`,
      `updatedAt: '${now}'`,
      '---',
      'A session whose transcript is gone still counts, with no tokens.',
      ''
    ].join('\n')
  )
  await expect(column(page, 'In Progress').getByText('Worked on')).toBeVisible()

  await page.getByRole('tab', { name: 'Worklog' }).click()
  // The table's row for the task carries its title as a tooltip; a task without sessions has none.
  await expect(page.getByTitle('Worked on', { exact: true })).toBeVisible()
  await expect(page.getByTitle('Has changes', { exact: true })).toHaveCount(0)
  await page.getByRole('tab', { name: /^Board/ }).click()
  await expect(column(page, 'In Progress').getByText('Worked on')).toBeVisible()
  styr.expectNoErrors()
})

test('Quick setup from the palette applies what was chosen', async () => {
  const { page } = styr
  await runCommand(page, 'Quick setup')
  // Reopened after the first run, so it is not the welcome.
  const wizard = page.getByRole('dialog', { name: 'Quick setup' })
  await expect(wizard).toBeVisible()
  // The Default workspace cannot be renamed, so its name is not offered for editing.
  await expect(wizard.getByLabel('Workspace name')).toBeDisabled()

  await wizard.getByRole('button', { name: /Dispatch$/ }).click()
  await wizard.getByRole('button', { name: /^Hands-on/ }).click()
  await wizard.getByRole('button', { name: /Theme$/ }).click()
  await wizard.getByRole('button', { name: 'Midnight' }).click()

  await wizard.getByRole('button', { name: /Review$/ }).click()
  await expect(wizard.getByText('2 changes to Default')).toBeVisible()
  await wizard.getByRole('button', { name: /^Apply/ }).click()
  await expect(wizard).toBeHidden()

  const saved = await page.evaluate(() => window.api.settings.get())
  expect(saved.orchestration).toEqual({ spec: 0, implement: 1, review: 0 })
  expect(saved.autoDispatch).toBe(false)
  expect(saved.theme.base).toBe('#0e1117')
  styr.expectNoErrors()
})

test('closing Quick setup early saves nothing', async () => {
  const { page } = styr
  const before = await page.evaluate(() => window.api.settings.get())
  await runCommand(page, 'Quick setup')
  const wizard = page.getByRole('dialog', { name: 'Quick setup' })
  await wizard.getByRole('button', { name: /Theme$/ }).click()
  await wizard.getByRole('button', { name: 'Plum' }).click()
  // Unsaved changes are named first; the person confirms (warn, don't refuse).
  page.once('dialog', (dialog) => void dialog.accept())
  await wizard.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(wizard).toBeHidden()
  const after = await page.evaluate(() => window.api.settings.get())
  expect(after.theme).toEqual(before.theme)
  styr.expectNoErrors()
})

test('REST sources are tested, previewed and imported only with the flag on', async () => {
  const { page } = styr
  const rest = {
    request: { method: 'GET', url: restUrl, headers: [], body: '' },
    mapping: {
      items: '',
      id: 'id',
      title: 'title',
      body: 'body',
      url: 'url',
      state: '',
      closedValues: ['closed', 'done'],
      updatedAt: '',
      labels: ''
    }
  }
  const refused = await page.evaluate(
    (rest) =>
      window.api.sources.restTest(rest as never).then(
        () => '',
        (error: Error) => error.message
      ),
    rest
  )
  expect(refused).toContain('Turn on External sources')

  await saveSettings((settings) => ({
    experimental: { ...settings.experimental, externalSources: true },
    sources: [
      {
        id: 'rest',
        provider: 'rest',
        access: 'read',
        enabled: true,
        pollMinutes: 0,
        labels: [],
        includeClosed: false,
        mirrorStatus: false,
        commentOnReview: false,
        rest
      },
      // a second endpoint, linked on its own: what one imports, the other still offers
      {
        id: 'rest-two',
        provider: 'rest',
        name: 'Second API',
        access: 'read',
        enabled: true,
        pollMinutes: 0,
        labels: [],
        includeClosed: false,
        mirrorStatus: false,
        commentOnReview: false,
        rest
      }
    ]
  }))

  const tested = await page.evaluate((rest) => window.api.sources.restTest(rest as never), rest)
  expect(tested).toMatchObject({ status: 200, total: 2 })

  const preview = await page.evaluate(() => window.api.sources.preview('rest'))
  expect(preview.error).toBeUndefined()
  expect(preview.entries.map((entry) => [entry.itemId, entry.kind])).toEqual([
    ['r-1', 'create'],
    ['r-2', 'create']
  ])
  // Nothing is written by a preview.
  await expect(page.getByText('From the REST source', { exact: true })).toHaveCount(0)

  const applied = await page.evaluate(() => window.api.sources.apply('rest', ['r-1']))
  expect(applied).toMatchObject({ syncing: false, created: 1 })
  expect(applied.error).toBeUndefined()
  await expect(column(page, 'Backlog').getByText('From the REST source')).toBeVisible()
  await expect(page.getByText('Also from the REST source', { exact: true })).toHaveCount(0)
  await expect(card(page, 'From the REST source')).toBeVisible()
  const other = await page.evaluate(() => window.api.sources.preview('rest-two'))
  expect(other.entries.map((entry) => [entry.itemId, entry.kind])).toEqual([
    ['r-1', 'create'],
    ['r-2', 'create']
  ])

  // Settings lists both, each with its own editor.
  await page.getByRole('button', { name: /^Settings/ }).click()
  const settings = page.locator('[aria-label="Settings"]')
  await settings.getByRole('button', { name: 'REST API', exact: true }).first().click()
  await settings.getByRole('button', { name: /^Second API/ }).click()
  await expect(settings.getByRole('textbox', { name: 'Source name' })).toHaveValue('Second API')
  await settings.getByRole('button', { name: 'Send test request' }).click()
  await page.waitForTimeout(800)
  await settings.getByRole('button', { name: 'New REST API' }).first().click()
  await settings.getByRole('button', { name: 'Close' }).first().click()
  await expect(settings).toBeHidden()
  // The refused test above fails its handler on purpose.
  styr.expectNoErrors(/sources:restTest/)
})
