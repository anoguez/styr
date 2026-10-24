import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { USAGE, parseServerArgs } from './cli.js'
import { attach, defaultSocketPath } from './socket.js'

/** Styr's version, set by `vite.server.config.ts` from package.json. */
declare const __STYR_VERSION__: string

/**
 * `styr serve`: the headless Styr server (see `docs/architecture/remote.md`). Built to
 * `out/server/index.mjs` and run by plain Node. `attach` loads only the socket code, never the
 * services or their native modules, because `ssh` starts one for every connection.
 */
async function main(): Promise<number> {
  const parsed = parseServerArgs(process.argv.slice(2))
  const socketPath = (command: { socket?: string }): string =>
    command.socket ?? process.env.STYR_SERVER_SOCKET ?? defaultSocketPath()

  switch (parsed.command) {
    case 'version':
      process.stdout.write(`${__STYR_VERSION__}\n`)
      return 0
    case 'help':
      process.stdout.write(`${USAGE}\n`)
      return 0
    case 'invalid':
      console.error(`styr: ${parsed.message}\n\n${USAGE}`)
      return 64
    case 'attach':
      return attach(socketPath(parsed), process.stdin, process.stdout, process.stderr)
    case 'serve': {
      const { serve } = await import('./serve.js')
      // out/server/index.mjs → the repo, or the bundle that holds out/ and resources/.
      const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
      await serve({
        socketPath: socketPath(parsed),
        version: __STYR_VERSION__,
        root,
        listen: parsed.listen,
        pair: parsed.pair
      })
      return 0
    }
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error('styr:', error instanceof Error ? error.message : error)
    process.exit(1)
  }
)
