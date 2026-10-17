import { describe, expect, it } from 'vitest'
import { shippedSettings, workspaceDir } from '@core/config.js'
import { globalSettingsFor, workspaceSettingsFor, type Settings } from '@core/types.js'
import { createSettingsService, type SettingsServicePorts } from './settingsService.js'

function harness(persist: () => void = () => {}) {
  const calls: string[] = []
  let settings = {
    ...shippedSettings(),
    activeWorkspaceId: 'default',
    storageDir: '/a'
  } as Settings
  const ports: SettingsServicePorts = {
    store: {
      load: (workspaceId) => {
        calls.push(`load ${workspaceId ?? 'active'}`)
        return settings
      },
      persist: (change) => {
        calls.push(`persist ${change.workspaceId}`)
        persist()
        settings = { ...settings, ...change.global }
      }
    },
    afterSave: (folderBefore, workspaceId) =>
      calls.push(`afterSave ${folderBefore} ${workspaceId}`),
    autoRunFlagChanged: () => calls.push('autoRunFlagChanged'),
    mcpEntry: () => '/app/mcp.mjs'
  }
  return { calls, service: createSettingsService(ports), settings: () => settings }
}

const change = (settings: Settings) => ({
  workspaceId: 'default',
  global: { ...globalSettingsFor(settings), storageDir: '/b' },
  workspace: workspaceSettingsFor(settings)
})

describe('settingsService', () => {
  it("loads a workspace's settings, or the active one's", () => {
    const { calls, service } = harness()
    service.get('ws-2')
    service.get(undefined)
    expect(calls).toEqual(['load ws-2', 'load active'])
    expect(() => service.get('')).toThrow()
  })

  it('saves, then lets the workspaces and Auto-run catch up, then answers the saved settings', () => {
    const { calls, service, settings } = harness()
    const before = workspaceDir(settings())
    const saved = service.save(change(settings()))
    expect(saved.storageDir).toBe('/b')
    expect(calls).toEqual([
      'load active',
      'persist default',
      `afterSave ${before} default`,
      'autoRunFlagChanged',
      'load active'
    ])
  })

  it('catches up even when the write fails', () => {
    const { calls, service, settings } = harness(() => {
      throw new Error('disk full')
    })
    expect(() => service.save(change(settings()))).toThrow('disk full')
    expect(calls.slice(-2)).toEqual([expect.stringMatching(/^afterSave /), 'autoRunFlagChanged'])
  })

  it('refuses a malformed change before writing anything', () => {
    const { calls, service } = harness()
    expect(() => service.save({ workspaceId: 'default' })).toThrow()
    expect(calls).toEqual([])
  })

  it('builds the MCP install command for the provider asked, Claude by default', () => {
    const { service } = harness()
    expect(service.mcpCommand()).toContain('/app/mcp.mjs')
    expect(service.mcpCommand()).toMatch(/claude/)
    expect(service.mcpCommand('codex')).toMatch(/codex/)
  })
})
