import { syntaxFor } from './shell.js'

/**
 * The pure rules of setting up a remote host (`docs/architecture/remote.md`, Host setup): the
 * release's file names, the `install.sh` command lines the desktop app sends over ssh, and reading
 * what the script reports. The steps themselves are `src/host/remote/hostSetup.ts`; the script is
 * `resources/server/install.sh`. Nothing here imports `node:*`.
 */

/** Where releases live. The repo and its releases are public, so the VM downloads from here itself. */
export const RELEASE_REPO = 'anoguez/styr'

export type ServerArch = 'x64' | 'arm64'

export function serverBundleName(version: string, arch: ServerArch): string {
  return `styr-server-${version}-linux-${arch}.tar.gz`
}

/** The release's checksum file, `sha256sum`'s format, covering both bundles. */
export function serverSumsName(version: string): string {
  return `styr-server-${version}-SHA256SUMS`
}

export function releaseAssetUrl(version: string, file: string): string {
  return `https://github.com/${RELEASE_REPO}/releases/download/v${version}/${file}`
}

/** The checksum `sums` (a SHA256SUMS file) lists for `file`, if any. */
export function checksumFor(sums: string, file: string): string | undefined {
  for (const line of sums.split(/\r?\n/)) {
    const [hash, name] = line.trim().split(/\s+/)
    if (hash && (name === file || name === `*${file}`)) return hash.toLowerCase()
  }
  return undefined
}

/** What lingering needs, shown to copy and never run: Styr does not ask for sudo. */
export const LINGER_COMMAND = 'sudo loginctl enable-linger $USER'

/** Where the desktop app uploads a bundle for `install.sh --tarball` (relative to the home folder). */
export function uploadPath(version: string, arch: ServerArch): string {
  return `.styr/server/upload-${serverBundleName(version, arch)}`
}

/** `install.sh`'s exit codes (see the script's header). */
export const INSTALL_EXIT = {
  NOT_LINUX: 10,
  UNSUPPORTED_ARCH: 11,
  /** The host's glibc is older than the bundle's floor (`install.sh`'s `GLIBC_FLOOR`). */
  OLD_GLIBC: 12,
  /** The VM could not download the bundle: the desktop app uploads it instead. */
  DOWNLOAD_FAILED: 20,
  /**
   * The VM's download did not match the expected SHA-256, which may mean it was tampered with on
   * the way: refused, and the desktop app uploads a copy it checked itself.
   */
  CHECKSUM_MISMATCH: 22,
  BROKEN_BUNDLE: 21,
  START_FAILED: 30,
  STOP_FAILED: 31
} as const

export type InstallMode = 'probe' | 'install' | 'start' | 'restart' | 'stop'

export interface InstallOptions {
  version?: string
  tarball?: string
  sha256?: string
  pid?: number
}

/**
 * The line ssh runs on the host: a POSIX `sh` reading `install.sh` from stdin. Built with the POSIX
 * syntax whatever this machine's shell, because the host is Linux.
 */
export function installCommand(mode: InstallMode, options: InstallOptions = {}): string {
  const quote = syntaxFor('posix').quote
  const args = [`--${mode}`]
  if (options.version) args.push('--version', quote(options.version))
  if (options.tarball) args.push('--tarball', quote(options.tarball))
  if (options.sha256) args.push('--sha256', quote(options.sha256))
  if (options.pid !== undefined) args.push('--pid', String(Math.trunc(options.pid)))
  return `sh -s -- ${args.join(' ')}`
}

/** The `::styr key=value` lines the script prints for the desktop app. */
export function parseInstallReport(stdout: string): Record<string, string> {
  const report: Record<string, string> = {}
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^::styr ([a-z_]+)=(.*)$/.exec(line.trim())
    if (match) report[match[1]!] = match[2]!.trim()
  }
  return report
}

/** The script's lines for people: everything that is not a `::styr` line. */
export function installMessages(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() && !line.startsWith('::styr '))
}

/** What `--probe` found on the host. */
export interface HostProbe {
  os: string
  machine: string
  arch?: ServerArch
  /** The host's glibc, as major.minor; unset when it has none or the script could not tell. */
  glibc?: string
  /**
   * The oldest glibc the bundle runs on, and the distributions that have it. The floor lives only
   * in `install.sh`, which ships inside the app, so the script and the app always agree.
   */
  glibcFloor?: { version: string; hosts: string }
  systemd: boolean
  linger: boolean
  /** The version `current` points at. */
  installed?: string
  /** The version asked about is unpacked already. */
  hasVersion: boolean
  /** The version of the server answering on the socket, when one is running. */
  running?: string
}

