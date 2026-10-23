import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { McpSetupReport } from '@core/types.js'
import { McpSetupNotice, McpSetupView, mcpBadge } from './McpSetup.js'

const report = (
  state: McpSetupReport['state'],
  extra: Partial<McpSetupReport> = {}
): McpSetupReport => ({
  provider: 'claude',
  state,
  expectedEntry: '/new/index.mjs',
  installCommand: 'claude mcp add styr',
  problem: state === 'registered' ? '' : 'a problem',
  ...extra
})

const view = (r: McpSetupReport | null, checking = false): string =>
  renderToStaticMarkup(
    createElement(McpSetupView, { report: r, checking, onRecheck: () => undefined })
  )
const notice = (r: McpSetupReport | null): string =>
  renderToStaticMarkup(
    createElement(McpSetupNotice, { report: r, onOpenSettings: () => undefined })
  )

describe('MCP setup badge', () => {
  it('names each state', () => {
    expect(mcpBadge(report('registered')).label).toBe('Registered')
    expect(mcpBadge(report('missing')).label).toBe('Not set up')
    expect(mcpBadge(report('unknown')).label).toBe('Couldn’t check')
    expect(mcpBadge(report('stale', { registeredEntry: '/old/index.mjs' })).label).toBe(
      'Out of date — points at /old/index.mjs'
    )
  })

  it('shows Re-check, disabled while running, and the remove-first hint for a stale entry', () => {
    expect(view(report('missing'))).toContain('Re-check')
    expect(view(report('missing'), true)).toContain('disabled')
    const stale = view(report('stale', { removeCommand: 'claude mcp remove styr -s user' }))
    expect(stale).toContain('claude mcp remove styr -s user')
  })
})

describe('launch warning', () => {
  it('warns for missing and stale, and stays quiet for registered, unknown and unanswered', () => {
    expect(notice(report('missing'))).toContain('aren’t set up for Claude Code')
    expect(notice(report('stale'))).toContain('out of date')
    expect(notice(report('registered'))).toBe('')
    expect(notice(report('unknown'))).toBe('')
    expect(notice(null)).toBe('')
  })
})
