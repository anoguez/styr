import { z } from 'zod'
import {
  globalSettingsFor,
  type BrokenSettingsFile,
  type GlobalSettings,
  type Settings
} from '@core/types.js'
import { RemoteUnavailable, disabledMessage, type Snapshots } from './forwarding.js'
import type { RemoteRegistry } from './registry.js'

/**
 * A remote workspace's settings: its own keys live on the server, the app-level keys (storage,
 * shortcuts, updates, experimental, the active workspace) on this machine, and they never sync —
 * except the External sources switch, which the router pushes to the server (`server:experimental`).
 */

export interface RemoteSettingsPorts {
  /** This machine's settings for the active workspace, as main loads them. */
  load(): Settings
  /** Saves the app-level settings only, as a Save from the dialog would, minus the workspace file. */
  saveGlobalSettings(global: GlobalSettings): void
}

/** Only the shape of a Save: each side validates its own part. */
const SETTINGS_CHANGE = z.object({
  workspaceId: z.string().min(1),
  workspace: z.record(z.string(), z.unknown()),
  global: z.record(z.string(), z.unknown())
})

export function createRemoteSettings(
  registry: RemoteRegistry,
  snapshots: Snapshots,
  ports: RemoteSettingsPorts
) {
  /** `workspaceId`'s settings (the active one by default); `local` is the in-process answer. */
  async function get(
    workspaceId: string | undefined,
    local: () => unknown = ports.load
  ): Promise<Settings> {
    const mine = (await local()) as Settings
    const target = registry.target(workspaceId)
    if (target.kind !== 'remote') return mine
    const stubId = target.workspace.id
    let remote: Settings | undefined
    if (target.host.conn.connected) {
      try {
        remote = (await target.host.conn.request('settings:get', [
          target.link.workspaceId
        ])) as Settings
        snapshots.set(stubId, 'settings:get', [], remote)
      } catch {
        // Fall back to the last one.
      }
    }
    remote ??= snapshots.get(stubId, 'settings:get') as Settings | undefined
    return remote ? { ...remote, ...globalSettingsFor(mine) } : mine
  }

  /**
   * A Save from the dialog: the app-level part is written here, the workspace part on the server,
   * with the server's own app-level settings sent back unchanged.
   */
  async function save(change: unknown, local: () => unknown): Promise<Settings> {
    const parsed = SETTINGS_CHANGE.parse(change) as {
      workspaceId: string
      workspace: Partial<Settings>
      global: GlobalSettings
    }
    const target = registry.target(parsed.workspaceId)
    if (target.kind === 'disabled') throw new Error(disabledMessage(target.workspace))
    if (target.kind === 'local') {
      await local()
      return get(undefined)
    }
    ports.saveGlobalSettings(parsed.global)
    const { conn } = target.host
    if (!conn.connected) {
      throw new RemoteUnavailable(
        `The app settings were saved, but ${target.workspace.name}'s own were not: ${target.link.host} is not connected.`
      )
    }
    const current = (await conn.request('settings:get', [target.link.workspaceId])) as Settings
    await conn.request('settings:save', [
      {
        workspaceId: target.link.workspaceId,
        workspace: parsed.workspace,
        global: globalSettingsFor(current)
      }
    ])
    return get(undefined)
  }

  /** Settings files that do not parse, here and on each connected server (its paths are shown only). */
  async function brokenFiles(local: BrokenSettingsFile[]): Promise<BrokenSettingsFile[]> {
    const merged = local.filter((file) => !registry.links.has(file.workspaceId))
    if (!registry.enabled) return merged
    for (const entry of registry.hosts.values()) {
      if (!entry.conn.connected) continue
      try {
        const files = (await entry.conn.request('settings:brokenFiles')) as BrokenSettingsFile[]
        for (const file of files) {
          const stub = registry.stubFor(entry.host, file.workspaceId)
          if (stub) merged.push({ ...file, workspaceId: stub.id })
        }
      } catch {
        // Settings shows the local files alone.
      }
    }
    return merged
  }

  return { get, save, brokenFiles }
}

export type RemoteSettings = ReturnType<typeof createRemoteSettings>
