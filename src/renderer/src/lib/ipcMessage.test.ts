import { describe, expect, it } from 'vitest'
import { ipcMessage } from './ipcMessage.js'

describe('ipcMessage', () => {
  it("strips Electron's remote-method wrapper", () => {
    expect(
      ipcMessage(new Error("Error invoking remote method 'tasks:launch': Error: Codex is too old"))
    ).toBe('Codex is too old')
    expect(ipcMessage(new Error("Error invoking remote method 'x': plain"))).toBe('plain')
  })

  it('passes other errors and values through', () => {
    expect(ipcMessage(new Error('boom'))).toBe('boom')
    expect(ipcMessage('text')).toBe('text')
  })
})
