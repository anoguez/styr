import { isValidRemoteHost } from '@core/remote.js'
import {
  INSTALL_EXIT,
  LINGER_COMMAND,
  installCommand,
  installMessages,
  parseInstallReport,
  parseProbe,
  sshFailureMessage,
  unsupportedHost,
  uploadPath,
  type HostProbe,
  type InstallMode,
  type InstallOptions,
  type ServerArch
} from '@core/remoteSetup.js'
import type {
  RemoteSetupDraft,
  RemoteSetupProgress,
  RemoteSetupResult,
  RemoteSetupStep,
  RemoteTransfer
} from '@core/types.js'

/**
 * Setting up and running a remote host's server (`docs/architecture/remote.md`, Host setup), the
 * way VS Code Remote-SSH installs its server: the desktop app drives, and every step runs on the
 * host over ssh, through `resources/server/install.sh` piped to `sh -s`. The same script is
 * published with each release for setting a host up by hand, so both produce the same layout and
 * unit, and either can upgrade what the other installed.
 *
 * Electron-free, and every outside effect is a port (`HostSetupPorts`: the ssh runner, the
 * uploader, the bundle on this computer), so the steps are tested with fakes.
 */

export interface SshResult {
  /** null when ssh was killed or never started. */
  code: number | null
  stdout: string
  stderr: string
}

export interface HostSetupPorts {
  /**
   * Runs `command` on `host` with ssh in batch mode (never prompting), writing `stdin` and closing
   * it. Resolves with whatever happened; rejects only when ssh itself cannot be started.
   */
  ssh(host: string, command: string, stdin?: string): Promise<SshResult>
  /**
   * Copies a file on this computer to `remotePath` (relative to the home folder) on `host`: `scp`,
   * or `ssh … cat` where scp is not available. Says which was used.
   */
  upload(host: string, file: string, remotePath: string): Promise<'scp' | 'ssh'>
  /**
   * The SHA-256 the bundle for `arch` must have, from inside this (signed) app
   * (`out/main/serverBundles.json`), never from the release: undefined when the build carries none.
   */
  expectedSha256(arch: ServerArch): string | undefined
  /**
   * The release's bundle for `arch` on this computer, checked against `sha256` before it is
   * returned: the fallback when the host cannot download it itself.
   */
  bundle(version: string, arch: ServerArch, sha256: string): Promise<string>
  /** `install.sh`'s text. */
  installScript(): string
  /** This app's version: the server version installed. */
  version: string
}

/** A setup step that cannot go on, with a message meant for people. */
export class SetupError extends Error {}

export interface InstallOutcome {
  transfer: RemoteTransfer
  /** The script's `::styr` lines from the install. */
  report: Record<string, string>
  /** Why the host could not download the bundle, when this computer uploaded it. */
  downloadError?: string
  /** The host's download did not match this app's checksum (not a network problem). */
  mismatch?: boolean
  /** How the upload went, when there was one. */
  uploadedWith?: 'scp' | 'ssh'
}

