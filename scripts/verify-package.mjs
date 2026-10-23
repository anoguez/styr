// Checks a packaged Windows or Linux build before the release job uploads it, as build-macos's
// "Verify signature and notarisation" step does for the Mac (docs/architecture/releases.md):
//
//   node scripts/verify-package.mjs win     # after electron-builder --win
//   node scripts/verify-package.mjs linux   # after electron-builder --linux
//
// - The server bundles' hashes (out/main/serverBundles.json) are inside the app, for this version:
//   without them a remote workspace cannot set up its host.
// - app-update.yml is inside the app, so the installed copy knows where its update feed is.
// - A vendored Styr Terminal brought exactly one binary, this platform's.
// - The feed file (latest.yml, latest-linux.yml) names every installer uploaded beside it.
// - Linux: no native module needs a glibc newer than GLIBC_FLOOR, the floor the docs promise.
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'dist')
/** Ubuntu 22.04's glibc, which build-linux runs on and Styr Terminal's linux-x64 binary needs. */
const GLIBC_FLOOR = '2.35'
const ELF = '\x7fELF'

const platform = process.argv[2]
if (!['win', 'linux'].includes(platform)) {
  console.error('usage: node scripts/verify-package.mjs win|linux')
  process.exit(64)
}

const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const resources = join(dist, platform === 'win' ? 'win-unpacked' : 'linux-unpacked', 'resources')
const failures = []
const check = (ok, message) => {
  if (ok) console.log(`ok: ${message}`)
  else failures.push(message)
}

const hashes = join(resources, 'app.asar.unpacked', 'out', 'main', 'serverBundles.json')
check(
  existsSync(hashes) && JSON.parse(readFileSync(hashes, 'utf8')).version === version,
  `serverBundles.json for ${version} is in the app`
)
check(existsSync(join(resources, 'app-update.yml')), 'app-update.yml is in the app')

if (existsSync(join(root, 'resources', 'native', 'styr-terminal'))) {
  const native = join(resources, 'native', 'styr-terminal')
  const binaries = existsSync(native) ? readdirSync(native).filter((f) => f.endsWith('.node')) : []
  check(binaries.length === 1, `exactly one Styr Terminal binary in the app (${binaries})`)
}

const feed = join(dist, platform === 'win' ? 'latest.yml' : 'latest-linux.yml')
const installers = existsSync(dist)
  ? readdirSync(dist).filter((f) =>
      platform === 'win'
        ? f === `Styr-Setup-${version}.exe`
        : f.endsWith('.AppImage') || f.endsWith('.deb')
    )
  : []
// Linux has two: the AppImage updates itself in place, a .deb install through DebUpdater (dpkg).
check(installers.length === (platform === 'win' ? 1 : 2), `installers in dist (${installers})`)
check(
  existsSync(feed) && installers.every((f) => readFileSync(feed, 'utf8').includes(f)),
  `${basename(feed)} names ${installers}`
)

if (platform === 'linux') {
  const modules = []
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) walk(path)
      // Only ELF files: node-pty also ships its macOS and Windows prebuilds, which Linux never loads.
      else if (
        name.endsWith('.node') &&
        readFileSync(path).subarray(0, 4).toString('latin1') === ELF
      )
        modules.push(path)
    }
  }
  walk(resources)
  check(modules.length > 0, `native modules found (${modules.length})`)
  const newer = (a, b) => a.localeCompare(b, undefined, { numeric: true }) > 0
  for (const module of modules) {
    const dump = spawnSync('objdump', ['-T', module], { encoding: 'utf8' })
    const needed = [...(dump.stdout ?? '').matchAll(/GLIBC_(\d+(?:\.\d+)+)/g)].map((m) => m[1])
    const highest = needed.reduce((a, b) => (newer(b, a) ? b : a), '0')
    check(
      dump.status === 0 && !newer(highest, GLIBC_FLOOR),
      `${module.slice(resources.length + 1)} needs glibc ${highest} (floor ${GLIBC_FLOOR})`
    )
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`::error::${failure}`)
  process.exit(1)
}
