// The server bundles' checksums, for the release workflow (docs/architecture/releases.md):
//
//   node scripts/server-checksums.mjs app <dir>       # out/main/serverBundles.json, inside the app
//   node scripts/server-checksums.mjs release <dir>   # <dir>/styr-server-<v>-SHA256SUMS, <dir>/install.sh
//
// <dir> holds styr-server-<version>-linux-x64.tar.gz and -linux-arm64.tar.gz (the build-server
// jobs' output). `app` runs after `yarn build` and before packaging, so the hashes ship inside the
// signed, notarised app: the desktop app sends them to the host, which refuses a download that
// does not match. `release` writes the files published next to the bundles: SHA256SUMS (which only
// catches a corrupt download made by hand) and install.sh with this version filled in.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const [mode, dir] = process.argv.slice(2)
if (!['app', 'release'].includes(mode) || !dir) {
  console.error('usage: node scripts/server-checksums.mjs app|release <dir>')
  process.exit(64)
}

const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const ARCHES = ['x64', 'arm64']
const sha256 = {}
for (const arch of ARCHES) {
  const name = `styr-server-${version}-linux-${arch}.tar.gz`
  const file = join(dir, name)
  if (!existsSync(file)) throw new Error(`${file} is missing: both server bundles are required.`)
  sha256[arch] = createHash('sha256').update(readFileSync(file)).digest('hex')
  console.log(`${sha256[arch]}  ${name}`)
}

if (mode === 'app') {
  const out = join(root, 'out', 'main')
  if (!existsSync(join(out, 'index.mjs'))) throw new Error('Run `yarn build` first.')
  mkdirSync(out, { recursive: true })
  writeFileSync(
    join(out, 'serverBundles.json'),
    `${JSON.stringify({ version, sha256 }, null, 2)}\n`
  )
  console.log(`wrote ${join(out, 'serverBundles.json')}`)
} else {
  const sums = ARCHES.map((arch) => `${sha256[arch]}  styr-server-${version}-linux-${arch}.tar.gz`)
  writeFileSync(join(dir, `styr-server-${version}-SHA256SUMS`), `${sums.join('\n')}\n`)
  const script = readFileSync(join(root, 'resources', 'server', 'install.sh'), 'utf8')
  if (!script.includes('@STYR_VERSION@'))
    throw new Error('install.sh has no @STYR_VERSION@ to fill in.')
  writeFileSync(join(dir, 'install.sh'), script.replaceAll('@STYR_VERSION@', version), {
    mode: 0o755
  })
  console.log(`wrote the SHA256SUMS and install.sh for ${version} in ${dir}`)
}
