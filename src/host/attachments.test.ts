import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AttachmentError,
  MAX_IMAGE_BASE64_CHARS,
  MAX_IMAGE_BYTES,
  attachmentFolder,
  decodeImage,
  safeImageName,
  saveImage,
  sniffImage
} from './attachments.js'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10])
const WEBP = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([4, 0, 0, 0]),
  Buffer.from('WEBPVP8 ')
])
const HEIC = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic'), Buffer.alloc(8)])
const GIF = Buffer.from('GIF89a\x01\x00')

const b64 = (bytes: Buffer): string => bytes.toString('base64')

let root: string
beforeEach(() => {
  root = join(mkdtempSync(join(tmpdir(), 'styr-attachments-')), '.styr', 'attachments')
})
afterEach(() => rmSync(join(root, '..', '..'), { recursive: true, force: true }))

const upload = (
  overrides: Partial<{ taskId: string | null; name: string; mime: string; base64: string }> = {}
): Promise<string> =>
  saveImage(
    {
      taskId: 'TASK-0007',
      name: 'Screen Shot.png',
      mime: 'image/png',
      base64: b64(PNG),
      ...overrides
    },
    { root, now: () => 1700000000000 }
  )

describe('saveImage: where it goes', () => {
  it('saves under <root>/<taskId>/<timestamp>-<safe-name>.<ext> and answers the absolute path', async () => {
    const path = await upload()
    expect(path).toBe(join(root, 'TASK-0007', '1700000000000-Screen-Shot.png'))
    expect(readFileSync(path)).toEqual(PNG)
  })

  it('puts an upload with no task in the inbox', async () => {
    const path = await upload({ taskId: null })
    expect(path).toBe(join(root, 'inbox', '1700000000000-Screen-Shot.png'))
  })

  it('names the file by its type, not the extension it was sent with', async () => {
    const path = await upload({ name: 'photo.exe', mime: 'image/jpeg', base64: b64(JPEG) })
    expect(path.endsWith(`${sep}1700000000000-photo.jpg`)).toBe(true)
    const webp = await upload({ name: 'a', mime: 'image/webp', base64: b64(WEBP) })
    expect(webp.endsWith('.webp')).toBe(true)
  })

  it('never replaces a file: a taken name gets a suffix', async () => {
    const first = await upload()
    const second = await upload()
    expect(second).toBe(first.replace(/\.png$/, '-2.png'))
    expect(readdirSync(join(root, 'TASK-0007')).sort()).toEqual([
      '1700000000000-Screen-Shot-2.png',
      '1700000000000-Screen-Shot.png'
    ])
  })

  it('keeps the attachments out of git with a .gitignore of *', async () => {
    await upload()
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toMatch(/^\*$/m)
  })
})

describe('decodeImage: type and size', () => {
  it('accepts png, jpeg and webp whose bytes match', () => {
    expect(decodeImage({ mime: 'image/png', base64: b64(PNG) }).ext).toBe('png')
    expect(decodeImage({ mime: 'image/jpeg', base64: b64(JPEG) }).ext).toBe('jpg')
    expect(decodeImage({ mime: 'IMAGE/JPG', base64: b64(JPEG) }).ext).toBe('jpg')
    expect(decodeImage({ mime: 'image/webp', base64: b64(WEBP) }).ext).toBe('webp')
  })

  it('refuses other types by name', () => {
    expect(() => decodeImage({ mime: 'image/gif', base64: b64(GIF) })).toThrow(/PNG, JPEG or WebP/)
    expect(() => decodeImage({ mime: 'application/pdf', base64: b64(PNG) })).toThrow(
      AttachmentError
    )
  })

  it('refuses bytes that are not what the mime type says', () => {
    expect(() => decodeImage({ mime: 'image/png', base64: b64(GIF) })).toThrow(/not a PNG image/)
    expect(() => decodeImage({ mime: 'image/jpeg', base64: b64(PNG) })).toThrow(/not a JPEG/)
    expect(() =>
      decodeImage({ mime: 'image/png', base64: b64(Buffer.from('#!/bin/sh\nrm -rf ~\n')) })
    ).toThrow(AttachmentError)
  })

  it('refuses HEIC with a clear error, by name or by bytes', () => {
    expect(() => decodeImage({ mime: 'image/heic', base64: b64(HEIC) })).toThrow(/HEIC.*JPEG/)
    expect(() => decodeImage({ mime: 'image/jpeg', base64: b64(HEIC) })).toThrow(/HEIC/)
    expect(sniffImage(HEIC)).toBe('heic')
  })

  it('refuses an image over 10 MB before decoding it', () => {
    const base64 = 'A'.repeat(MAX_IMAGE_BASE64_CHARS + 4)
    expect(() => decodeImage({ mime: 'image/png', base64 })).toThrow(/larger than 10 MB/)
  })

  it('refuses an image over 10 MB once decoded', () => {
    const bytes = Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES - PNG.length + 1)])
    expect(b64(bytes).length).toBeLessThanOrEqual(MAX_IMAGE_BASE64_CHARS)
    expect(() => decodeImage({ mime: 'image/png', base64: b64(bytes) })).toThrow(
      /larger than 10 MB/
    )
  })

  it('accepts an image of exactly 10 MB', () => {
    const bytes = Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES - PNG.length)])
    expect(decodeImage({ mime: 'image/png', base64: b64(bytes) }).bytes.length).toBe(
      MAX_IMAGE_BYTES
    )
  })

  it('refuses empty and malformed base64', () => {
    expect(() => decodeImage({ mime: 'image/png', base64: '' })).toThrow(/empty/)
    expect(() => decodeImage({ mime: 'image/png', base64: 'not base64!' })).toThrow(/base64/)
  })

  it('writes nothing when the image is refused', async () => {
    await expect(upload({ mime: 'image/gif', base64: b64(GIF) })).rejects.toThrow(AttachmentError)
    expect(() => readdirSync(root)).toThrow()
  })
})

describe('names and paths', () => {
  it('sanitizes the name: no separators, no dots, no ..', () => {
    expect(safeImageName('../../etc/passwd')).toBe('passwd')
    expect(safeImageName('..\\..\\Windows\\evil.png')).toBe('evil')
    expect(safeImageName('..')).toBe('image')
    expect(safeImageName('.hidden.png')).toBe('hidden')
    expect(safeImageName('a..b.png')).toBe('a-b')
    expect(safeImageName('Café screenshot (1).PNG')).toBe('Cafe-screenshot-1')
    expect(safeImageName('')).toBe('image')
    expect(safeImageName('x'.repeat(500))).toHaveLength(64)
    expect(safeImageName('a\0b/c\nd.png')).toBe('c-d')
  })

  it('keeps a traversal in the name inside the task folder', async () => {
    const path = await upload({ name: '../../../../tmp/owned.png' })
    expect(path).toBe(join(root, 'TASK-0007', '1700000000000-owned.png'))
  })

  it('refuses a task id that is not one, so it cannot climb out of the folder', async () => {
    for (const taskId of ['..', '../TASK-0001', 'TASK-0001/../..', '/etc', 'TASK-1\\..', '']) {
      expect(() => attachmentFolder(root, taskId)).toThrow(AttachmentError)
      await expect(upload({ taskId })).rejects.toThrow(AttachmentError)
    }
    expect(() => readdirSync(root)).toThrow()
  })
})
