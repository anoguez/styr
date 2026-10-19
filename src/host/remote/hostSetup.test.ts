import { describe, expect, it } from 'vitest'
import type { RemoteSetupDraft, RemoteSetupProgress } from '@core/types.js'
import {
  SetupError,
  createHostSetup,
  runRemoteSetup,
  type HostSetupPorts,
  type SshResult
} from './hostSetup.js'

const VERSION = '1.2.0'
const HASH = 'c'.repeat(64)
const SCRIPT = '#!/bin/sh\n# install.sh\n'

const ok = (stdout = ''): SshResult => ({ code: 0, stdout, stderr: '' })
const failed = (code: number, stderr: string): SshResult => ({ code, stdout: '', stderr })

const PROBE =
  '::styr os=Linux\n::styr machine=x86_64\n::styr arch=x64\n::styr git=yes\n::styr cli=yes\n' +
  '::styr systemd=yes\n::styr linger=yes\n'

/**
 * A fake host behind the ssh port: answers `true`, and `install.sh` by mode, from `answers`, and
 * records every command and what was piped to it. Nothing runs and nothing is uploaded unless a
 * test says so.
 */
function fakeHost(answers: {
  check?: SshResult
  probe?: string
  install?: SshResult
  installUploaded?: SshResult
  other?: SshResult
}) {
  const commands: string[] = []
  const stdins: (string | undefined)[] = []
  const uploads: [string, string, string][] = []
  const fetched: string[] = []
  let embedded: string | undefined = HASH
  let laptopBundle: () => Promise<string> = async () => '/cache/bundle.tgz'
  const ports: HostSetupPorts = {
    ssh: async (_host, command, stdin) => {
      commands.push(command)
      stdins.push(stdin)
      if (command === 'true') return answers.check ?? ok()
      if (command.includes('--probe')) return ok(answers.probe ?? PROBE)
      if (command.includes('--install') && command.includes('--tarball')) {
        return answers.installUploaded ?? ok('::styr source=upload\n::styr systemd=yes\n')
      }
      if (command.includes('--install')) {
        return (
          answers.install ?? ok('::styr source=download\n::styr systemd=yes\n::styr linger=yes\n')
        )
      }
      return answers.other ?? ok()
    },
    upload: async (host, file, remotePath) => {
      uploads.push([host, file, remotePath])
      return 'scp'
    },
    expectedSha256: () => embedded,
    bundle: async (version, arch, sha256) => {
      fetched.push(`${version}/${arch}/${sha256}`)
      return laptopBundle()
    },
    installScript: () => SCRIPT,
    version: VERSION
  }
  return {
    ports,
    commands,
    stdins,
    uploads,
    fetched,
    noEmbeddedHash: () => void (embedded = undefined),
    laptopBundleFails: (message: string) => {
      laptopBundle = async () => {
        throw new Error(message)
      }
    }
  }
}

function flow(host: ReturnType<typeof fakeHost>) {
  const progress: RemoteSetupProgress[] = []
  const created: string[] = []
  const stubs: { name: string; host: string; workspaceId: string }[] = []
  const ports = {
    setup: createHostSetup(host.ports),
    version: VERSION,
    createServerWorkspace: async (hostName: string, name: string) => {
      created.push(`${hostName}:${name}`)
      return 'devbox-board'
    },
    addStub: async (stub: { name: string; host: string; workspaceId: string }) => {
      stubs.push(stub)
      return 'local-stub'
    },
    progress: (update: RemoteSetupProgress) => void progress.push(update)
  }
  return {
    progress,
    created,
    stubs,
    run: (draft: RemoteSetupDraft = { name: 'Devbox', host: 'me@devbox', provider: 'claude' }) =>
      runRemoteSetup(ports, draft)
  }
}

