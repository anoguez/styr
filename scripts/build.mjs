import { spawn } from 'node:child_process'

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
})
