import { execSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  clearAgentStatus,
  readAgentStatus,
  readSubagents,
  recordAgentEvent,
  recordSubagentEvent,
  statusFilePath,
  subagentsDir
} from './agentStore.js'
import { buildHookSettings } from './providers/claude.js'
import type { Settings } from './types.js'

let dir: string
let settings: Settings

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'styr-agent-store-test-'))
  settings = { storageDir: dir, activeWorkspaceId: 'default' } as Settings
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

function write(event: string, payload: Record<string, unknown> | null): void {
  const record = { taskId: 'TASK-0001', event, at: '2026-01-01T00:00:00Z', payload }
  writeFileSync(statusFilePath(settings, 'TASK-0001'), JSON.stringify(record))
}

describe('readAgentStatus', () => {
  it('reads an idle-prompt notification as idle, not waiting', () => {
    write('Notification', { notification_type: 'idle_prompt', message: 'whatever' })
    expect(readAgentStatus(settings, 'TASK-0001')?.state).toBe('idle')
  })

  it('recognises the idle prompt by its message when the type is missing', () => {
    write('Notification', { message: 'Claude is waiting for your input' })
    expect(readAgentStatus(settings, 'TASK-0001')?.state).toBe('idle')
  })

  it('still reads a permission prompt as waiting', () => {
    write('Notification', { notification_type: 'permission_prompt', message: 'Allow Bash?' })
    expect(readAgentStatus(settings, 'TASK-0001')?.state).toBe('waiting')
    write('Notification', null)
    expect(readAgentStatus(settings, 'TASK-0001')?.state).toBe('waiting')
  })
})

describe('buildHookSettings', () => {
  it('hooks only the notifications that need you', () => {
    const { hooks } = JSON.parse(buildHookSettings(settings, 'TASK-0001'))
    expect(hooks.Notification[0].matcher).toBe('permission_prompt|elicitation_dialog')
    expect(hooks.Stop[0].matcher).toBeUndefined()
  })
})

