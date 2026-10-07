import { dirname, join } from 'node:path'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync
} from 'node:fs'
import {
  configDir,
  isWorkspaceId,
  migrateConfig,
  pinnedWorkspaceId,
  renameStorageDir,
  shippedSettings,
  workspaceDir
} from './config.js'
import { globalSettingsSchema, settingsSchema } from './taskSchema.js'
import {
  DEFAULT_WORKSPACE_ID,
  globalSettingsFor,
  isWorkspaceSettingKey,
  workspaceSettingsFor,
  type GlobalSettings,
  type Settings,
  type SettingsChange,
  type WorkspaceSettings
} from './types.js'

const CONFIG_FILE = join(configDir(), 'config.json')
const WORKSPACE_SETTINGS_FILE = 'settings.json'

/**
 * The shape of a workspace's `settings.json`, written into every file this app saves. A file
 * without it is version 1. Readers drop it with every other key that is not a workspace setting.
 */
const WORKSPACE_SETTINGS_VERSION = 1

function workspaceSettingsFile(settings: Settings, id: string): string {
  return join(workspaceDir(settings, id), WORKSPACE_SETTINGS_FILE)
}

/** Readers never see a half-written file: the content lands under a temporary name first. */
function writeJsonAtomically(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(temp, path)
  forgetCachedSettings()
}

type SettingsFileRead =
  { kind: 'missing' } | { kind: 'unreadable' } | { kind: 'read'; values: Record<string, unknown> }

const MISSING_FILE: SettingsFileRead = { kind: 'missing' }

/** Only a workspace's own keys are taken from its file, so a hand edit cannot move the storage folder. */
function readWorkspaceSettingsFile(path: string): SettingsFileRead {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { kind: 'unreadable' }
    const values = Object.fromEntries(
      Object.entries(raw).filter(([key]) => isWorkspaceSettingKey(key))
    )
    return { kind: 'read', values }
  } catch (error) {
    return isMissingFileError(error) ? MISSING_FILE : { kind: 'unreadable' }
  }
}

function isMissingFileError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
}

