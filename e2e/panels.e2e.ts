import { rmSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import { launchStyr, runCommand, type StyrApp } from './harness'

// The terminal panel and agents sidebar move to another edge by dragging their header, resize by their edge,
// and come back where they were left after a relaunch (docs/architecture/ui.md, Panel layout).

let styr: StyrApp | undefined

// Playwright reads fixtures from the destructuring; this hook asks for none.
// eslint-disable-next-line no-empty-pattern
test.afterEach(async ({}, testInfo) => {
  await styr?.attachOnFailure(testInfo)
})

test.afterAll(async () => {
  await styr?.close()
})

/** The box the terminal panel is drawn in (the grid area `PanelGrid` sizes). */
async function terminalBox(page: Page): Promise<{ x: number; y: number; w: number; h: number }> {
  const box = await page.locator('[data-terminal-panel]').boundingBox()
  if (!box) throw new Error('the terminal panel is not on screen')
  return { x: box.x, y: box.y, w: box.width, h: box.height }
}

test('a panel moves to an edge by its header, resizes, and stays there after a relaunch', async () => {
  styr = await launchStyr('panels', {}, { keepHome: true })
  const { home } = styr
  let page = styr.page
  const viewport = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }))

  await page.getByRole('button', { name: /^Toggle the terminal panel/ }).click()
  await expect(page.locator('[data-terminal-panel]')).toBeVisible()
  // At the bottom by default: as wide as the board.
  let box = await terminalBox(page)
  expect(box.w).toBeGreaterThan(viewport.w * 0.6)

  // Drag the header, from its empty middle, to the right edge of the window.
  const terminalHeader = page.locator('[data-terminal-panel] header')
  const from = await terminalHeader.boundingBox()
  if (!from) throw new Error('no terminal header')
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(viewport.w - 60, viewport.h / 2, { steps: 8 })
  await expect(page.getByText('Move terminal to the right')).toBeVisible()
  await page.mouse.up()

  // Beside the agents sidebar, which docks outside it on the same edge (its resize handle between).
  box = await terminalBox(page)
  const aside = await page.locator('aside').boundingBox()
  expect(Math.abs(box.x + box.w - (aside?.x ?? 0))).toBeLessThan(8)
  expect(box.w).toBeLessThan(viewport.w * 0.6)
  expect(box.h).toBeGreaterThan(viewport.h * 0.5)

  // Widen it by its edge.
  const handle = page.getByRole('separator', { name: 'Resize the terminal' })
  const edge = await handle.boundingBox()
  if (!edge) throw new Error('no resize handle')
  const before = box.w
  await page.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2)
  await page.mouse.down()
  await page.mouse.move(edge.x - 80, edge.y + edge.height / 2, { steps: 5 })
  await page.mouse.up()
  box = await terminalBox(page)
  expect(Math.round(box.w - before)).toBeGreaterThanOrEqual(70)
  const width = box.w

  // Right-clicking the header opens the menu of edges.
  await terminalHeader.click({ button: 'right', position: { x: 300, y: 20 } })
  await expect(page.getByRole('menuitem', { name: 'Move terminal to the right' })).toBeDisabled()
  await page.keyboard.press('Escape')

  // Dragged by its header to the left; then the agents, moved to the bottom after
  // it, take only the width beside it while the terminal keeps the full height.
  const header = page.getByRole('heading', { name: 'Agents' })
  const strip = await page.locator('[data-terminal-panel] header').boundingBox()
  if (!strip) throw new Error('no terminal header')
  await page.mouse.move(strip.x + strip.width / 2, strip.y + strip.height / 2)
  await page.mouse.down()
  await page.mouse.move(20, viewport.h / 2, { steps: 8 })
  await page.mouse.up()
  box = await terminalBox(page)
  expect(box.x).toBeLessThan(10)
  const agentsHeader = await header.boundingBox()
  if (!agentsHeader) throw new Error('no agents header')
  await page.mouse.move(agentsHeader.x + agentsHeader.width + 30, agentsHeader.y + 4)
  await page.mouse.down()
  await page.mouse.move(viewport.w / 2 + 100, viewport.h - 20, { steps: 8 })
  await page.mouse.up()
  const agents = await page.locator('aside').boundingBox()
  box = await terminalBox(page)
  expect(agents?.x ?? 0).toBeGreaterThan(box.x + box.w)
  expect(box.h).toBeGreaterThan(viewport.h * 0.6)

  // Right-clicking a header opens the same menu; put both back for the relaunch below.
  await page
    .locator('[data-terminal-panel] header')
    .click({ button: 'right', position: { x: 300, y: 20 } })
  await page.getByRole('menuitem', { name: 'Move terminal to the right' }).click()
  await runCommand(page, 'Move agents sidebar to the right')

  // The agents sidebar moves from the palette, outside the terminal (the terminal moved last).
  await runCommand(page, 'Move agents sidebar to the left')
  styr.expectNoErrors()
  await styr.close()

  styr = await launchStyr('panels', {}, { home, keepHome: true })
  page = styr.page
  await page.getByRole('button', { name: /^Toggle the terminal panel/ }).click()
  box = await terminalBox(page)
  expect(box.x + box.w).toBeGreaterThan(viewport.w - 40)
  expect(Math.abs(box.w - width)).toBeLessThan(2)
  const sidebar = await page.getByRole('heading', { name: 'Agents' }).boundingBox()
  expect(sidebar?.x ?? Infinity).toBeLessThan(viewport.w / 3)

  await runCommand(page, 'Reset panel layout')
  box = await terminalBox(page)
  expect(box.w).toBeGreaterThan(viewport.w * 0.6)
  styr.expectNoErrors()
  await styr.close()
  rmSync(home, { recursive: true, force: true })
  styr = undefined
})
