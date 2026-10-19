import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseInstallReport } from '@core/remoteSetup.js'

/**
 * `resources/server/install.sh`, run for real in a throwaway home, with stand-ins on PATH for what
 * a Linux VM has (`uname`, `curl`, `systemctl`, `loginctl`) and a fake server bundle whose
 * `bin/styr` answers `serve --version`, `serve attach` (alive or not) and `serve`. Nothing touches
 * the network, systemd or this machine's ~/.styr.
 */

const SCRIPT = readFileSync(resolve('resources/server/install.sh'), 'utf8')
const VERSION = '1.2.0'
const NAME = `styr-server-${VERSION}-linux-x64.tar.gz`

let home: string
let bin: string
let release: string
let bundle: Buffer
let hash: string

/** The fake server: alive while its state file exists; it writes its pid and stops on SIGTERM. */
const FAKE_STYR = `#!/bin/sh
state="$HOME/.styr/fake-server"
case "$1 \${2:-}" in
  "serve --version") echo ${VERSION} ;;
  "serve attach")
    if [ -f "$state" ]; then
      printf '{"jsonrpc":"2.0","method":"server:hello","params":[{"protocol":1,"version":"%s"}]}\\n' "$(cat "$state")"
      exit 0
    fi
    echo "styr: no Styr server is running" >&2
    exit 2 ;;
  "serve ")
    echo $$ > "$HOME/.styr/fake-pid"
    trap 'rm -f "$state"; exit 0' TERM INT
    echo ${VERSION} > "$state"
    while :; do sleep 0.05; done ;;
esac
`

function tool(name: string, body: string): void {
  writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`)
  chmodSync(join(bin, name), 0o755)
}

function useSystemd(): void {
  tool(
    'systemctl',
    `echo "$*" >> "$HOME/systemctl.log"
[ "$1" = --user ] && shift
case "$1" in
  show-environment | daemon-reload | enable) exit 0 ;;
  start | restart) nohup "$HOME/.styr/server/current/bin/styr" serve >/dev/null 2>&1 & exit 0 ;;
  is-active) [ -f "$HOME/.styr/fake-server" ] ;;
  stop) kill "$(cat "$HOME/.styr/fake-pid")" ;;
esac`
  )
}

function run(...args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const child = spawn('sh', ['-s', '--', ...args], {
      cwd: home,
      env: { HOME: home, SHELL: '/bin/sh', PATH: `${bin}:/usr/bin:/bin`, XDG_RUNTIME_DIR: home }
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += String(chunk)))
    child.stderr.on('data', (chunk) => (stderr += String(chunk)))
    child.on('close', (code) => done({ code, stdout, stderr }))
    child.stdin.end(SCRIPT)
  })
}

const alive = (): boolean => existsSync(join(home, '.styr', 'fake-server'))
const pid = (): string => readFileSync(join(home, '.styr', 'fake-pid'), 'utf8').trim()

describe.skipIf(process.platform === 'win32')('install.sh', () => {
  beforeEach(() => {
    home = mkdtempSync(join('/tmp', 'styr-i-'))
    bin = join(home, 'fakebin')
    release = join(home, 'release')
    mkdirSync(bin)
    mkdirSync(release)
    // The bundle: bin/styr is the fake server.
    const stage = join(home, 'stage')
    mkdirSync(join(stage, 'bin'), { recursive: true })
    writeFileSync(join(stage, 'bin', 'styr'), FAKE_STYR)
    chmodSync(join(stage, 'bin', 'styr'), 0o755)
    execFileSync('tar', ['-czf', join(release, NAME), '-C', stage, '.'])
    rmSync(stage, { recursive: true })
    bundle = readFileSync(join(release, NAME))
    hash = createHash('sha256').update(bundle).digest('hex')
    writeFileSync(join(release, `styr-server-${VERSION}-SHA256SUMS`), `${hash}  ${NAME}\n`)

    tool('uname', '[ "$1" = -m ] && echo x86_64 || echo Linux')
    tool('loginctl', 'echo Linger=no')
    tool('systemctl', 'exit 1')
    // curl serves the release from a folder, by the URL's last part, and logs what it fetched.
    tool(
      'curl',
      `for last; do :; done
