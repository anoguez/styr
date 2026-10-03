import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { importSettingsModules, writeTestConfig } from './settingsFixture.js'
import { settingsSchema } from './taskSchema.js'
import {
  GLOBAL_SETTING_KEYS,
  WORKSPACE_SETTING_KEYS,
  globalSettingsFor,
  workspaceSettingsFor,
  type Settings,
  type SettingsChange
} from './types.js'

let home: string
let storage: string

async function modules() {
  const config = await importSettingsModules(home)
  const workspaces = await import('./workspaces.js')
  const migration = await import('./settingsMigration.js')
  return { config, workspaces, migration }
}

type Config = Awaited<ReturnType<typeof modules>>['config']

function writeConfig(value: Record<string, unknown>): void {
  writeTestConfig(home, value)
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

/** A Save from the dialog: `workspaceId`'s current settings with `edits` applied. */
function saveFromDialog(config: Config, workspaceId: string, edits: Partial<Settings>): void {
  const next = { ...config.loadSettings(workspaceId), ...edits }
  const change: SettingsChange = {
    workspaceId,
    workspace: workspaceSettingsFor(next),
    global: globalSettingsFor(next)
  }
  config.persistSettings(change)
}

function createWorkspace(
  { config, workspaces }: Awaited<ReturnType<typeof modules>>,
  name: string
): string {
  return workspaces.createWorkspace(config.loadSettings(), name, config.shippedWorkspaceSettings())
    .id
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'styr-config-test-'))
  storage = join(home, 'storage')
  writeConfig({ storageDir: storage })
})

afterEach(() => {
  delete process.env.STYR_HOME
  rmSync(home, { recursive: true, force: true })
})

describe('setting keys', () => {
  it('classifies every settings key as either app-level or workspace, never both', () => {
    const classified = [...GLOBAL_SETTING_KEYS, ...WORKSPACE_SETTING_KEYS]
    expect(new Set(classified).size).toBe(classified.length)
    expect([...classified].sort()).toEqual(Object.keys(settingsSchema.shape).sort())
  })
})

describe('saving settings', () => {
  it('keeps app-level keys in config.json and workspace keys in the workspace folder', async () => {
    const { config } = await modules()
    saveFromDialog(config, 'default', { shell: '/bin/fish' })

    const appConfig = readJson(join(home, 'config', 'config.json'))
    expect(Object.keys(appConfig).sort()).toEqual([...GLOBAL_SETTING_KEYS].sort())
    const own = readJson(join(storage, 'settings.json'))
    expect(own.shell).toBe('/bin/fish')
    expect(own.storageDir).toBeUndefined()
  })

  it('saves a background workspace without touching the active one', async () => {
    const loaded = await modules()
    const { config } = loaded
    const a = createWorkspace(loaded, 'A')
    const b = createWorkspace(loaded, 'B')

    saveFromDialog(config, b, { claudeCommand: 'claude-b' })

    expect(config.loadSettings(b).claudeCommand).toBe('claude-b')
    expect(config.loadSettings(a).claudeCommand).toBe('claude')
    expect(config.loadSettings().claudeCommand).toBe('claude')
    expect(config.loadSettings().activeWorkspaceId).toBe('default')
  })

  it('keeps the active workspace from disk, whatever a stale dialog sends', async () => {
    const loaded = await modules()
    const other = createWorkspace(loaded, 'Other')
    saveFromDialog(loaded.config, 'default', { activeWorkspaceId: other })
    expect(loaded.config.loadSettings().activeWorkspaceId).toBe('default')
  })

  it('refuses a workspace that does not exist', async () => {
    const { config } = await modules()
    expect(() => saveFromDialog(config, 'gone', { shell: '/bin/fish' })).toThrow('does not exist')
  })
})

