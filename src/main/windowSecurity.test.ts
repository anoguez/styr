import { describe, expect, it } from 'vitest'
import {
  guardNavigation,
  isSameDocument,
  isWebLink,
  openHandler,
  type GuardedContents
} from './windowSecurity.js'

describe('isWebLink', () => {
  it('takes http and https only', () => {
    expect(isWebLink('https://github.com/anoguez/styr/pull/1')).toBe(true)
    expect(isWebLink('HTTP://example.com')).toBe(true)
    for (const url of [
      'file:///Applications/Calculator.app',
      'javascript:alert(1)',
      'smb://evil/share',
      'vscode://vscode-remote/ssh-remote+x/y',
      'about:blank',
      'not a url',
      ''
    ]) {
      expect(isWebLink(url), url).toBe(false)
    }
  })
})

describe('isSameDocument', () => {
  it('is the same page with another hash, never another file or origin', () => {
    const page = 'file:///Applications/Styr.app/Contents/Resources/app.asar/out/renderer/index.html'
    expect(isSameDocument(page, `${page}#x`)).toBe(true)
    expect(isSameDocument(page, 'file:///etc/passwd')).toBe(false)
    expect(isSameDocument('http://localhost:5173/', 'http://localhost:5173/#a')).toBe(true)
    expect(isSameDocument('http://localhost:5173/', 'http://evil.example/')).toBe(false)
  })
})

describe('the window guards', () => {
  function contents(url: string) {
    const listeners: Record<string, (...args: never[]) => void> = {}
    const fake: GuardedContents = {
      getURL: () => url,
      on: (event: string, listener: (...args: never[]) => void) =>
        void (listeners[event] = listener)
    }
    const opened: string[] = []
    const openExternal = (link: string) => void opened.push(link)
    guardNavigation(fake, openExternal)
    const onOpen = openHandler(openExternal)
    const navigate = (to: string): boolean => {
      let prevented = false
      listeners['will-navigate']!(
        { preventDefault: () => (prevented = true) } as never,
        to as never
      )
      return prevented
    }
    return { opened, navigate, open: (to: string) => onOpen({ url: to }), listeners }
  }

  it('never opens a window, and sends only web links to the browser', () => {
    const t = contents('file:///app/index.html')
    expect(t.open('https://github.com')).toEqual({ action: 'deny' })
    expect(t.open('file:///Applications/Calculator.app')).toEqual({ action: 'deny' })
    expect(t.open('smb://evil/share')).toEqual({ action: 'deny' })
    expect(t.opened).toEqual(['https://github.com'])
  })

  it('keeps the window on the app’s page', () => {
    const t = contents('file:///app/index.html')
    expect(t.navigate('file:///app/index.html#board')).toBe(false)
    expect(t.navigate('https://evil.example/')).toBe(true)
    expect(t.navigate('file:///Users/me/dropped.html')).toBe(true)
    expect(t.opened).toEqual(['https://evil.example/'])
  })

  it('refuses every webview', () => {
    const t = contents('file:///app/index.html')
    let prevented = false
    t.listeners['will-attach-webview']!({ preventDefault: () => (prevented = true) } as never)
    expect(prevented).toBe(true)
  })
})
