// Rebuilds node-pty and better-sqlite3 against Electron's ABI — except on Windows.
//
// Both modules ship N-API prebuilds for win32 (better-sqlite3 only ever loads its prebuild; node-pty
// falls back to its own when build/Release holds no pty.node), and N-API binaries load in Electron
// unchanged. Compiling them from source on Windows needs Visual Studio *and* a matching Windows SDK,
// which is a large install for a build nobody uses, so it is skipped there. macOS keeps the rebuild.
import { spawnSync } from 'node:child_process'

if (process.platform === 'win32') {
  console.log('postinstall: skipping native rebuild on Windows (N-API prebuilds are used)')
  process.exit(0)
}

const result = spawnSync(
  process.execPath,
  ['node_modules/electron-builder/cli.js', 'install-app-deps'],
  { stdio: 'inherit' }
)
process.exit(result.status ?? 1)