describe('moving the storage folder in the same save', () => {
  it('writes the workspace edits into the new folder, so they follow the move', async () => {
    const { config } = await modules()
    saveFromDialog(config, 'default', { shell: '/bin/fish' })
    const moved = join(home, 'moved')

    saveFromDialog(config, 'default', { storageDir: moved, claudeCommand: 'claude-moved' })

    expect(config.loadSettings().storageDir).toBe(moved)
    expect(config.loadSettings().claudeCommand).toBe('claude-moved')
    expect(config.loadSettings().shell).toBe('/bin/fish')
  })

  it('gives a new folder a copy of Default when a background workspace is saved', async () => {
    const { config } = await modules()
    saveFromDialog(config, 'default', { shell: '/bin/fish' })
    const moved = join(home, 'moved')
    mkdirSync(join(moved, 'workspaces', 'client'), { recursive: true })

    saveFromDialog(config, 'client', { storageDir: moved, shell: '/bin/client' })

    expect(readJson(join(moved, 'settings.json')).shell).toBe('/bin/fish')
    expect(config.loadSettings('client').shell).toBe('/bin/client')
  })

  it('refuses before writing anything when the target is not in the new folder', async () => {
    const loaded = await modules()
    const { config } = loaded
    const onlyHere = createWorkspace(loaded, 'Only here')
    const moved = join(home, 'moved')

    expect(() =>
      saveFromDialog(config, onlyHere, { storageDir: moved, shell: '/bin/fish' })
    ).toThrow('does not exist')
    expect(config.loadSettings().storageDir).toBe(storage)
    expect(existsSync(moved)).toBe(false)
  })
})

describe('workspace settings files', () => {
  it('seeds a new workspace with a copy, so later edits to the source do not leak', async () => {
    const { config, workspaces } = await modules()
    saveFromDialog(config, 'default', { shell: '/bin/fish' })
    const settings = config.loadSettings()
    const created = workspaces.createWorkspace(settings, 'Copy', workspaceSettingsFor(settings))

    saveFromDialog(config, 'default', { shell: '/bin/bash' })

    expect(config.loadSettings(created.id).shell).toBe('/bin/fish')
  })

  it('runs a workspace without a file on the shipped settings, not on Default’s', async () => {
    const { config } = await modules()
    saveFromDialog(config, 'default', { shell: '/bin/fish' })
    mkdirSync(join(storage, 'workspaces', 'bare'), { recursive: true })

    expect(config.loadSettings('bare').shell).toBe(config.shippedWorkspaceSettings().shell)
  })

  it('resolves the pinned workspace’s settings, as the MCP server and background writes need', async () => {
    const loaded = await modules()
    const { config } = loaded
    const pinned = createWorkspace(loaded, 'Pinned')
    saveFromDialog(config, pinned, { defaultProvider: 'codex', enabledProviders: ['codex'] })

    config.pinWorkspace(pinned)
    expect(config.loadSettings().activeWorkspaceId).toBe(pinned)
    expect(config.loadSettings().defaultProvider).toBe('codex')
    config.pinWorkspace(undefined)
    expect(config.loadSettings().defaultProvider).toBe('claude')
  })

  it('takes no app-level keys from a hand-edited workspace file', async () => {
    const { config } = await modules()
    mkdirSync(storage, { recursive: true })
    writeFileSync(
      join(storage, 'settings.json'),
      JSON.stringify({ storageDir: '/elsewhere', shell: '/bin/fish' })
    )
    expect(config.loadSettings().storageDir).toBe(storage)
    expect(config.loadSettings().shell).toBe('/bin/fish')
  })
})

