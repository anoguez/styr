import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'

// Vite swaps node builtins for a stub that only throws once the renderer runs, so a stray
// `import … from 'node:fs'` in renderer-facing code reaches the user as a blank window.
// Vite does warn at build time — treat that warning as a build failure.
const EXTERNALIZED = /has been externalized for browser compatibility/i

// Run electron-vite's bin with this Node rather than through `npx`, which is `npx.cmd` on Windows
// and cannot be spawned without a shell there.
const child = spawn(
  process.execPath,
  ['node_modules/electron-vite/bin/electron-vite.js', 'build'],
  {
    shell: false
  }
)
let offending = []

function watch(stream, sink) {
  stream.setEncoding('utf8')
  stream.on('data', (chunk) => {
    sink.write(chunk)
    for (const line of chunk.split('\n')) {
      if (EXTERNALIZED.test(line)) offending.push(line.trim())
    }
  })
}

watch(child.stdout, process.stdout)
watch(child.stderr, process.stderr)

child.on('exit', (code) => {
  if (code !== 0) process.exit(code ?? 1)
  if (offending.length > 0) {
    console.error(
      '\nBuild failed: renderer code imports a Node builtin.\n' +
        offending.map((line) => `  ${line}`).join('\n') +
        '\n\nKeep renderer-facing code in the pure half (agentState.ts), not the node half ' +
        '(agentStore.ts).\n'
    )
    process.exit(1)
  }
  console.log('\nrenderer bundle is free of node builtins')
  checkSandboxedPreload()
  buildServer()
})

/**
 * The renderer is sandboxed, where the preload is one script that may require `electron` alone: a
 * chunk, a Node builtin or a bundled package would fail only when the window opens.
 */
function checkSandboxedPreload() {
  const preload = readFileSync('out/preload/index.cjs', 'utf8')
  const required = [...preload.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1])
  const others = required.filter((name) => name !== 'electron')
  if (others.length > 0 || /\bimport\s*\(/.test(preload)) {
    console.error(
      `\nBuild failed: the sandboxed preload loads ${others.join(', ') || 'a module dynamically'}. ` +
        'Only electron (contextBridge, ipcRenderer, webUtils) is available to it; move the rest ' +
        'behind IPC.\n'
    )
    process.exit(1)
  }
  console.log('preload requires electron alone (sandbox-safe)')
}

/** `styr serve`, for plain Node (vite.server.config.mts), into out/server/. */
function buildServer() {
  const server = spawn(
    process.execPath,
    ['node_modules/vite/bin/vite.js', 'build', '-c', 'vite.server.config.mts'],
    { shell: false, stdio: 'inherit' }
  )
  server.on('exit', (code) => {
    if (code !== 0) process.exit(code ?? 1)
    console.log('server bundle built in out/server')
  })
}
