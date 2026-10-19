// Builds the Styr server bundle for this machine's platform and arch:
// dist/styr-server-<version>-<platform>-<arch>.tar.gz (docs/architecture/remote.md).
//
//   node scripts/server-bundle.mjs        # after `yarn build:server` (or `yarn build`)
//
// The bundle holds its own Node runtime (this Node's version, checked against nodejs.org's
// SHASUMS256.txt), `out/server/` (the server and its MCP entry), `resources/claude/`, and a
// `node_modules/` with node-pty and better-sqlite3 installed by this Node's npm, so both are built
// for the bundled Node's ABI, never Electron's. `bin/styr` runs it. Releases build the linux-x64
// and linux-arm64 bundles on matching runners (.github/workflows/release.yml); on a Mac this builds
// a darwin one, which is only good for trying the bundle locally.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const platform = process.platform
const arch = process.arch
const NATIVE = ['node-pty', 'better-sqlite3']

if (!['linux', 'darwin'].includes(platform) || !['x64', 'arm64'].includes(arch)) {
  throw new Error(`No server bundle for ${platform}-${arch}.`)
}
if (!existsSync(join(root, 'out', 'server', 'index.mjs'))) {
  throw new Error('out/server/index.mjs is missing: run `yarn build:server` first.')
}

const name = `styr-server-${version}-${platform}-${arch}`
const dist = join(root, 'dist')
const work = join(dist, 'server-bundle')
const stage = join(work, name)
rmSync(work, { recursive: true, force: true })
mkdirSync(stage, { recursive: true })

console.log(`Building ${name}`)
cpSync(join(root, 'out', 'server'), join(stage, 'out', 'server'), { recursive: true })
cpSync(join(root, 'resources', 'claude'), join(stage, 'resources', 'claude'), { recursive: true })

// ── The Node runtime ──────────────────────────────────────────────────────────────────────
const nodeVersion = process.version
const nodeName = `node-${nodeVersion}-${platform}-${arch}`
const nodeBase = `https://nodejs.org/dist/${nodeVersion}`
const sums = await download(`${nodeBase}/SHASUMS256.txt`)
const nodeTarball = await download(`${nodeBase}/${nodeName}.tar.gz`)
const expected = sums
  .toString('utf8')
  .split('\n')
  .find((line) => line.endsWith(`  ${nodeName}.tar.gz`))
  ?.split(/\s+/)[0]
if (!expected || sha256(nodeTarball) !== expected) {
  throw new Error(`${nodeName}.tar.gz does not match nodejs.org's SHASUMS256.txt`)
}
writeFileSync(join(work, `${nodeName}.tar.gz`), nodeTarball)
execFileSync('tar', ['-xzf', `${nodeName}.tar.gz`], { cwd: work })
mkdirSync(join(stage, 'node', 'bin'), { recursive: true })
copyFileSync(join(work, nodeName, 'bin', 'node'), join(stage, 'node', 'bin', 'node'))
chmodSync(join(stage, 'node', 'bin', 'node'), 0o755)
copyFileSync(join(work, nodeName, 'LICENSE'), join(stage, 'node', 'LICENSE'))

// ── The native modules, for this Node's ABI ───────────────────────────────────────────────
// The exact versions the app was tested with: the ones in the repo's node_modules (the lockfile's).
const dependencies = Object.fromEntries(
  NATIVE.map((pkg) => [
    pkg,
    JSON.parse(readFileSync(join(root, 'node_modules', pkg, 'package.json'), 'utf8')).version
  ])
)
writeFileSync(
  join(stage, 'package.json'),
  `${JSON.stringify({ name: 'styr-server', version, private: true, dependencies }, null, 2)}\n`
)
execFileSync(
  'npm',
  ['install', '--omit=dev', '--no-audit', '--no-fund', '--no-package-lock', '--loglevel=error'],
  { cwd: stage, stdio: 'inherit', shell: false }
)

// ── The entry ─────────────────────────────────────────────────────────────────────────────
mkdirSync(join(stage, 'bin'), { recursive: true })
writeFileSync(
  join(stage, 'bin', 'styr'),
  `#!/bin/sh
# The Styr server bundle's entry: the bundle's own Node runs out/server/index.mjs.
# Resolved through ~/.styr/server/current, so a running server keeps the version it started with.
here="$(cd "$(dirname "$0")/.." && pwd -P)"
exec "$here/node/bin/node" "$here/out/server/index.mjs" "$@"
`
)
chmodSync(join(stage, 'bin', 'styr'), 0o755)
writeFileSync(join(stage, 'VERSION'), `${version}\n`)

// ── Check that it runs, with its own Node and its own native modules ──────────────────────
const said = execFileSync(join(stage, 'bin', 'styr'), ['serve', '--version'], { encoding: 'utf8' })
if (said.trim() !== version) throw new Error(`bin/styr says ${said.trim()}, expected ${version}`)
execFileSync(
  join(stage, 'node', 'bin', 'node'),
  [
    '-e',
    "const db = new (require('better-sqlite3'))(':memory:'); db.prepare('select 1').get(); require('node-pty')"
  ],
  { cwd: stage, stdio: 'inherit' }
)

const tarball = join(dist, `${name}.tar.gz`)
execFileSync('tar', ['-czf', tarball, '-C', stage, '.'])
rmSync(work, { recursive: true, force: true })
console.log(`${tarball}\nsha256 ${sha256(readFileSync(tarball))}`)

async function download(url) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}

function sha256(data) {
  return createHash('sha256').update(data).digest('hex')
}