function readRawConfig(): Record<string, unknown> {
  try {
    const raw = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as unknown
    return raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

function parseConfig(raw: Record<string, unknown>): Settings | null {
  const parsed = settingsSchema.safeParse({ ...shippedSettings(), ...migrateConfig(raw) })
  return parsed.success ? parsed.data : null
}

/**
 * Names one version of a file without reading it, or `null` when there is no file to read. An
 * atomic save changes the inode, an edit in place the size or the nanosecond mtime.
 */
function fileStampFor(path: string): string | null {
  try {
    const stats = statSync(path, { bigint: true, throwIfNoEntry: false })
    return stats ? `${stats.ino}:${stats.size}:${stats.mtimeNs}` : null
  } catch {
    return null
  }
}

/** Cached settings are shared by every caller, so a caller that modifies one in place throws. */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

interface CachedConfig {
  stamp: string | null
  settings: Settings
}

interface LayeredSettings {
  settings: Settings
  broken: boolean
}

let cachedConfig: CachedConfig | undefined
const cachedLayers = new Map<string, { key: string; layered: LayeredSettings }>()

/** Every write this process makes is visible to its next read, whatever the mtime resolution. */
function forgetCachedSettings(): void {
  cachedConfig = undefined
  cachedLayers.clear()
}

/**
 * The app's own config, parsed again only when the file changes. One written before workspace
 * settings existed still carries every workspace key; those values stay the bottom layer until
 * `migrateLegacySettings` moves them into the workspace files, so a process that reads before the
 * migration still sees them.
 */
function readConfig(): CachedConfig {
  const stamp = fileStampFor(CONFIG_FILE)
  if (cachedConfig && cachedConfig.stamp === stamp) return cachedConfig
  const parsed = stamp === null ? null : parseConfig(readRawConfig())
  cachedConfig = { stamp, settings: deepFreeze(parsed ?? structuredClone(shippedSettings())) }
  return cachedConfig
}

/**
 * A dangling workspace (the folder was removed, the config was hand edited) falls back to Default
 * rather than pointing the board at nothing.
 */
function resolveWorkspaceId(settings: Settings, wanted: string): string {
  const usable =
    isWorkspaceId(wanted) &&
    (wanted === DEFAULT_WORKSPACE_ID || existsSync(workspaceDir(settings, wanted)))
  return usable ? wanted : DEFAULT_WORKSPACE_ID
}

/**
 * The workspace's own file over the config, with the app-level keys laid on top again so no file
 * can override them. A file that cannot be parsed is left out; one that fails validation keeps
 * only the keys that are valid on their own. Either is reported as broken, so the dialog says so
 * and the next save keeps a copy of the file.
 */
function withWorkspaceSettings(
  config: Settings,
  id: string,
  file: SettingsFileRead
): LayeredSettings {
  const pinned = { ...globalSettingsFor(config), activeWorkspaceId: id }
  const fallback = { ...config, ...pinned }
  if (file.kind === 'missing') return { settings: fallback, broken: false }
  if (file.kind === 'unreadable') return { settings: fallback, broken: true }
  const parsed = settingsSchema.safeParse({ ...config, ...file.values, ...pinned })
  if (parsed.success) return { settings: parsed.data, broken: false }
  return { settings: salvagedSettings(fallback, file.values) ?? fallback, broken: true }
}

/**
 * A failing file's values that each validate against `base` on their own, so one bad value does
 * not cost the workspace every good one. `null` when even those fail together.
 */
function salvagedSettings(base: Settings, values: Record<string, unknown>): Settings | null {
  const pinned = globalSettingsFor(base)
  const valid = Object.entries(values).filter(
    ([key, value]) => settingsSchema.safeParse({ ...base, [key]: value, ...pinned }).success
  )
  const parsed = settingsSchema.safeParse({ ...base, ...Object.fromEntries(valid), ...pinned })
  return parsed.success ? parsed.data : null
}

/**
 * `withWorkspaceSettings` for one workspace in one storage folder, recomputed only when the config
 * or the workspace's file changes. Nothing is read or parsed on a hit — `loadSettings` runs on
 * every agent hook event and every task write, and the MCP server on every tool call.
 */
function layeredSettings(storageDir: string, id: string): LayeredSettings {
  const config = readConfig()
  const base =
    storageDir === config.settings.storageDir ? config.settings : { ...config.settings, storageDir }
  const path = workspaceSettingsFile(base, id)
  const fileStamp = fileStampFor(path)
  const key = `${config.stamp}|${fileStamp}`
  const slot = `${storageDir}\0${id}`
  const hit = cachedLayers.get(slot)
  if (hit && hit.key === key) return hit.layered
  const file = fileStamp === null ? MISSING_FILE : readWorkspaceSettingsFile(path)
  const layered = deepFreeze(withWorkspaceSettings(base, id, file))
  cachedLayers.set(slot, { key, layered })
  return layered
}

/**
 * Settings as they apply in one workspace: `workspaceId` when given, otherwise the pinned one,
 * otherwise the saved preference. `activeWorkspaceId` on the result is the workspace resolved,
 * which is not the user's preference when another workspace was asked for. The result is cached
 * and frozen: spread it before changing anything.
 */
export function loadSettings(workspaceId?: string): Settings {
  const config = readConfig().settings
  const wanted = workspaceId ?? pinnedWorkspaceId() ?? config.activeWorkspaceId
  return layeredSettings(config.storageDir, resolveWorkspaceId(config, wanted)).settings
}

/** Whether a workspace's `settings.json` exists but some or all of it cannot be used. */
export function isSettingsFileBroken(settings: Settings, id: string): boolean {
  return layeredSettings(settings.storageDir, id).broken
}

export function settingsFilePath(settings: Settings, id: string): string {
  return workspaceSettingsFile(settings, id)
}

/**
 * Writes the app-level settings. Any other key already in the file is kept: only
 * `migrateLegacySettings` removes the workspace keys an older config carries, and only after they
 * are safe in the workspace files.
 */
export function saveGlobalSettings(global: GlobalSettings): GlobalSettings {
  const parsed = globalSettingsSchema.parse(global)
  writeJsonAtomically(CONFIG_FILE, { ...renameStorageDir(readRawConfig()), ...parsed })
  return parsed
}

/**
 * Writes one workspace's own settings, leaving the app's and every other workspace's untouched. A
 * file that could not be read is copied to `settings.json.bak` first rather than overwritten.
 */
export function saveWorkspaceSettings(settings: Settings, id: string): void {
  if (resolveWorkspaceId(settings, id) !== id) throw new Error('That workspace no longer exists.')
  const parsed = settingsSchema.parse({ ...settings, activeWorkspaceId: id })
  const path = workspaceSettingsFile(parsed, id)
  if (isSettingsFileBroken(parsed, id)) copyFileSync(path, `${path}.bak`)
  writeJsonAtomically(path, {
    version: WORKSPACE_SETTINGS_VERSION,
    ...workspaceSettingsFor(parsed)
  })
}

/** Gives a workspace a settings file of its own unless it already has one. */
export function ensureWorkspaceSettingsFile(
  settings: Settings,
  id: string,
  seed: WorkspaceSettings
): void {
  if (existsSync(workspaceSettingsFile(settings, id))) return
  saveWorkspaceSettings({ ...settings, ...seed }, id)
}

/**
 * The workspace values a config from before workspace settings still carries, or `null` when it
 * carries none — or fails validation, because a config that does not parse must be left exactly as
 * it is rather than migrated as defaults. For `migrateLegacySettings` only.
 */
export function legacyWorkspaceSettings(): WorkspaceSettings | null {
  const raw = readRawConfig()
  if (!Object.keys(raw).some(isWorkspaceSettingKey)) return null
  const parsed = parseConfig(raw)
  return parsed ? workspaceSettingsFor(parsed) : null
}

/** Removes the workspace keys from the config and nothing else. The last step of the migration. */
export function stripLegacyWorkspaceKeys(): void {
  const raw = renameStorageDir(readRawConfig())
  writeJsonAtomically(
    CONFIG_FILE,
    Object.fromEntries(Object.entries(raw).filter(([key]) => !isWorkspaceSettingKey(key)))
  )
}

/**
 * Applies one Save from the Settings dialog, ordered so a failure leaves the app on the folder it
 * was using: the target is looked up in the storage folder being saved and refused before anything
 * is written if it is not there; a new folder without a Default file gets a copy of the current
 * one; then the workspace file; `config.json` last. The active workspace is kept from disk — only
 * a switch changes it, or a stale dialog would undo a workspace created or deleted since.
 */
export function persistSettings(change: SettingsChange): void {
  const current = loadSettings()
  const global = { ...change.global, activeWorkspaceId: current.activeWorkspaceId }
  // Auto-run is switched from the Dispatch dialog, never from a draft: an open dialog must not
  // undo a Stop (or a limit pause) that happened since it was opened.
  const keptAutoDispatch = loadSettings(change.workspaceId).autoDispatch
  const destination = settingsSchema.parse({
    ...current,
    ...change.workspace,
    autoDispatch: keptAutoDispatch,
    ...global
  })
  if (resolveWorkspaceId(destination, change.workspaceId) !== change.workspaceId) {
    throw new Error('That workspace does not exist in the storage folder being saved.')
  }
  if (destination.storageDir !== current.storageDir) {
    ensureWorkspaceSettingsFile(
      destination,
      DEFAULT_WORKSPACE_ID,
      workspaceSettingsFor(loadSettings(DEFAULT_WORKSPACE_ID))
    )
  }
  saveWorkspaceSettings(destination, change.workspaceId)
  saveGlobalSettings(global)
}

export function tasksDir(settings: Settings = loadSettings()): string {
  const dir = join(workspaceDir(settings), 'tasks')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function indexDbPath(settings: Settings = loadSettings()): string {
  const dir = join(workspaceDir(settings), '.styr')
  mkdirSync(dir, { recursive: true })
  return join(dir, 'index.db')
}
