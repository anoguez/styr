import { describe, expect, it } from 'vitest'
import { displayPath, fileName } from './terminalPath.js'

describe('displayPath', () => {
  it('names the repository when at its root', () => {
    expect(displayPath('/Users/a/styr', '/Users/a/styr')).toEqual({ name: 'styr', rest: '' })
  })

  it('reads from the repository down when inside it', () => {
    expect(displayPath('/Users/a/styr/src/renderer/', '/Users/a/styr')).toEqual({
      name: 'styr',
      rest: '/ src / renderer'
    })
  })

  it('shows the folder and where it lives outside a repository', () => {
    expect(displayPath('/Users/a/Downloads', null)).toEqual({
      name: 'Downloads',
      rest: '/Users/a'
    })
  })

  it('does not mistake a sibling with the same prefix for being inside', () => {
    expect(displayPath('/Users/a/styr-other', '/Users/a/styr').name).toBe('styr-other')
  })

  it('handles the filesystem root', () => {
    expect(displayPath('/', null)).toEqual({ name: '/', rest: '' })
  })

  it('reads Windows paths the same way', () => {
    expect(displayPath('C:\\Users\\a\\styr\\src', 'C:\\Users\\a\\styr')).toEqual({
      name: 'styr',
      rest: '/ src'
    })
    expect(displayPath('C:\\Users\\a\\Downloads', null)).toEqual({
      name: 'Downloads',
      rest: 'C:/Users/a'
    })
  })
})

describe('fileName', () => {
  it('takes the last segment of POSIX and Windows paths', () => {
    expect(fileName('/Users/a/notes.md')).toBe('notes.md')
    expect(fileName('C:\\Users\\a\\notes.md')).toBe('notes.md')
    expect(fileName('C:\\Users\\a\\repo\\')).toBe('repo')
  })

  it('leaves a backslash in a macOS name alone', () => {
    expect(fileName('/Users/a/odd\\name')).toBe('odd\\name')
  })
})
