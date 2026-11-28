import { describe, expect, it } from 'vitest'
import { detachedAction, detachedSessionId } from './detachedWindow.js'

describe('detachedSessionId', () => {
  it('reads the session from the hash', () => {
    expect(detachedSessionId('#detached=abc123')).toBe('abc123')
    expect(detachedSessionId('detached=r%3Ahost%2Fid')).toBe('r:host/id')
  })

  it('is null in the main window or for a broken hash', () => {
    expect(detachedSessionId('')).toBeNull()
    expect(detachedSessionId('#other')).toBeNull()
    expect(detachedSessionId('#detached=')).toBeNull()
    expect(detachedSessionId('#detached=%E0%A4%A')).toBeNull()
  })
})

describe('detachedAction', () => {
  it('docks on the detach toggle and closes on close tab', () => {
    expect(detachedAction('terminalDetach')).toBe('dock')
    expect(detachedAction('closeShell')).toBe('close')
  })

  it('hands terminal commands to the terminal and ignores the board', () => {
    expect(detachedAction('terminalCopyOutput')).toEqual({ terminal: 'terminalCopyOutput' })
    expect(detachedAction('newTask')).toBeNull()
    expect(detachedAction('terminalTab1')).toBeNull()
    expect(detachedAction(null)).toBeNull()
  })
})
