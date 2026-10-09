import { describe, expect, it } from 'vitest'
import { COMMAND_NOT_FOUND, syntaxFor } from './shell.js'

describe('posix syntax', () => {
  const posix = syntaxFor('posix')

  it('types exactly what Styr has always typed into bash and zsh', () => {
    expect(posix.quote("/my dir/it's")).toBe(`'/my dir/it'\\''s'`)
    expect(posix.invoke('claude --model x')).toBe('claude --model x')
    expect(posix.fileContents('/tmp/T.txt')).toBe(`"$(cat '/tmp/T.txt')"`)
    expect(posix.cd('/a b')).toBe(`cd -- '/a b'`)
    expect(posix.exitIfNotFound('claude --version')).toBe('claude --version')
  })

  it('is the dialect when a session does not say', () => {
    expect(syntaxFor(undefined).dialect).toBe('posix')
  })
})

describe('powershell syntax', () => {
  const ps = syntaxFor('powershell')

  it('quotes literally, doubling single quotes', () => {
    expect(ps.quote("C:\\Users\\o'neil\\$HOME")).toBe("'C:\\Users\\o''neil\\$HOME'")
  })

  it('calls a configured command, even a quoted path, with &', () => {
    expect(ps.invoke('claude')).toBe('& claude')
    expect(ps.invoke("'C:\\Program Files\\claude.exe' --model x")).toBe(
      "& 'C:\\Program Files\\claude.exe' --model x"
    )
  })

  it('reads the prompt file as one string, keeping its line breaks', () => {
    expect(ps.fileContents('C:\\p\\T.txt')).toBe("(Get-Content -Raw -LiteralPath 'C:\\p\\T.txt')")
  })

  it('changes directory literally, so brackets in a path are not wildcards', () => {
    expect(ps.cd('C:\\repo [old]')).toBe("Set-Location -LiteralPath 'C:\\repo [old]'")
  })

  it('maps command-not-found to 127 by exception type, not by translated message', () => {
    const line = ps.exitIfNotFound('& claude --version')
    expect(line).toContain('catch [System.Management.Automation.CommandNotFoundException]')
    expect(line).toContain(`exit ${COMMAND_NOT_FOUND}`)
    expect(line).toContain('exit $LASTEXITCODE')
  })
})

describe('cmd syntax', () => {
  const cmd = syntaxFor('cmd')

  it('can change directory and quote paths', () => {
    expect(cmd.cd('D:\\a b')).toBe('cd /d "D:\\a b"')
    expect(cmd.quote('C:\\x y')).toBe('"C:\\x y"')
  })

  it('refuses to pass a file as one argument rather than pass it wrongly', () => {
    expect(() => cmd.fileContents('C:\\T.txt')).toThrow('cmd cannot')
  })
})
