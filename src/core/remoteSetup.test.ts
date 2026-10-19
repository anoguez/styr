import { describe, expect, it } from 'vitest'
import { scpArgs, sshArgs, sshCommandArgs } from './remote.js'
import {
  LINGER_COMMAND,
  checksumFor,
  installCommand,
  installMessages,
  isHostKeyProblem,
  parseBundleHashes,
  parseInstallReport,
  parseProbe,
  releaseAssetUrl,
  serverBundleName,
  serverSumsName,
  sshFailureMessage,
  unsupportedHost,
  uploadPath
} from './remoteSetup.js'

const HASH = 'a'.repeat(64)

describe('the release’s files', () => {
  it('names the bundles, their checksums and where they download from', () => {
    expect(serverBundleName('0.35.0', 'arm64')).toBe('styr-server-0.35.0-linux-arm64.tar.gz')
    expect(serverSumsName('0.35.0')).toBe('styr-server-0.35.0-SHA256SUMS')
    expect(releaseAssetUrl('0.35.0', 'install.sh')).toBe(
      'https://github.com/anoguez/styr/releases/download/v0.35.0/install.sh'
    )
    expect(uploadPath('0.35.0', 'x64')).toBe(
      '.styr/server/upload-styr-server-0.35.0-linux-x64.tar.gz'
    )
  })

  it('reads a SHA256SUMS file, in text or binary mode', () => {
    const sums = `${HASH}  styr-server-1-linux-x64.tar.gz\n${'B'.repeat(64)} *styr-server-1-linux-arm64.tar.gz\n`
    expect(checksumFor(sums, 'styr-server-1-linux-x64.tar.gz')).toBe(HASH)
    expect(checksumFor(sums, 'styr-server-1-linux-arm64.tar.gz')).toBe('b'.repeat(64))
    expect(checksumFor(sums, 'other.tar.gz')).toBeUndefined()
  })

  it('takes only well-formed hashes from the app’s serverBundles.json', () => {
    expect(
      parseBundleHashes({ version: '1.0.0', sha256: { x64: HASH, arm64: 'not-a-hash' } })
    ).toEqual({ version: '1.0.0', sha256: { x64: HASH } })
    expect(parseBundleHashes({ sha256: {} })).toBeUndefined()
    expect(parseBundleHashes(null)).toBeUndefined()
  })
})

describe('install.sh over ssh', () => {
  it('pipes the script to sh -s with each argument quoted for the POSIX host', () => {
    expect(installCommand('probe', { version: '1.0.0' })).toBe("sh -s -- --probe --version '1.0.0'")
    expect(installCommand('install', { version: '1.0.0', tarball: "it's.tgz", sha256: HASH })).toBe(
      `sh -s -- --install --version '1.0.0' --tarball 'it'\\''s.tgz' --sha256 '${HASH}'`
    )
    expect(installCommand('stop', { pid: 42.7 })).toBe('sh -s -- --stop --pid 42')
  })

  it('reads the ::styr lines and keeps the rest for people', () => {
    const out = 'Installed it.\n::styr source=download\n::styr running=1.0.0\n\nDone.\n'
    expect(parseInstallReport(out)).toEqual({ source: 'download', running: '1.0.0' })
    expect(installMessages(out)).toEqual(['Installed it.', 'Done.'])
  })

  it('parses a probe, and refuses a host that is not Linux on x86_64 or aarch64', () => {
    const linux = parseProbe(
      '::styr os=Linux\n::styr machine=aarch64\n::styr arch=arm64\n' +
        '::styr systemd=yes\n::styr linger=no\n::styr installed=0.9.0\n::styr running=0.9.0\n'
    )
    expect(linux).toEqual({
      os: 'Linux',
      machine: 'aarch64',
      arch: 'arm64',
      systemd: true,
      linger: false,
      installed: '0.9.0',
      hasVersion: false,
      running: '0.9.0'
    })
    expect(unsupportedHost('devbox', linux)).toBeUndefined()
    expect(unsupportedHost('mac', parseProbe('::styr os=Darwin\n::styr machine=arm64\n'))).toBe(
      'mac runs Darwin. Remote workspaces need a Linux host for now.'
    )
    expect(
      unsupportedHost('pi', parseProbe('::styr os=Linux\n::styr machine=armv7l\n::styr arch=\n'))
    ).toMatch(/armv7l.*x86_64 and aarch64/)
    // The probe without the glibc lines (a host with no glibc to report) is not refused for it.
    expect(linux.glibc).toBeUndefined()
    // A server that answered without saying its version is still running.
    expect(parseProbe('::styr running=\n').running).toBe('unknown')
  })
})