echo "$last" >> "$HOME/curl.log"
while [ $# -gt 0 ]; do [ "$1" = -o ] && out="$2"; shift; done
cp "${release}/\${last##*/}" "$out" 2>/dev/null || { echo "curl: (22) 404" >&2; exit 22; }`
    )
  })

  afterEach(() => {
    try {
      if (alive()) process.kill(Number(pid()), 'SIGTERM')
    } catch {
      // Already gone.
    }
    rmSync(home, { recursive: true, force: true })
  })

  it('probes a fresh host without changing anything', async () => {
    const result = await run('--probe', '--version', VERSION, '--cli', 'no-such-agent-cli')
    expect(result.code).toBe(0)
    expect(parseInstallReport(result.stdout)).toEqual({
      os: 'Linux',
      machine: 'x86_64',
      arch: 'x64',
      git: 'yes',
      cli: 'no',
      systemd: 'no',
      linger: 'no'
    })
    expect(existsSync(join(home, '.styr'))).toBe(false)
  })

  it('downloads the bundle on the host, checks the hash it was given, unpacks it and starts it', async () => {
    const result = await run('--install', '--version', VERSION, '--sha256', hash)
    expect(result.stderr).toBe('')
    expect(result.code).toBe(0)
    expect(parseInstallReport(result.stdout)).toMatchObject({
      source: 'download',
      systemd: 'no',
      running: VERSION
    })
    expect(readFileSync(join(home, 'curl.log'), 'utf8').trim()).toBe(
      `https://github.com/anoguez/styr/releases/download/v${VERSION}/${NAME}`
    )
    expect(readlinkSync(join(home, '.styr', 'server', 'current'))).toBe(VERSION)
    expect(existsSync(join(home, '.styr', 'server', VERSION, 'bin', 'styr'))).toBe(true)
    expect(result.stdout).toMatch(/starting the server with nohup/)
    expect(alive()).toBe(true)
  })

  it('refuses a bundle whose hash differs from the one it was given, unpacking nothing', async () => {
    const result = await run('--install', '--version', VERSION, '--sha256', 'f'.repeat(64))
    expect(result.code).toBe(22)
    expect(result.stderr).toMatch(/does not match the expected SHA-256 \(refused to unpack it\)/)
    expect(existsSync(join(home, '.styr', 'server', VERSION))).toBe(false)
    expect(alive()).toBe(false)
  })

  it('by hand, checks the download against the release’s SHA256SUMS', async () => {
    const result = await run('--install', '--version', VERSION)
    expect(result.code).toBe(0)
    expect(readFileSync(join(home, 'curl.log'), 'utf8')).toContain(
      `styr-server-${VERSION}-SHA256SUMS`
    )
  })

  it('exits 20 when the host cannot download it, so the desktop app uploads it instead', async () => {
    rmSync(join(release, NAME))
    const failed = await run('--install', '--version', VERSION, '--sha256', hash)
    expect(failed.code).toBe(20)
    expect(failed.stderr).toMatch(/could not download/)

    // The upload: a tarball under the home folder, checked against the same hash, then removed.
    mkdirSync(join(home, '.styr', 'server'), { recursive: true })
    const uploaded = join('.styr', 'server', `upload-${NAME}`)
    writeFileSync(join(home, uploaded), bundle)
    const result = await run(
      '--install',
      '--version',
      VERSION,
      '--tarball',
      uploaded,
      '--sha256',
      hash
    )
    expect(result.code).toBe(0)
    expect(parseInstallReport(result.stdout).source).toBe('upload')
    expect(existsSync(join(home, uploaded))).toBe(false)
    expect(alive()).toBe(true)
  })

  it('reuses what is installed and never restarts a running server', async () => {
    await run('--install', '--version', VERSION, '--sha256', hash)
    const first = pid()
    const again = await run('--install', '--version', VERSION, '--sha256', hash)
    expect(again.code).toBe(0)
    expect(parseInstallReport(again.stdout)).toMatchObject({
      source: 'installed',
      running: VERSION
    })
    expect(again.stdout).toMatch(/already running; it keeps running/)
    expect(pid()).toBe(first)
    const probe = parseInstallReport((await run('--probe', '--version', VERSION)).stdout)
    expect(probe).toMatchObject({ installed: VERSION, has_version: 'yes', running: VERSION })
  })

  it('stops by pid without systemd, and restarts into what current points at', async () => {
    await run('--install', '--version', VERSION, '--sha256', hash)
    const refused = await run('--stop')
    expect(refused.code).toBe(31)
    const restarted = await run('--restart', '--pid', pid())
    expect(restarted.code).toBe(0)
    expect(alive()).toBe(true)
    const stopped = await run('--stop', '--pid', pid())
    expect(stopped.code).toBe(0)
    expect(alive()).toBe(false)
  })

  it('with systemd, writes the user unit, enables and starts it, and prints the linger command', async () => {
    useSystemd()
    const result = await run('--install', '--version', VERSION, '--sha256', hash)
    expect(result.code).toBe(0)
    expect(parseInstallReport(result.stdout)).toMatchObject({ systemd: 'yes', linger: 'no' })
    expect(result.stdout).toContain('  sudo loginctl enable-linger $USER')
    const unit = readFileSync(
      join(home, '.config', 'systemd', 'user', 'styr-server.service'),
      'utf8'
    )
    expect(unit).toContain('ExecStart=%h/.styr/server/current/bin/styr serve')
    expect(unit).toMatch(/^Environment="PATH=.+"$/m)
    expect(unit).toContain('WantedBy=default.target')
    expect(readFileSync(join(home, 'systemctl.log'), 'utf8')).toMatch(
      /--user daemon-reload\n--user enable styr-server.service\n--user start styr-server.service/
    )
    expect(alive()).toBe(true)
    // Stop goes through the unit.
    expect((await run('--stop')).code).toBe(0)
    expect(alive()).toBe(false)
  })

  it('refuses a host that is not Linux', async () => {
    tool('uname', '[ "$1" = -m ] && echo arm64 || echo Darwin')
    const result = await run('--install', '--version', VERSION, '--sha256', hash)
    expect(result.code).toBe(10)
    expect(result.stderr).toMatch(/runs Darwin; the Styr server runs on Linux only/)
  })
})