export function createHostSetup(ports: HostSetupPorts) {
  function run(host: string, mode: InstallMode, options: InstallOptions = {}): Promise<SshResult> {
    return ports.ssh(host, installCommand(mode, options), ports.installScript())
  }

  /** The script failed: its own words (stderr), or its last line for people. */
  function scriptFailure(what: string, result: SshResult): SetupError {
    const said =
      result.stderr.trim() ||
      installMessages(result.stdout).at(-1) ||
      `exit code ${String(result.code)}`
    return new SetupError(`${what}: ${said}`)
  }

  return {
    /** `ssh -T -o BatchMode=yes <host> true`: ssh's own error, verbatim, when it fails. */
    async check(host: string): Promise<void> {
      if (!isValidRemoteHost(host)) {
        throw new SetupError(
          `“${host}” is not a host ssh can reach, such as devbox or me@100.64.0.2.`
        )
      }
      const result = await ports.ssh(host, 'true')
      if (result.code !== 0)
        throw new SetupError(sshFailureMessage(host, result.stderr, result.code))
    },

    /** What the host has: OS, arch, glibc, systemd, linger, installed and running servers. */
    async probe(host: string): Promise<HostProbe> {
      const result = await run(host, 'probe', { version: ports.version })
      if (result.code !== 0) throw scriptFailure(`Could not inspect ${host}`, result)
      return parseProbe(result.stdout)
    },

    /**
     * Installs this app's server version beside any other and points `current` at it, then starts
     * it unless a server is running (a running one is never restarted here). The host downloads
     * the bundle itself; when it cannot, this computer downloads it, checks it, and uploads it.
     */
    async install(host: string, arch: ServerArch): Promise<InstallOutcome> {
      const version = ports.version
      const sha256 = ports.expectedSha256(arch)
      if (!sha256) {
        throw new SetupError(
          `This build of Styr carries no checksum for the linux-${arch} server, so it will not install ` +
            'one. Release builds carry them; in development, point STYR_SERVER_BUNDLE_DIR at a folder ' +
            'holding the bundles (docs/architecture/remote.md).'
        )
      }
      // The host downloads the bundle and checks it against the hash from this app.
      const first = await run(host, 'install', { version, sha256 })
      if (first.code === 0) {
        const report = parseInstallReport(first.stdout)
        return { transfer: report.source === 'installed' ? 'installed' : 'download', report }
      }
      const mismatch = first.code === INSTALL_EXIT.CHECKSUM_MISMATCH
      if (first.code !== INSTALL_EXIT.DOWNLOAD_FAILED && !mismatch) {
        throw scriptFailure(`Installing the server on ${host} failed`, first)
      }
      // A mismatch is told apart from a network problem: the download may have been tampered with.
      const downloadError = mismatch
        ? `the download on ${host} did not match this app's checksum`
        : (first.stderr.trim().split('\n').at(-1) ?? 'the download failed')
      let file: string
      try {
        file = await ports.bundle(version, arch, sha256)
      } catch (error) {
        throw new SetupError(
          `${mismatch ? `The download on ${host} did not match this app's checksum and was refused` : `${host} could not download the Styr server (${downloadError})`}, and neither could ` +
            `this computer: ${error instanceof Error ? error.message : String(error)}`
        )
      }
      const remotePath = uploadPath(version, arch)
      let uploadedWith: 'scp' | 'ssh'
      try {
        uploadedWith = await ports.upload(host, file, remotePath)
      } catch (error) {
        throw new SetupError(
          `${mismatch ? `The download on ${host} did not match this app's checksum and was refused` : `${host} could not download the Styr server (${downloadError})`}, and uploading it ` +
            `failed: ${error instanceof Error ? error.message : String(error)}`
        )
      }
      const second = await run(host, 'install', {
        version,
        tarball: remotePath,
        sha256
      })
      if (second.code !== 0) {
        throw scriptFailure(`Installing the uploaded server on ${host} failed`, second)
      }
      return {
        transfer: 'upload',
        report: parseInstallReport(second.stdout),
        downloadError,
        ...(mismatch ? { mismatch } : {}),
        uploadedWith
      }
    },

    /** Starts the installed server unless it runs (Connect after Stop, or after a reboot). */
    async start(host: string): Promise<Record<string, string>> {
      const result = await run(host, 'start')
      if (result.code !== 0) throw scriptFailure(`Starting the server on ${host} failed`, result)
      return parseInstallReport(result.stdout)
    },

    /** Restarts it, so the version `current` points at takes over. Ends its agents: ask first. */
    async restart(host: string, pid?: number): Promise<Record<string, string>> {
      const result = await run(host, 'restart', pid !== undefined ? { pid } : {})
      if (result.code !== 0) throw scriptFailure(`Restarting the server on ${host} failed`, result)
      return parseInstallReport(result.stdout)
    },

    /** Stops it. Ends its agents: ask first. */
    async stop(host: string, pid?: number): Promise<void> {
      const result = await run(host, 'stop', pid !== undefined ? { pid } : {})
      if (result.code !== 0) throw scriptFailure(`Stopping the server on ${host} failed`, result)
    }
  }
}

export type HostSetup = ReturnType<typeof createHostSetup>

/** What inspecting a host needs: the host steps and somewhere to report them. */
export interface InspectPorts {
  setup: HostSetup
  progress(update: RemoteSetupProgress): void
}

/** What the setup flow needs besides the host steps. */
export interface SetupFlowPorts extends InspectPorts {
  version: string
  /** Creates the workspace on the host's server and returns its id there. */
  createServerWorkspace(host: string, name: string): Promise<string>
  /** Writes the local stub, switches to it and returns its id. */
  addStub(draft: { name: string; host: string; workspaceId: string }): Promise<string>
}

