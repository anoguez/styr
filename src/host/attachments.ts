import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { supportDir } from '@core/agentStore.js'
import { loadSettings } from '@core/settingsStore.js'
import { TASK_ID_RE } from '@core/taskSchema.js'

/**
 * Images a device sends to the host (`files:uploadImage`): a phone's screenshot for an agent or a
 * task. They are saved under the active workspace's `.styr/attachments/<taskId | inbox>/` and the
 * call answers with the absolute path, which the device then puts in a prompt or a task's
 * context files. Nothing removes them yet.
 */

/** The largest image accepted, decoded. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024
/** The longest base64 text that can decode to `MAX_IMAGE_BYTES`. */
export const MAX_IMAGE_BASE64_CHARS = Math.ceil(MAX_IMAGE_BYTES / 3) * 4
const MAX_NAME_CHARS = 64
const INBOX = 'inbox'

type ImageKind = 'png' | 'jpeg' | 'webp' | 'heic'

/** The types an agent CLI can read, keyed by mime type, with the extension they are saved under. */
const ACCEPTED: Record<string, { kind: Exclude<ImageKind, 'heic'>; ext: string }> = {
  'image/png': { kind: 'png', ext: 'png' },
  'image/jpeg': { kind: 'jpeg', ext: 'jpg' },
  'image/jpg': { kind: 'jpeg', ext: 'jpg' },
  'image/webp': { kind: 'webp', ext: 'webp' }
}
const HEIC_MIMES = new Set([
  'image/heic',
  'image/heif',
  'image/heic-sequence',
  'image/heif-sequence'
])
const HEIC_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1'])

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

export class AttachmentError extends Error {}

/** What the bytes are, by their signature rather than by what the device said. */
export function sniffImage(bytes: Buffer): ImageKind | null {
  const ascii = (from: number, to: number): string => bytes.subarray(from, to).toString('latin1')
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return 'png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return 'jpeg'
  if (bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp'
  if (bytes.length >= 12 && ascii(4, 8) === 'ftyp' && HEIC_BRANDS.has(ascii(8, 12))) return 'heic'
  return null
}
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * A file name safe to put in a path: the device's name without its extension, folder parts,
 * dots at the start or `..`, keeping letters, digits, `-` and `_`. `image` when nothing is left.
 */
export function safeImageName(name: string): string {
  const last = name.split(/[/\\]/).pop() ?? ''
  const stem = last.replace(/\.[^.]*$/, '')
  const safe = stem
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, MAX_NAME_CHARS)
    .replace(/[-_]+$/, '')
  return safe || 'image'
}

export interface UploadImageRequest {
  taskId: string | null
  name: string
  mime: string
  base64: string
}

/**
 * Checks and decodes an upload: the type both as named and by its bytes, and the size before and
 * after decoding. Throws an `AttachmentError` whose message says what to send instead.
 */
export function decodeImage(request: Pick<UploadImageRequest, 'mime' | 'base64'>): {
  bytes: Buffer
  ext: string
} {
  const mime = request.mime.trim().toLowerCase()
  if (HEIC_MIMES.has(mime)) throw heicError()
  const accepted = ACCEPTED[mime]
  if (!accepted) {
    throw new AttachmentError(
      `Images must be PNG, JPEG or WebP; "${request.mime.slice(0, 40)}" is not accepted.`
    )
  }
  // Refused before decoding: the text alone says it is too big.
  if (request.base64.length > MAX_IMAGE_BASE64_CHARS) throw tooBig()
  if (request.base64.length % 4 !== 0 || !BASE64.test(request.base64)) {
    throw new AttachmentError('The image is not valid base64.')
  }
  const bytes = Buffer.from(request.base64, 'base64')
  if (bytes.length === 0) throw new AttachmentError('The image is empty.')
  if (bytes.length > MAX_IMAGE_BYTES) throw tooBig()
  const kind = sniffImage(bytes)
  if (kind === 'heic') throw heicError()
  if (kind !== accepted.kind) {
    throw new AttachmentError(`The file is not a ${accepted.kind.toUpperCase()} image.`)
  }
  return { bytes, ext: accepted.ext }
}

const tooBig = (): AttachmentError =>
  new AttachmentError(`The image is larger than ${MAX_IMAGE_BYTES / (1024 * 1024)} MB.`)

const heicError = (): AttachmentError =>
  new AttachmentError('HEIC images are not accepted: agents cannot read them. Send a JPEG instead.')

/** The folder an upload goes in, under `root` (the workspace's `.styr/attachments`). */
export function attachmentFolder(root: string, taskId: string | null): string {
  if (taskId !== null && !TASK_ID_RE.test(taskId)) {
    throw new AttachmentError(`"${taskId.slice(0, 40)}" is not a task id.`)
  }
  return insideRoot(root, join(root, taskId ?? INBOX))
}

/** `path` resolved, or an error when it is not strictly inside `root`. */
function insideRoot(root: string, path: string): string {
  const base = resolve(root)
  const resolved = resolve(path)
  if (!resolved.startsWith(base + sep)) {
    throw new AttachmentError('The image would be saved outside the attachments folder.')
  }
  return resolved
}

export interface SaveImageOptions {
  /** The attachments folder: `<workspace>/.styr/attachments`. */
  root: string
  now?: () => number
}

/**
 * Saves an upload as `<root>/<taskId | inbox>/<timestamp>-<safe name>.<ext>` and answers with its
 * absolute path. Never replaces a file: a name already taken gets a `-2`, `-3` … suffix.
 */
export async function saveImage(
  request: UploadImageRequest,
  { root, now = Date.now }: SaveImageOptions
): Promise<string> {
  const { bytes, ext } = decodeImage(request)
  const folder = attachmentFolder(root, request.taskId)
  await mkdir(folder, { recursive: true })
  await hideFromGit(root)
  const stem = `${now()}-${safeImageName(request.name)}`
  for (let attempt = 1; ; attempt++) {
    const file = insideRoot(
      root,
      join(folder, `${stem}${attempt === 1 ? '' : `-${attempt}`}.${ext}`)
    )
    try {
      await writeFile(file, bytes, { flag: 'wx' })
      return file
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || attempt >= 100) throw error
    }
  }
}

/**
 * A workspace folder may be a git repository (boards shared through git), and `.styr/` is not
 * ignored there. A `.gitignore` of `*` keeps the attachments out without editing the user's own.
 */
async function hideFromGit(root: string): Promise<void> {
  const ignore = join(root, '.gitignore')
  if (existsSync(ignore)) return
  await writeFile(ignore, '# Created by Styr: images sent from devices, kept out of git.\n*\n', {
    flag: 'w'
  })
}

/** `files:uploadImage` for the active workspace. */
export function uploadImage(
  taskId: string | null,
  name: string,
  mime: string,
  base64: string
): Promise<string> {
  return saveImage(
    { taskId, name, mime, base64 },
    { root: supportDir(loadSettings(), 'attachments') }
  )
}
