// Runs the smoke and feature tests (e2e/*.e2e.ts) against the packaged app, as the release jobs do
// between packaging and upload (docs/architecture/releases.md):
//
//   node scripts/packaged-smoke.mjs mac|win|linux     # after electron-builder, from the repo root
//
// The unpacked app in dist/ is enough: no installer is needed. STYR_APP_EXECUTABLE makes the
// harness (e2e/harness.ts) launch it instead of `out/`. Styr Terminal's spec skips itself without
// STYR_TERMINAL_PATH, so it never runs here. Exits with the tests' status.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const EXECUTABLES = {
  mac: join('mac-arm64', 'Styr.app', 'Contents', 'MacOS', 'Styr'),
  win: join('win-unpacked', 'Styr.exe'),
  linux: join('linux-unpacked', 'styr')
}

const platform = process.argv[2]
if (!(platform in EXECUTABLES)) {
  console.error('usage: node scripts/packaged-smoke.mjs mac|win|linux')
  process.exit(64)
}

const executable = join(root, 'dist', EXECUTABLES[platform])
if (!existsSync(executable)) {
  console.error(`no packaged app at ${executable}: run electron-builder first`)
  process.exit(1)
}

const env = { ...process.env, STYR_APP_EXECUTABLE: executable }
delete env.STYR_TERMINAL_PATH
const result = spawnSync('yarn', ['playwright', 'test'], {
  cwd: root,
  env,
  stdio: 'inherit',
  shell: process.platform === 'win32'
})
process.exit(result.status ?? 1)
