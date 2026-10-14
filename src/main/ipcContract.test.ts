import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The preload and the main process agree on channel names only by string. This reads both sides'
// source, so the lists are never hand-maintained and drift in either direction fails here.

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const PRELOAD = join(ROOT, 'src/preload/index.ts')
/** Where main-process code that registers handlers or sends to the renderer may live. */
const MAIN_DIRS = ['src/main', 'src/host', 'src/core'].map((dir) => join(ROOT, dir))

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : []
  })
}

interface Call {
  channel: string
  where: string
}

/** Every `callee('channel'` in `files`, allowing the channel on the next line. */
function calls(files: string[], callee: string): Call[] {
  const pattern = new RegExp(`${callee.replace(/\./g, '\\.')}\\(\\s*(['"\`])([^'"\`]+)\\1`, 'g')
  return files.flatMap((file) => {
    const text = readFileSync(file, 'utf8')
    return [...text.matchAll(pattern)].map((match) => ({
      channel: match[2] ?? '',
      where: `${relative(ROOT, file)}:${text.slice(0, match.index).split('\n').length}`
    }))
  })
}

/** Calls of `callee` whose first argument is not a string literal: the scan cannot see them. */
function dynamicCalls(files: string[], callee: string): string[] {
  const pattern = new RegExp(`${callee.replace(/\./g, '\\.')}\\(\\s*(?!['"\`])[^)\\s]`, 'g')
  return files.flatMap((file) => {
    const text = readFileSync(file, 'utf8')
    return [...text.matchAll(pattern)].map(
      (match) => `${relative(ROOT, file)}:${text.slice(0, match.index).split('\n').length}`
    )
  })
}

const channels = (list: Call[]): string[] => [...new Set(list.map((call) => call.channel))].sort()

const preload = [PRELOAD]
const main = MAIN_DIRS.flatMap(sourceFiles)

const invoked = calls(preload, 'ipcRenderer.invoke')
const sentFromPreload = calls(preload, 'ipcRenderer.send')
const subscribed = calls(preload, 'subscribe')
const handled = calls(main, 'ipcMain.handle')
const listened = calls(main, 'ipcMain.on')
const pushed = [...calls(main, 'broadcast'), ...calls(main, 'webContents.send')]

describe('IPC contract between preload and main', () => {
  it('finds channels on both sides (the scan itself works)', () => {
    expect(invoked.length).toBeGreaterThan(50)
    expect(handled.length).toBeGreaterThan(50)
    expect(subscribed.length).toBeGreaterThan(10)
    expect(pushed.length).toBeGreaterThan(10)
  })

  it('names every channel with a string literal, so this scan sees all of them', () => {
    expect(dynamicCalls(preload, 'ipcRenderer.invoke')).toEqual([])
    expect(dynamicCalls(preload, 'ipcRenderer.send')).toEqual([])
    // The `subscribe` helper is the preload's only listener, and its definition is the one
    // non-literal use of each; every subscription goes through it with a literal.
    expect(dynamicCalls(preload, 'ipcRenderer.on')).toHaveLength(1)
    expect(dynamicCalls(preload, 'subscribe')).toHaveLength(1)
    expect(dynamicCalls(main, 'ipcMain.handle')).toEqual([])
    expect(dynamicCalls(main, 'ipcMain.on')).toEqual([])
  })

  it('has exactly one ipcMain.handle per channel', () => {
    const seen = new Map<string, string[]>()
    for (const call of handled)
      seen.set(call.channel, [...(seen.get(call.channel) ?? []), call.where])
    const duplicates = [...seen].filter(([, where]) => where.length > 1)
    expect(Object.fromEntries(duplicates)).toEqual({})
  })

  it('handles every channel the preload invokes', () => {
    const missing = channels(invoked).filter((channel) => !channels(handled).includes(channel))
    expect(missing).toEqual([])
  })

  it('has a preload caller for every handler', () => {
    const orphaned = handled.filter((call) => !channels(invoked).includes(call.channel))
    expect(orphaned).toEqual([])
  })

  it('listens on every channel the preload sends one-way', () => {
    const missing = channels(sentFromPreload).filter(
      (channel) => !channels(listened).includes(channel)
    )
    expect(missing).toEqual([])
  })

  it('has a preload sender for every ipcMain.on listener', () => {
    const orphaned = listened.filter((call) => !channels(sentFromPreload).includes(call.channel))
    expect(orphaned).toEqual([])
  })

  it('sends every channel the preload subscribes to', () => {
    const silent = channels(subscribed).filter((channel) => !channels(pushed).includes(channel))
    expect(silent).toEqual([])
  })

  it('has a preload subscriber for every channel main sends', () => {
    const unheard = pushed.filter((call) => !channels(subscribed).includes(call.channel))
    expect(unheard).toEqual([])
  })
})