describe('the setup flow (New workspace → Remote)', () => {
  it('on a fresh VM that reaches GitHub, sends only ssh commands: the host downloads and checks the bundle', async () => {
    const host = fakeHost({})
    const setup = flow(host)
    const result = await setup.run()

    expect(host.commands).toEqual([
      'true',
      "sh -s -- --probe --version '1.2.0' --cli 'claude'",
      `sh -s -- --install --version '1.2.0' --sha256 '${HASH}'`
    ])
    // install.sh travels on stdin; no bundle leaves this computer.
    expect(host.stdins.slice(1)).toEqual([SCRIPT, SCRIPT])
    expect(host.uploads).toEqual([])
    expect(host.fetched).toEqual([])

    expect(setup.created).toEqual(['me@devbox:Devbox'])
    expect(setup.stubs).toEqual([
      { name: 'Devbox', host: 'me@devbox', workspaceId: 'devbox-board' }
    ])
    expect(result).toEqual({ workspaceId: 'local-stub', transfer: 'download', warnings: [] })
    expect(setup.progress.filter((p) => p.state === 'done').map((p) => p.step)).toEqual([
      'check',
      'probe',
      'install',
      'create'
    ])
  })

  it('when the host cannot download, this computer fetches the bundle, checks the app’s hash, uploads it, and says so', async () => {
    const host = fakeHost({
      install: failed(
        20,
        'curl: (6) Could not resolve host: github.com\nstyr: could not download it'
      )
    })
    const setup = flow(host)
    const result = await setup.run()

    expect(host.fetched).toEqual([`${VERSION}/x64/${HASH}`])
    expect(host.uploads).toEqual([
      ['me@devbox', '/cache/bundle.tgz', '.styr/server/upload-styr-server-1.2.0-linux-x64.tar.gz']
    ])
    expect(host.commands.at(-1)).toBe(
      `sh -s -- --install --version '1.2.0' --tarball '.styr/server/upload-styr-server-1.2.0-linux-x64.tar.gz' --sha256 '${HASH}'`
    )
    expect(result.transfer).toBe('upload')
    const install = setup.progress.find((p) => p.step === 'install' && p.state === 'done')
    expect(install?.detail).toBe(
      'me@devbox could not download it (styr: could not download it); uploaded from this computer over scp.'
    )
  })

  it('refuses a tampered bundle, on the host and on this computer, and says why', async () => {
    const host = fakeHost({
      install: failed(
        22,
        'styr: styr-server-1.2.0-linux-x64.tar.gz does not match the expected SHA-256'
      )
    })
    host.laptopBundleFails(
      'styr-server-1.2.0-linux-x64.tar.gz does not match the SHA-256 built into this app, so it was refused.'
    )
    const setup = flow(host)
    await expect(setup.run()).rejects.toThrow(
      /The download on me@devbox did not match this app's checksum and was refused, and neither could this computer: .*built into this app, so it was refused/s
    )
    expect(host.uploads).toEqual([])
    expect(setup.created).toEqual([])
    expect(setup.progress.at(-1)).toMatchObject({ step: 'install', state: 'failed' })
  })

  it('tells a checksum mismatch on the host apart from a network failure, and uploads a verified copy', async () => {
    const host = fakeHost({
      install: failed(
        22,
        'styr: styr-server-1.2.0-linux-x64.tar.gz does not match the expected SHA-256'
      )
    })
    const setup = flow(host)
    const result = await setup.run()
    expect(result.transfer).toBe('upload')
    expect(host.fetched).toEqual([`${VERSION}/x64/${HASH}`])
    expect(setup.progress.find((p) => p.step === 'install' && p.state === 'done')?.detail).toBe(
      "The download on me@devbox did not match this app's checksum; uploaded a verified copy from this computer over scp."
    )
  })

  it('will not install from a build that carries no hashes', async () => {
    const host = fakeHost({})
    host.noEmbeddedHash()
    await expect(flow(host).run()).rejects.toThrow(/carries no checksum for the linux-x64 server/)
    expect(host.commands.some((command) => command.includes('--install'))).toBe(false)
  })

  it('stops at ssh with its own words, and the host-key instruction when the key is unknown', async () => {
    const host = fakeHost({ check: failed(255, 'Host key verification failed.\n') })
    const setup = flow(host)
    const error = await setup.run().catch((failure: unknown) => failure)
    expect(error).toBeInstanceOf(SetupError)
    expect((error as Error).message).toContain('Host key verification failed.')
    expect((error as Error).message).toContain('Run “ssh me@devbox” once in a terminal')
    expect(host.commands).toEqual(['true'])
    expect(setup.progress).toEqual([
      { host: 'me@devbox', step: 'check', state: 'running' },
      expect.objectContaining({ step: 'check', state: 'failed' })
    ])
  })

  it('refuses a host that is not Linux, before installing anything', async () => {
    const host = fakeHost({ probe: '::styr os=Darwin\n::styr machine=arm64\n::styr arch=arm64\n' })
    await expect(flow(host).run()).rejects.toThrow(
      'me@devbox runs Darwin. Remote workspaces need a Linux host for now.'
    )
    expect(host.commands).toHaveLength(2)
  })

  it('warns, without refusing, about a missing git or CLI, no systemd, and lingering off', async () => {
    const host = fakeHost({
      probe:
        '::styr os=Linux\n::styr machine=x86_64\n::styr arch=x64\n::styr git=no\n::styr cli=no\n' +
        '::styr systemd=no\n::styr linger=no\n',
      install: ok('::styr source=download\n::styr systemd=no\n')
    })
    const result = await flow(host).run({ name: 'Devbox', host: 'devbox', provider: 'codex' })
    expect(result.warnings).toEqual([
      expect.stringMatching(/^git is not installed on devbox/),
      expect.stringMatching(/^codex is not on devbox's PATH/),
      expect.stringMatching(/no systemd user session.*nohup.*reboot/)
    ])
    // Without systemd there is nothing to linger for.
    expect(result.lingerCommand).toBeUndefined()

    const lingering = fakeHost({
      install: ok('::styr source=download\n::styr systemd=yes\n::styr linger=no\n')
    })
    expect((await flow(lingering).run()).lingerCommand).toBe('sudo loginctl enable-linger $USER')
  })

  it('reuses a server of this version already running, installing nothing', async () => {
    const host = fakeHost({ probe: `${PROBE}::styr running=${VERSION}\n` })
    const setup = flow(host)
    const result = await setup.run()
    expect(host.commands.some((command) => command.includes('--install'))).toBe(false)
    expect(result.transfer).toBe('running')
    expect(setup.created).toEqual(['me@devbox:Devbox'])
  })

  it('installs beside an older running server without restarting it, and says it takes over on upgrade', async () => {
    const host = fakeHost({
      probe: `${PROBE}::styr running=1.1.0\n`,
      install: ok(
        '::styr source=download\n::styr systemd=yes\n::styr linger=yes\n::styr running=1.1.0\n'
      )
    })
    const result = await flow(host).run()
    expect(host.commands.some((command) => command.includes('--restart'))).toBe(false)
    expect(result.warnings).toEqual([
      expect.stringMatching(/Styr 1\.1\.0 is still running.*1\.2\.0 is installed beside it/)
    ])
  })

  it('needs a name and a host ssh can reach', async () => {
    await expect(
      flow(fakeHost({})).run({ name: ' ', host: 'devbox', provider: 'claude' })
    ).rejects.toThrow('Give the workspace a name.')
    const host = fakeHost({})
    await expect(
      flow(host).run({ name: 'x', host: '-oProxyCommand=x', provider: 'claude' })
    ).rejects.toThrow(/not a host ssh can reach/)
    expect(host.commands).toEqual([])
  })
})

describe('running a host’s server', () => {
  it('restarts and stops through install.sh, passing the pid for a server no unit runs', async () => {
    const host = fakeHost({})
    const setup = createHostSetup(host.ports)
    await setup.restart('devbox', 4242)
    await setup.stop('devbox')
    await setup.start('devbox')
    expect(host.commands).toEqual([
      'sh -s -- --restart --pid 4242',
      'sh -s -- --stop',
      'sh -s -- --start'
    ])
  })

  it('reports the script’s own error when a step fails', async () => {
    const host = fakeHost({ other: failed(31, 'styr: the server is still running\n') })
    await expect(createHostSetup(host.ports).stop('devbox', 1)).rejects.toThrow(
      'Stopping the server on devbox failed: styr: the server is still running'
    )
  })
})