export function parseProbe(stdout: string): HostProbe {
  const report = parseInstallReport(stdout)
  const arch = report.arch === 'x64' || report.arch === 'arm64' ? report.arch : undefined
  const glibc = glibcVersion(report.glibc)
  const floor = glibcVersion(report.glibc_floor)
  return {
    os: report.os ?? '',
    machine: report.machine ?? '',
    ...(arch ? { arch } : {}),
    ...(glibc ? { glibc } : {}),
    ...(floor ? { glibcFloor: { version: floor, hosts: report.glibc_hosts ?? '' } } : {}),
    systemd: report.systemd === 'yes',
    linger: report.linger === 'yes',
    ...(report.installed ? { installed: report.installed } : {}),
    hasVersion: report.has_version === 'yes',
    ...('running' in report ? { running: report.running || 'unknown' } : {})
  }
}

/** Why a host cannot run the server, or undefined when it can. */
export function unsupportedHost(host: string, probe: HostProbe): string | undefined {
  if (probe.os !== 'Linux') {
    return `${host} runs ${probe.os || 'an unknown system'}. Remote workspaces need a Linux host for now.`
  }
  if (!probe.arch) {
    return `${host} is ${probe.machine || 'an unknown machine'}. The Styr server is built for x86_64 and aarch64 only.`
  }
  const floor = probe.glibcFloor
  if (probe.glibc && floor && olderThan(probe.glibc, floor.version)) {
    const hosts = floor.hosts ? ` (${floor.hosts})` : ''
    return `${host} has glibc ${probe.glibc}; the Styr server needs ${floor.version} or newer${hosts}.`
  }
  return undefined
}

/** A dotted glibc version from the probe, or undefined for anything else. */
function glibcVersion(value: string | undefined): string | undefined {
  return value && /^\d+(\.\d+)+$/.test(value) ? value : undefined
}

function olderThan(version: string, floor: string): boolean {
  const [major = 0, minor = 0] = version.split('.').map(Number)
  const [floorMajor = 0, floorMinor = 0] = floor.split('.').map(Number)
  return major < floorMajor || (major === floorMajor && minor < floorMinor)
}

/**
 * The SHA-256s of the server bundles, written into the app at release time
 * (`out/main/serverBundles.json`), so the hash a download is checked against ships inside the
 * signed app rather than next to the tarball.
 */
export interface ServerBundleHashes {
  version: string
  sha256: Partial<Record<ServerArch, string>>
}

export function parseBundleHashes(value: unknown): ServerBundleHashes | undefined {
  if (!value || typeof value !== 'object') return undefined
  const { version, sha256 } = value as { version?: unknown; sha256?: unknown }
  if (typeof version !== 'string' || !sha256 || typeof sha256 !== 'object') return undefined
  const hashes: Partial<Record<ServerArch, string>> = {}
  for (const arch of ['x64', 'arm64'] as const) {
    const hash = (sha256 as Record<string, unknown>)[arch]
    if (typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash)) hashes[arch] = hash
  }
  return { version, sha256: hashes }
}

/** ssh refused because the host key is unknown or changed: only the user may accept a key. */
export function isHostKeyProblem(stderr: string): boolean {
  return /host key verification failed|remote host identification has changed|host key for .* has changed|no .*host key is known/i.test(
    stderr
  )
}

/** ssh's own words when the first `ssh host true` fails, and what usually fixes it. */
export function sshFailureMessage(host: string, stderr: string, code: number | null): string {
  const said =
    stderr.trim() || (code === null ? 'ssh was stopped.' : `ssh exited with code ${code}.`)
  if (isHostKeyProblem(said)) {
    return (
      `Styr could not reach ${host} over ssh:\n\n${said}\n\n` +
      `ssh does not know ${host}'s host key, or the key has changed. Run “ssh ${host}” once in ` +
      'a terminal to check the key and accept it, then click Retry. Styr never accepts a host ' +
      'key for you.'
    )
  }
  return (
    `Styr could not reach ${host} over ssh:\n\n${said}\n\n` +
    'Styr runs ssh in batch mode and never asks for a password. Set up a key ' +
    `(ssh-copy-id ${host}) or Tailscale SSH, check that “ssh ${host} true” works in a ` +
    'terminal, then click Retry.'
  )
}
