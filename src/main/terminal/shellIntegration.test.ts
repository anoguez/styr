import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { zshIntegrationScript } from './shellIntegration.js'

describe('zsh integration', () => {
  it('uses zsh lifecycle hooks and emits only Styr private OSC metadata', () => {
    const script = zshIntegrationScript()

    expect(script).toContain('preexec_functions+=(__styr_preexec)')
    expect(script).toContain('precmd_functions+=(__styr_precmd)')
    expect(script).toContain('chpwd_functions+=(__styr_chpwd)')
    expect(script).toContain('777;STYR;')
    expect(script).toContain('COMMAND_FINISHED')
  })

  it.skipIf(!existsSync('/bin/zsh'))('emits private OSC records from real zsh hooks', () => {
    const directory = mkdtempSync(join(tmpdir(), 'styr-zsh-integration-'))
    const scriptPath = join(directory, 'integration.zsh')
    writeFileSync(scriptPath, zshIntegrationScript(), 'utf8')

    try {
      const output = execFileSync(
        '/bin/zsh',
        [
          '-dfc',
          'source "$1"; __styr_preexec "echo hello"; print -n hello; __styr_precmd',
          'zsh',
          scriptPath
        ],
        { encoding: 'utf8' }
      )

      expect(output).toContain('\x1b]777;STYR;COMMAND_STARTED;')
      expect(output).toContain('\x1b]777;STYR;COMMAND_FINISHED;MA==\x1b\\')
      expect(output).toContain('\x1b]777;STYR;PROMPT_READY;')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
