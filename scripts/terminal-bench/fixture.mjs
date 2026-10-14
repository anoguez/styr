// Writes the fixtures for the terminal engine comparison (scripts/terminal-bench/README.md):
//
//   node scripts/terminal-bench/fixture.mjs [directory]
//
// burst-50m.txt is the 50 MiB burst; trickle-1m.txt is one minute's worth of the long-session
// trickle. The line mix is copied from styr-terminal's bench/bench.mjs (plain log lines, colours,
// unicode, long wrapped lines, bracketed-paste toggles), so the engine-only numbers there and the
// in-app numbers here describe the same bytes. Deterministic: every run writes identical files.
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const MiB = 1024 * 1024

/** At least `bytes` of mixed terminal output, whole lines only. */
export function makeOutput(bytes) {
  const parts = []
  let size = 0
  let i = 0
  while (size < bytes) {
    let line
    switch (i % 5) {
      case 0:
        line = `[${String(i).padStart(8, '0')}] INFO  request handled in ${i % 997}ms path=/api/v1/items/${i}\r\n`
        break
      case 1:
        line = `\x1b[32m✔\x1b[0m test ${i} \x1b[2m(${i % 89}ms)\x1b[22m — ok ünïcödé 漢字\r\n`
        break
      case 2:
        line = `\x1b[1;31merror\x1b[0m: \x1b[38;5;208mvalue ${i}\x1b[0m at \x1b[38;2;120;200;255msrc/lib.rs:${i % 400}\x1b[0m\r\n`
        break
      case 3:
        line = `${'x'.repeat(150 + (i % 50))}\r\n`
        break
      default:
        line = `$ \x1b[?2004hecho ${i}\x1b[?2004l\r\n`
    }
    parts.push(line)
    size += Buffer.byteLength(line)
    i++
  }
  return Buffer.from(parts.join(''))
}

export const FIXTURES = { 'burst-50m.txt': 50 * MiB, 'trickle-1m.txt': MiB }

export function writeFixtures(directory) {
  mkdirSync(directory, { recursive: true })
  for (const [name, bytes] of Object.entries(FIXTURES)) {
    writeFileSync(join(directory, name), makeOutput(bytes))
  }
  return directory
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const directory = writeFixtures(process.argv[2] ?? join(tmpdir(), 'styr-terminal-bench'))
  console.log(`Fixtures written to ${directory}: ${Object.keys(FIXTURES).join(', ')}`)
}