describe('broken settings files', () => {
  it('leaves other workspaces alone when Default’s file is broken', async () => {
    const loaded = await modules()
    const { config } = loaded
    const healthy = createWorkspace(loaded, 'Healthy')
    saveFromDialog(config, healthy, { shell: '/bin/healthy' })
    writeFileSync(join(storage, 'settings.json'), JSON.stringify({ enabledProviders: [] }))

    expect(config.isSettingsFileBroken(config.loadSettings(), 'default')).toBe(true)
    expect(config.loadSettings().enabledProviders).toEqual(['claude'])
    expect(config.isSettingsFileBroken(config.loadSettings(), healthy)).toBe(false)
    expect(config.loadSettings(healthy).shell).toBe('/bin/healthy')
  })

  it('keeps the valid keys of a file that fails validation, and still reports it', async () => {
    const { config } = await modules()
    mkdirSync(storage, { recursive: true })
    writeFileSync(
      join(storage, 'settings.json'),
      JSON.stringify({ enabledProviders: [], shell: '/bin/fish' })
    )

    expect(config.isSettingsFileBroken(config.loadSettings(), 'default')).toBe(true)
    expect(config.loadSettings().shell).toBe('/bin/fish')
    expect(config.loadSettings().enabledProviders).toEqual(['claude'])
  })

  it('keeps a copy of a broken file before a save overwrites it', async () => {
    const { config } = await modules()
    mkdirSync(storage, { recursive: true })
    const broken = '{ "shell": "/bin/fish", oops'
    writeFileSync(join(storage, 'settings.json'), broken)

    saveFromDialog(config, 'default', { claudeCommand: 'claude-fixed' })

    expect(readFileSync(join(storage, 'settings.json.bak'), 'utf8')).toBe(broken)
    expect(config.isSettingsFileBroken(config.loadSettings(), 'default')).toBe(false)
    expect(config.loadSettings().claudeCommand).toBe('claude-fixed')
  })
})

describe('migrating a config from before workspace settings', () => {
  const legacyConfig = (): Record<string, unknown> => ({
    storageDir: storage,
    shell: '/bin/legacy',
    claudeCommand: 'my-claude'
  })

  it('reads the legacy values until the migration has run', async () => {
    writeConfig(legacyConfig())
    const { config } = await modules()
    expect(config.loadSettings().claudeCommand).toBe('my-claude')
  })

  it('gives every existing workspace the legacy values, then strips the config', async () => {
    writeConfig(legacyConfig())
    mkdirSync(join(storage, 'workspaces', 'client'), { recursive: true })
    const { config, migration } = await modules()

    migration.migrateLegacySettings()

    const appConfig = readJson(join(home, 'config', 'config.json'))
    expect(appConfig.claudeCommand).toBeUndefined()
    expect(appConfig.storageDir).toBe(storage)
    expect(config.loadSettings().claudeCommand).toBe('my-claude')
    expect(config.loadSettings('client').claudeCommand).toBe('my-claude')
    expect(readJson(join(storage, 'workspaces', 'client', 'settings.json')).shell).toBe(
      '/bin/legacy'
    )
  })

  it('never overwrites a workspace that already has a file, and is safe to run again', async () => {
    writeConfig(legacyConfig())
    mkdirSync(join(storage, 'workspaces', 'client'), { recursive: true })
    writeFileSync(
      join(storage, 'workspaces', 'client', 'settings.json'),
      JSON.stringify({ shell: '/bin/client' })
    )
    const { config, migration } = await modules()

    migration.migrateLegacySettings()
    migration.migrateLegacySettings()

    expect(config.loadSettings('client').shell).toBe('/bin/client')
    expect(config.loadSettings().shell).toBe('/bin/legacy')
  })

  it('keeps the legacy values in the config when a workspace file cannot be written', async () => {
    const blocked = join(home, 'not-a-folder')
    writeFileSync(blocked, '')
    writeConfig({ ...legacyConfig(), storageDir: blocked })
    const { config, migration } = await modules()

    expect(() => migration.migrateLegacySettings()).toThrow()

    expect(readJson(join(home, 'config', 'config.json')).claudeCommand).toBe('my-claude')
    expect(config.loadSettings().claudeCommand).toBe('my-claude')
  })

  it('leaves a legacy config that fails validation exactly as it is', async () => {
    const before = JSON.stringify({ ...legacyConfig(), enabledProviders: [] })
    mkdirSync(join(home, 'config'), { recursive: true })
    writeFileSync(join(home, 'config', 'config.json'), before)
    const { migration } = await modules()

    migration.migrateLegacySettings()

    expect(readFileSync(join(home, 'config', 'config.json'), 'utf8')).toBe(before)
    expect(existsSync(join(storage, 'settings.json'))).toBe(false)
  })

  it('keeps legacy keys when app-level settings are saved before the migration', async () => {
    writeConfig(legacyConfig())
    const { config } = await modules()

    config.saveGlobalSettings({
      ...globalSettingsFor(config.loadSettings()),
      updates: { checkAutomatically: false }
    })

    expect(readJson(join(home, 'config', 'config.json')).claudeCommand).toBe('my-claude')
  })
})

