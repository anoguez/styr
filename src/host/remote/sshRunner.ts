import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { scpArgs, sshCommandArgs } from '@core/remote.js'
import { syntaxFor } from '@core/shell.js'
import {
  parseBundleHashes,
  releaseAssetUrl,
  serverBundleName,
  type ServerArch,
  type ServerBundleHashes
} from '@core/remoteSetup.js'
import type { HostSetupPorts, SshResult } from './hostSetup.js'

/**
 * The real ports of `hostSetup.ts`: the system `ssh` and `scp` from PATH, with no shell in
 * between, in batch mode so neither ever prompts; and the release's bundle fetched to this
 * computer for the upload fallback. Styr stores no credentials: keys, agents and `~/.ssh/config`
 * are ssh's business.
 */

/** Runs one command on the host; stdin is written and closed (a script for `sh -s`, or nothing). */
export function runSsh(host: string, command: string, stdin?: string): Promise<SshResult> {
  return runProcess('ssh', [...sshCommandArgs(host), host, command], (child) => {
    child.stdin.end(stdin ?? '')
  })
}

/** Copies `file` to `remotePath` under the home folder: scp, or `ssh … cat` where scp fails. */
export async function uploadFile(
  host: string,
  file: string,
  remotePath: string
): Promise<'scp' | 'ssh'> {
  const dir = remotePath.includes('/') ? remotePath.slice(0, remotePath.lastIndexOf('/')) : '.'
  // The host is Linux: its shell is POSIX whatever this computer runs.
  const { quote } = syntaxFor('posix')
  const mkdir = await runSsh(host, `mkdir -p ${quote(dir)}`)
  if (mkdir.code !== 0) throw new Error(mkdir.stderr.trim() || 'could not create the upload folder')
  // `scp` takes the remote path after the colon, relative to the home folder.
  const scp = await runProcess('scp', scpArgs(host, file, remotePath), (child) =>
    child.stdin.end()
  ).catch((error: Error) => ({ code: null, stdout: '', stderr: error.message }))
  if (scp.code === 0) return 'scp'
  const piped = await runProcess(
    'ssh',
    [...sshCommandArgs(host), host, `cat > ${quote(remotePath)}`],
    (child) => createReadStream(file).pipe(child.stdin)
  )
  if (piped.code !== 0) {
    throw new Error(
      piped.stderr.trim() || scp.stderr.trim() || `ssh exited with ${String(piped.code)}`
    )
  }
  return 'ssh'
}

/**
 * The release's bundle on this computer, checked against `sha256` (the hash built into the app)
 * before it is used: kept in `cacheDir`, downloaded from GitHub when missing or different.
 * `STYR_SERVER_BUNDLE_DIR` (a folder holding the tarball, e.g. `dist/` after `yarn server:bundle`)
 * stands in for the release in development, where the version has none.
 */
export async function fetchBundle(
  cacheDir: string,
  version: string,
  arch: ServerArch,
  sha256: string
): Promise<string> {
  const name = serverBundleName(version, arch)
  const local = process.env.STYR_SERVER_BUNDLE_DIR
  if (local) {
    const file = join(local, name)
    if (sha256Of(readFileSync(file)) !== sha256) throw mismatch(name)
    return file
  }
  mkdirSync(cacheDir, { recursive: true })
  const file = join(cacheDir, name)
  if (existsSync(file) && sha256Of(readFileSync(file)) === sha256) return file
  const data = await download(releaseAssetUrl(version, name))
  if (sha256Of(data) !== sha256) throw mismatch(name)
  writeFileSync(`${file}.part`, data)
  renameSync(`${file}.part`, file)
  return file
}

function mismatch(name: string): Error {
  return new Error(
    `${name} does not match the SHA-256 built into this app, so it was refused. It may have been tampered with.`
  )
}

/**
 * The bundles' SHA-256s built into this app (`serverBundles.json`, written by the release
 * workflow before packaging). A development build has none; with `STYR_SERVER_BUNDLE_DIR` set,
 * the local bundles' own hashes stand in.
 */
export function bundleHashes(
  file: string,
  version: string
): (arch: ServerArch) => string | undefined {
  let hashes: ServerBundleHashes | undefined
  try {
    hashes = parseBundleHashes(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    hashes = undefined
  }
  return (arch) => {
    if (hashes?.version === version && hashes.sha256[arch]) return hashes.sha256[arch]
    const local = process.env.STYR_SERVER_BUNDLE_DIR
    const bundle = local ? join(local, serverBundleName(version, arch)) : undefined
    return bundle && existsSync(bundle) ? sha256Of(readFileSync(bundle)) : undefined
  }
}

export function createHostSetupPorts(options: {
  version: string
  cacheDir: string
  installScriptPath: string
  /** `serverBundles.json` inside the app. */
  hashesPath: string
}): HostSetupPorts {
  const hashFor = bundleHashes(options.hashesPath, options.version)
  return {
    ssh: runSsh,
    upload: uploadFile,
    expectedSha256: hashFor,
    bundle: (version, arch, sha256) => fetchBundle(options.cacheDir, version, arch, sha256),
    installScript: () => readFileSync(options.installScriptPath, 'utf8'),
    version: options.version
  }
}

async function download(url: string): Promise<Buffer> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}

function sha256Of(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

type Child = ReturnType<typeof spawn>

function runProcess(
  command: string,
  args: string[],
  feed: (child: Child & { stdin: NonNullable<Child['stdin']> }) => void
): Promise<SshResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += String(chunk)))
    child.stderr.on('data', (chunk) => (stderr = (stderr + String(chunk)).slice(-20_000)))
    // ssh closing its stdin early (it failed to connect) is reported by its exit, not as an error.
    child.stdin.on('error', () => undefined)
    child.once('error', (error: NodeJS.ErrnoException) =>
      reject(error.code === 'ENOENT' ? new Error(`${command} was not found on PATH.`) : error)
    )
    child.once('close', (code) => resolve({ code, stdout, stderr }))
    feed(child as Child & { stdin: NonNullable<Child['stdin']> })
  })
}
