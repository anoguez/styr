// Vendors Styr Terminal (the optional, private `@anoguez/styr-terminal` package) into
// resources/native/styr-terminal, where electron-builder picks it up. Run only by the protected
// release job, which alone holds STYR_TERMINAL_TOKEN (read:packages). See
// docs/architecture/terminal-engine.md.
//
// Everything that ends up in the app is pinned in native-terminal.lock.json: the exact version, the
// tarball's integrity hash, and the SHA-256 of each platform binary. A mismatch fails the release.
// No token, or a lock with nothing pinned, is a supported opt-out: the build goes on without the
// engine and every terminal uses xterm.js.
//
// The token goes only into the Authorization header of requests to the pinned registry. It is never
// printed, written to .npmrc or passed to another process.
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
export const DESTINATION = join(root, 'resources', 'native', 'styr-terminal')

/** `sha512-<base64>` (npm's integrity format) for `buffer`. */
export function integrityOf(buffer) {
  return `sha512-${createHash('sha512').update(buffer).digest('base64')}`
}

export function sha256Of(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

/** What is pinned, or why nothing will be fetched. */
export function pinned(lock, target) {
  if (!lock?.version || !lock.integrity) return { skip: 'nothing is pinned in the lock file' }
  const binary = lock.binaries?.[target]
  if (!binary?.file || !binary.sha256) return { skip: `no binary pinned for ${target}` }
  return { version: lock.version, integrity: lock.integrity, binary }
}

/** Checks the registry's record of the version against the pin before downloading anything. */
export function checkManifest(manifest, lock) {
  const entry = manifest?.versions?.[lock.version]
  if (!entry) throw new Error(`${lock.package}@${lock.version} is not in the registry`)
  if (entry.dist?.integrity !== lock.integrity) {
    throw new Error(`registry integrity for ${lock.version} does not match the lock file`)
  }
  const tarball = new URL(entry.dist.tarball)
  if (tarball.origin !== new URL(lock.registry).origin) {
    throw new Error(`tarball is served from ${tarball.origin}, not the pinned registry`)
  }
  return tarball.href
}

/** Checks the unpacked package: its name, version and the pinned binary's hash. */
export function checkPackage(directory, lock, binary) {
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
  if (manifest.name !== lock.package || manifest.version !== lock.version) {
    throw new Error(
      `unpacked ${manifest.name}@${manifest.version}, expected ${lock.package}@${lock.version}`
    )
  }
  const path = join(directory, binary.file)
  if (!existsSync(path)) throw new Error(`${binary.file} is missing from the package`)
  const actual = sha256Of(readFileSync(path))
  if (actual !== binary.sha256)
    throw new Error(`${binary.file} SHA-256 ${actual} does not match the lock file`)
}

async function get(url, token) {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json, application/octet-stream'
    },
    redirect: 'follow'
  })
  if (!response.ok) throw new Error(`GET ${new URL(url).pathname} failed: ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}

async function main() {
  const target = `${process.platform}-${process.arch}`
  const token = process.env.STYR_TERMINAL_TOKEN
  const lock = JSON.parse(readFileSync(join(root, 'native-terminal.lock.json'), 'utf8'))
  rmSync(DESTINATION, { recursive: true, force: true })

  const pin = pinned(lock, target)
  if (pin.skip)
    return console.log(`Styr Terminal: skipped (${pin.skip}); building with xterm.js only`)
  if (!token) return console.log('Styr Terminal: skipped (no token); building with xterm.js only')

  const name = encodeURIComponent(lock.package).replace(/^%40/, '@')
  const manifest = JSON.parse((await get(`${lock.registry}/${name}`, token)).toString('utf8'))
  const tarballUrl = checkManifest(manifest, lock)
  const tarball = await get(tarballUrl, token)
  const integrity = integrityOf(tarball)
  if (integrity !== lock.integrity)
    throw new Error('downloaded tarball does not match the pinned integrity')

  const work = mkdtempSync(join(tmpdir(), 'styr-terminal-'))
  try {
    const archive = join(work, 'package.tgz')
    writeFileSync(archive, tarball)
    const untar = spawnSync('tar', ['-xzf', archive, '-C', work], { stdio: 'inherit' })
    if (untar.status !== 0) throw new Error('could not unpack the tarball')
    checkPackage(join(work, 'package'), lock, pin.binary)
    mkdirSync(dirname(DESTINATION), { recursive: true })
    renameSync(join(work, 'package'), DESTINATION)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
  console.log(
    `Styr Terminal: vendored ${lock.package}@${lock.version} for ${target} (${pin.binary.sha256})`
  )
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    rmSync(DESTINATION, { recursive: true, force: true })
    console.error(`Styr Terminal: ${error.message}`)
    process.exit(1)
  })
}