describe('settings cache', () => {
  /** Counts merged parses; the schema must be the instance config.js loaded after `modules()`. */
  async function countParses(): Promise<ReturnType<typeof vi.spyOn>> {
    const { settingsSchema: loadedSchema } = await import('./taskSchema.js')
    return vi.spyOn(loadedSchema, 'safeParse')
  }

  it('reads and parses nothing again while no file changes', async () => {
    const { config } = await modules()
    saveFromDialog(config, 'default', { shell: '/bin/fish' })
    config.loadSettings()
    const parses = await countParses()

    expect(config.loadSettings().shell).toBe('/bin/fish')
    expect(config.isSettingsFileBroken(config.loadSettings(), 'default')).toBe(false)
    expect(parses).not.toHaveBeenCalled()

    writeFileSync(join(storage, 'settings.json'), JSON.stringify({ shell: '/bin/zsh' }))
    config.loadSettings()
    expect(parses).toHaveBeenCalled()
  })

  it('picks up an edit made by another process', async () => {
    const { config } = await modules()
    saveFromDialog(config, 'default', { shell: '/bin/fish' })
    expect(config.loadSettings().shell).toBe('/bin/fish')

    writeFileSync(join(storage, 'settings.json'), JSON.stringify({ shell: '/bin/zsh' }))

    expect(config.loadSettings().shell).toBe('/bin/zsh')
  })

  it('sees its own save on the very next read', async () => {
    const { config } = await modules()
    expect(config.loadSettings().claudeCommand).toBe('claude')
    saveFromDialog(config, 'default', { claudeCommand: 'claude-next' })
    expect(config.loadSettings().claudeCommand).toBe('claude-next')
  })

  it('follows the pin each time it changes', async () => {
    const loaded = await modules()
    const { config } = loaded
    const pinned = createWorkspace(loaded, 'Pinned')
    saveFromDialog(config, pinned, { shell: '/bin/pinned' })

    config.pinWorkspace(pinned)
    expect(config.loadSettings().shell).toBe('/bin/pinned')
    config.pinWorkspace(undefined)
    expect(config.loadSettings().shell).not.toBe('/bin/pinned')
    config.pinWorkspace(pinned)
    expect(config.loadSettings().shell).toBe('/bin/pinned')
    config.pinWorkspace(undefined)
  })

  it('falls back to Default once a cached workspace’s folder is deleted', async () => {
    const loaded = await modules()
    const { config } = loaded
    const gone = createWorkspace(loaded, 'Gone')
    expect(config.loadSettings(gone).activeWorkspaceId).toBe(gone)

    rmSync(join(storage, 'workspaces', gone), { recursive: true, force: true })

    expect(config.loadSettings(gone).activeWorkspaceId).toBe('default')
  })

  it('hands out settings that cannot be changed in place', async () => {
    const { config } = await modules()
    const settings = config.loadSettings()
    expect(() => {
      settings.promptTemplates.push({ id: 'x', name: 'x', template: 'x' })
    }).toThrow()
  })
})

describe('settings file version', () => {
  it('writes the version into every workspace file it saves', async () => {
    const loaded = await modules()
    const created = createWorkspace(loaded, 'Versioned')
    saveFromDialog(loaded.config, 'default', { shell: '/bin/fish' })

    expect(readJson(join(storage, 'settings.json')).version).toBe(1)
    expect(readJson(join(storage, 'workspaces', created, 'settings.json')).version).toBe(1)
  })

  it('loads a file written without a version', async () => {
    const { config } = await modules()
    mkdirSync(storage, { recursive: true })
    writeFileSync(join(storage, 'settings.json'), JSON.stringify({ shell: '/bin/fish' }))

    expect(config.isSettingsFileBroken(config.loadSettings(), 'default')).toBe(false)
    expect(config.loadSettings().shell).toBe('/bin/fish')
  })
})
