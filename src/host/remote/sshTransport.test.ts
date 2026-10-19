import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sshTransport } from './sshTransport.js'

// A stand-in `ssh` on PATH: it echoes its arguments, then a line read from stdin, and complains on
// stderr before exiting, as a refused connection would.
describe.skipIf(process.platform === 'win32')('sshTransport', () => {
  let dir: string
  let path: string | undefined

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'styr-ssh-'))
    const ssh = join(dir, 'ssh')
    writeFileSync(
      ssh,
      '#!/bin/sh\necho "args: $*"\nread line\necho "got: $line"\necho "Permission denied" >&2\nexit 255\n'
    )
    chmodSync(ssh, 0o755)
    path = process.env.PATH
  })

  afterEach(() => {
    process.env.PATH = path
    rmSync(dir, { recursive: true, force: true })
  })

  it('runs ssh from PATH with the batch-mode arguments, piping stdio, and reports its exit', async () => {
    process.env.PATH = `${dir}:/usr/bin:/bin`
    const child = sshTransport({ host: 'devbox', workspaceId: 'default' })
    let out = ''
    let err = ''
    child.onStdout((chunk) => (out += String(chunk)))
    child.onStderr((chunk) => (err += String(chunk)))
    const exit = new Promise<number | null>((resolve) => child.onExit((code) => resolve(code)))
    child.write('hello\n')
    expect(await exit).toBe(255)
    expect(out).toContain('args: -T -o BatchMode=yes')
    expect(out).toContain('devbox styr serve attach')
    expect(out).toContain('got: hello')
    expect(err).toContain('Permission denied')
    // Writing after the exit is harmless.
    child.write('late\n')
    child.kill()
  })

  it('reports a missing ssh as an error rather than throwing', async () => {
    process.env.PATH = dir.replace(/$/, '-missing')
    const child = sshTransport({ host: 'devbox', workspaceId: 'default' })
    const error = await new Promise<Error | undefined>((resolve) =>
      child.onExit((_code, failure) => resolve(failure))
    )
    expect((error as NodeJS.ErrnoException).code).toBe('ENOENT')
  })
})
