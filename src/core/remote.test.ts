import { describe, expect, it } from 'vitest'
import {
  isValidRemoteHost,
  reconnectDelay,
  remoteAttachCommand,
  remoteEditorFor,
  notificationText,
  remoteEditorUri,
  sshArgs
} from './remote.js'

describe('the ssh command line', () => {
  it('runs ssh in batch mode with a keepalive, and the server’s attach on the host', () => {
    expect(sshArgs({ host: 'devbox', workspaceId: 'default' })).toEqual([
      '-T',
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=10',
      '-o',
      'ServerAliveInterval=15',
      '-o',
      'ServerAliveCountMax=3',
      'devbox',
      '~/.styr/server/current/bin/styr serve attach'
    ])
  })

  it('builds the remote line in POSIX syntax whatever this machine’s shell, keeping the command as typed', () => {
    // A Windows client would quote with PowerShell's call operator; the remote is Linux.
    expect(remoteAttachCommand({ server: '~/.styr/server/current/bin/styr' })).toBe(
      '~/.styr/server/current/bin/styr serve attach'
    )
    expect(remoteAttachCommand({ server: '  ' })).toBe(
      '~/.styr/server/current/bin/styr serve attach'
    )
  })

  it('accepts what ssh takes as a host and nothing it would read as an option', () => {
    for (const host of ['devbox', 'me@100.64.0.2', 'host.tailnet.ts.net', '[fe80::1]', 'a-b']) {
      expect(isValidRemoteHost(host)).toBe(true)
    }
    for (const host of ['-oProxyCommand=x', 'a b', 'a;b', '$(x)', '', 'a`b']) {
      expect(isValidRemoteHost(host)).toBe(false)
    }
    expect(() => sshArgs({ host: '-v', workspaceId: 'default' })).toThrow()
  })
})

describe('reconnectDelay', () => {
  it('doubles from one second and stops at thirty', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 20].map(reconnectDelay)).toEqual([
      1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000
    ])
  })
})

describe('the VS Code Remote link', () => {
  it('opens in VS Code or Cursor, and in nothing else', () => {
    expect(remoteEditorFor('Visual Studio Code')).toBe('vscode')
    expect(
      remoteEditorFor('C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe')
    ).toBe('vscode')
    expect(remoteEditorFor('Cursor')).toBe('cursor')
    expect(remoteEditorFor('TextEdit')).toBeUndefined()
    expect(remoteEditorFor('')).toBeUndefined()
  })

  it('names the host raw and escapes the remote path without resolving it', () => {
    expect(remoteEditorUri('vscode', 'me@devbox', '/home/me/Styr/tasks/TASK-0001 a.md')).toBe(
      'vscode://vscode-remote/ssh-remote+me@devbox/home/me/Styr/tasks/TASK-0001%20a.md'
    )
    expect(remoteEditorUri('cursor', 'devbox', '/srv/repo')).toBe(
      'cursor://vscode-remote/ssh-remote+devbox/srv/repo'
    )
  })

  it('makes any path from the server one link on the host, normalised and escaped', () => {
    const uri = (path: string) => remoteEditorUri('vscode', 'devbox', path)
    expect(uri('../../etc/passwd')).toBe('vscode://vscode-remote/ssh-remote+devbox/etc/passwd')
    expect(uri('/home/me/../../../root/x')).toBe('vscode://vscode-remote/ssh-remote+devbox/root/x')
    expect(uri('javascript:alert(1)')).toBe(
      'vscode://vscode-remote/ssh-remote+devbox/javascript%3Aalert(1)'
    )
    expect(uri('/a?windowId=1#b')).toBe(
      'vscode://vscode-remote/ssh-remote+devbox/a%3FwindowId%3D1%23b'
    )
    expect(uri('//evil.example/x')).toBe('vscode://vscode-remote/ssh-remote+devbox/evil.example/x')
    expect(uri('/x/\u0000\u001b\u202ey')).toBe('vscode://vscode-remote/ssh-remote+devbox/x/y')
    expect(uri('/x/\ud800')).toBe('vscode://vscode-remote/ssh-remote+devbox/x/%EF%BF%BD')
    expect(uri('')).toBe('vscode://vscode-remote/ssh-remote+devbox/')
    expect(() => remoteEditorUri('vscode', '-oProxyCommand=x', '/a')).toThrow(/Not a host/)
  })
})

describe('notificationText', () => {
  it('strips controls and bidi overrides, collapses spaces and cuts to length', () => {
    expect(notificationText(' a\u0007\nb\u202e  c ', 100)).toBe('a b c')
    expect(notificationText('abcdef', 4)).toBe('abc…')
  })
})