describe('the glibc floor', () => {
  const probe = (glibc: string): string =>
    '::styr os=Linux\n::styr machine=x86_64\n::styr arch=x64\n' +
    `::styr glibc=${glibc}\n::styr glibc_floor=2.36\n` +
    '::styr glibc_hosts=Ubuntu 22.04+, Debian 12+, RHEL 9+\n'

  it('reads the host’s glibc and the floor the script reports', () => {
    expect(parseProbe(probe('2.39'))).toMatchObject({
      glibc: '2.39',
      glibcFloor: { version: '2.36', hosts: 'Ubuntu 22.04+, Debian 12+, RHEL 9+' }
    })
    expect(parseProbe(probe('not-a-version')).glibc).toBeUndefined()
  })

  it('refuses a host below the floor, naming the distributions that have it', () => {
    expect(unsupportedHost('devbox', parseProbe(probe('2.31')))).toBe(
      'devbox has glibc 2.31; the Styr server needs 2.36 or newer (Ubuntu 22.04+, Debian 12+, RHEL 9+).'
    )
    expect(unsupportedHost('devbox', parseProbe(probe('1.40')))).toMatch(/glibc 1.40/)
  })

  it('accepts the floor itself and anything newer, comparing numerically', () => {
    for (const glibc of ['2.36', '2.39', '2.100', '3.0']) {
      expect(unsupportedHost('devbox', parseProbe(probe(glibc)))).toBeUndefined()
    }
  })

  it('does not refuse a host whose glibc it could not tell', () => {
    expect(unsupportedHost('devbox', parseProbe(probe('')))).toBeUndefined()
  })
})

describe('ssh failures and host keys', () => {
  it('shows ssh’s words verbatim, with the hint about keys and Tailscale SSH', () => {
    const message = sshFailureMessage('devbox', 'me@devbox: Permission denied (publickey).\n', 255)
    expect(message).toContain('me@devbox: Permission denied (publickey).')
    expect(message).toMatch(/never asks for a password/)
    expect(message).toMatch(/Tailscale SSH/)
  })

  it('tells the user to accept an unknown or changed host key themselves, then Retry', () => {
    for (const said of [
      'Host key verification failed.',
      '@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@',
      'No ED25519 host key is known for devbox and you have requested strict checking.'
    ]) {
      expect(isHostKeyProblem(said)).toBe(true)
      const message = sshFailureMessage('devbox', said, 255)
      expect(message).toContain(said)
      expect(message).toContain('Run “ssh devbox” once in a terminal')
      expect(message).toContain('click Retry')
    }
    expect(isHostKeyProblem('Connection refused')).toBe(false)
  })

  it('never weakens host-key checking in any ssh or scp line Styr runs', () => {
    const lines = [
      sshArgs({ host: 'devbox', workspaceId: 'default' }),
      sshCommandArgs('devbox'),
      scpArgs('devbox', '/tmp/bundle.tgz', '.styr/server/upload.tgz'),
      ...(['probe', 'install', 'start', 'restart', 'stop'] as const).map((mode) => [
        installCommand(mode, {
          version: '1.0.0',
          sha256: HASH,
          tarball: 'x',
          pid: 1
        })
      ])
    ]
    for (const line of lines) {
      const text = line.join(' ')
      expect(text).not.toMatch(/StrictHostKeyChecking/i)
      expect(text).not.toMatch(/accept-new/i)
      expect(text).not.toMatch(/UserKnownHostsFile|known_hosts/i)
    }
    expect(sshCommandArgs('devbox')).toContain('BatchMode=yes')
    expect(scpArgs('devbox', 'f', 'p')).toEqual([
      '-q',
      '-B',
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=10',
      'f',
      'devbox:p'
    ])
  })

  it('shows the linger command to copy, as the user will run it', () => {
    expect(LINGER_COMMAND).toBe('sudo loginctl enable-linger $USER')
  })
})