describe('subagents', () => {
  let order = 0

  /** One event file, written in order: the fold sorts by mtime, so each gets a later one. */
  function event(event: string, payload: Record<string, unknown> | null): void {
    const dir = subagentsDir(settings, 'TASK-0001')
    mkdirSync(dir, { recursive: true })
    order += 1
    const file = join(dir, `${order}-${event}.json`)
    const record = { taskId: 'TASK-0001', event, at: `2026-01-01T00:00:${order}Z`, payload }
    writeFileSync(file, JSON.stringify(record))
    const time = new Date(Date.UTC(2026, 0, 1, 0, 0, order))
    utimesSync(file, time, time)
  }
  const start = (id: string, type = 'Explore', extra = {}) =>
    event('SubagentStart', { agent_id: id, agent_type: type, ...extra })
  const stop = (id: string, message?: string) =>
    event('SubagentStop', { agent_id: id, agent_type: 'Explore', last_assistant_message: message })
  const turn = (prompt = 'next thing') => event('UserPromptSubmit', { prompt })
  const fold = () => readSubagents(settings, 'TASK-0001')

  beforeEach(() => {
    order = 0
  })

  it('pairs starts and stops by id, oldest first', () => {
    start('a')
    start('b', 'Plan')
    stop('a', 'Found 3 files')
    expect(fold()).toMatchObject([
      { id: 'a', label: 'Explore', state: 'done', lastMessage: 'Found 3 files' },
      { id: 'b', label: 'Plan', state: 'running' }
    ])
  })

  it('attaches subagents to the parent status, and leaves them off when there are none', () => {
    write('PreToolUse', null)
    expect(readAgentStatus(settings, 'TASK-0001')?.subagents).toBeUndefined()
    start('a')
    expect(readAgentStatus(settings, 'TASK-0001')?.subagents).toHaveLength(1)
    expect(readAgentStatus(settings, 'TASK-0001', { subagents: false })?.subagents).toBeUndefined()
  })

  it('clears done rows on your next turn, keeps running ones and deletes the spent files', () => {
    start('a')
    start('b')
    stop('a', 'done')
    turn()
    expect(fold().map((subagent) => subagent.id)).toEqual(['b'])
    expect(readdirSync(subagentsDir(settings, 'TASK-0001'))).toHaveLength(2)
  })

  it('keeps a background subagent that wakes the parent with a task notification', () => {
    start('a')
    turn('first')
    stop('a', 'slow check finished')
    turn('<task-notification>\n<task-id>a</task-id>')
    expect(fold()).toMatchObject([{ id: 'a', state: 'done' }])
  })

  it('labels a Claude subagent by its Agent-tool description when the meta file is there', () => {
    const transcript = join(dir, 'session.jsonl')
    mkdirSync(join(dir, 'session', 'subagents'), { recursive: true })
    writeFileSync(
      join(dir, 'session', 'subagents', 'agent-a.meta.json'),
      JSON.stringify({ agentType: 'Explore', description: 'Find auth handlers' })
    )
    start('a', 'Explore', { transcript_path: transcript })
    start('b', 'Explore', { transcript_path: transcript })
    start('c', '', { label: 'Juniper' })
    start('d', '')
    expect(fold().map((subagent) => subagent.label)).toEqual([
      'Find auth handlers',
      'Explore',
      'Juniper',
      'Subagent'
    ])
  })

  it('drops a foreground subagent left running by an interrupted turn, but not a background one', () => {
    const transcript = join(dir, 'session.jsonl')
    mkdirSync(join(dir, 'session', 'subagents'), { recursive: true })
    const meta = (id: string, requestShape: string) =>
      writeFileSync(
        join(dir, 'session', 'subagents', `agent-${id}.meta.json`),
        JSON.stringify({ agentType: 'Explore', requestShape })
      )
    meta('fg', 'foreground')
    meta('bg', 'background')
    start('fg', 'Explore', { transcript_path: transcript })
    start('bg', 'Explore', { transcript_path: transcript })
    start('unknown', 'Explore')
    expect(fold()).toHaveLength(3)
    turn()
    expect(fold().map((subagent) => subagent.id)).toEqual(['bg', 'unknown'])
  })

  it('skips malformed files and events that are not about a subagent', () => {
    start('a')
    writeFileSync(join(subagentsDir(settings, 'TASK-0001'), 'broken.json'), '{not json')
    event('SubagentStart', null)
    event('PreToolUse', { agent_id: 'a' })
    expect(fold()).toMatchObject([{ id: 'a', state: 'running' }])
  })

  it('reads a subagent that runs again after a stop as running', () => {
    start('a')
    stop('a', 'first pass')
    start('a')
    expect(fold()).toMatchObject([{ id: 'a', state: 'running', endedAt: undefined }])
  })

  it('drops every row when the terminal exits or the status is cleared', () => {
    start('a')
    recordAgentEvent(settings, 'TASK-0001', 'TerminalExit')
    expect(fold()).toEqual([])
    start('b')
    clearAgentStatus(settings, 'TASK-0001')
    expect(fold()).toEqual([])
  })

  it('records an app-observed subagent event the fold reads like a hook one', () => {
    recordSubagentEvent(settings, 'TASK-0001', 'SubagentStart', {
      agent_id: 't1',
      label: 'Juniper'
    })
    expect(fold()).toMatchObject([{ id: 't1', label: 'Juniper', state: 'running' }])
  })
})

describe.skipIf(process.platform === 'win32')('Claude hook commands', () => {
  function runHook(event: string, index: number, payload: object): void {
    const { hooks } = JSON.parse(buildHookSettings(settings, 'TASK-0001'))
    execSync(hooks[event][0].hooks[index].command, {
      input: JSON.stringify(payload),
      shell: '/bin/sh'
    })
  }

  it('writes subagent events to their own folder and leaves the parent status alone', () => {
    runHook('PreToolUse', 0, { session_id: 's' })
    runHook('SubagentStart', 0, { agent_id: 'a', agent_type: 'Explore' })
    runHook('SubagentStart', 0, { agent_id: 'b', agent_type: 'Plan' })
    runHook('SubagentStop', 0, { agent_id: 'a', last_assistant_message: "it's done" })
    expect(readAgentStatus(settings, 'TASK-0001')).toMatchObject({
      state: 'working',
      subagents: [
        { id: 'a', state: 'done', lastMessage: "it's done" },
        { id: 'b', state: 'running' }
      ]
    })
  })

  it('marks your turn in the subagent folder as well as the status file', () => {
    const { hooks } = JSON.parse(buildHookSettings(settings, 'TASK-0001'))
    expect(hooks.UserPromptSubmit[0].hooks).toHaveLength(2)
    runHook('UserPromptSubmit', 1, { prompt: 'go' })
    const names = readdirSync(subagentsDir(settings, 'TASK-0001'))
    expect(names).toHaveLength(1)
    expect(names[0]).toMatch(/^\d+-\d+-UserPromptSubmit\.json$/)
  })
})