/** Runs one setup step, reporting it running, and failed with its message when it throws. */
function stepper(ports: InspectPorts, host: string) {
  return {
    async step<T>(id: RemoteSetupStep, work: () => Promise<T>): Promise<T> {
      ports.progress({ host, step: id, state: 'running' })
      try {
        return await work()
      } catch (error) {
        ports.progress({
          host,
          step: id,
          state: 'failed',
          detail: error instanceof Error ? error.message : String(error)
        })
        throw error
      }
    },
    done(id: RemoteSetupStep, detail?: string): void {
      ports.progress({ host, step: id, state: 'done', ...(detail ? { detail } : {}) })
    }
  }
}

/**
 * The first two steps of New workspace → Remote host: ssh reaches the host, and it can run the
 * server (Linux, a supported arch, the glibc floor). Nothing about agents: like a local workspace,
 * a remote one checks its agent CLI in Settings → Agents and before a launch, on the server.
 */
export async function inspectRemoteHost(ports: InspectPorts, value: string): Promise<HostProbe> {
  const host = value.trim()
  const { step, done } = stepper(ports, host)
  await step('check', () => ports.setup.check(host))
  done('check', `ssh reaches ${host}.`)
  const probe = await step('probe', async () => {
    const found = await ports.setup.probe(host)
    const refused = unsupportedHost(host, found)
    if (refused) throw new SetupError(refused)
    return found
  })
  done('probe', `Linux ${probe.machine}${probe.running ? `, Styr ${probe.running} running` : ''}.`)
  return probe
}

/**
 * New workspace → Remote host: check ssh, inspect the host (unless `inspected` carries what
 * `inspectRemoteHost` just found), install (or reuse) the server, create the workspace there and
 * the local stub. Refuses only what cannot work (no ssh, not Linux); no systemd or an older server
 * still running are warnings (warn, don't refuse).
 */
export async function runRemoteSetup(
  ports: SetupFlowPorts,
  draft: RemoteSetupDraft,
  inspected?: HostProbe
): Promise<RemoteSetupResult> {
  const host = draft.host.trim()
  const name = draft.name.trim()
  if (!name) throw new SetupError('Give the workspace a name.')
  const warnings: string[] = []
  const { step, done } = stepper(ports, host)

  const probe = inspected ?? (await inspectRemoteHost(ports, host))

  let transfer: RemoteTransfer
  let report: Record<string, string> = {}
  if (probe.running === ports.version) {
    transfer = 'running'
    done('install', `Reusing the Styr ${ports.version} server already running on ${host}.`)
  } else {
    const outcome = await step('install', () => ports.setup.install(host, probe.arch!))
    transfer = outcome.transfer
    report = outcome.report
    done(
      'install',
      outcome.transfer === 'upload'
        ? outcome.mismatch
          ? `The download on ${host} did not match this app's checksum; uploaded a verified copy from this computer over ${outcome.uploadedWith}.`
          : `${host} could not download it (${outcome.downloadError}); uploaded from this computer over ${outcome.uploadedWith}.`
        : outcome.transfer === 'installed'
          ? `Styr ${ports.version} was already installed.`
          : `${host} downloaded Styr ${ports.version} from the release and checked it.`
    )
  }

  const systemd = report.systemd ? report.systemd === 'yes' : probe.systemd
  const linger = report.linger ? report.linger === 'yes' : probe.linger
  if (!systemd) {
    warnings.push(
      `${host} has no systemd user session, so the server was started with nohup. It will not come back after a reboot; Connect in Settings → Remote hosts starts it again.`
    )
  }
  const running = report.running || probe.running
  if (running && running !== ports.version && running !== 'unknown') {
    warnings.push(
      `Styr ${running} is still running on ${host} and keeps running its agents. Styr ${ports.version} is installed beside it and takes over when you upgrade the server (Settings → Remote hosts).`
    )
  }

  const workspaceId = await step('create', async () => {
    const remoteId = await ports.createServerWorkspace(host, name)
    return ports.addStub({ name, host, workspaceId: remoteId })
  })
  done('create', `Created “${name}” on ${host}.`)

  return {
    workspaceId,
    transfer,
    warnings,
    ...(systemd && !linger ? { lingerCommand: LINGER_COMMAND } : {})
  }
}
