import { execFile } from 'node:child_process'

/**
 * Whether Tailscale's Shields Up is on. With it on, Tailscale drops every connection coming in to
 * this computer, so a phone's pairing and sign-in time out with nothing in the log: Settings warns
 * instead. Read from `tailscale debug prefs`, run as a child process (never synchronously), whose
 * JSON carries `ShieldsUp`. Its other fields are never kept or logged.
 */

/** Runs one program and gives back its stdout; rejects when it is missing or fails. */
export type RunFile = (file: string, args: string[]) => Promise<string>

/**
 * Where the CLI may be. An app opened from the Finder gets a short PATH, so the usual install
 * places are tried after the bare name; on a Mac the App Store app's binary is the CLI too.
 */
export function tailscaleCandidates(platform: NodeJS.Platform = process.platform): string[] {
  if (platform === 'darwin') {
    return [
      'tailscale',
      '/usr/local/bin/tailscale',
      '/opt/homebrew/bin/tailscale',
      '/Applications/Tailscale.app/Contents/MacOS/Tailscale'
    ]
  }
  if (platform === 'win32') return ['tailscale', 'C:\\Program Files\\Tailscale\\tailscale.exe']
  return ['tailscale', '/usr/bin/tailscale', '/usr/local/bin/tailscale']
}

/** `ShieldsUp` from `tailscale debug prefs`, or undefined when the output says nothing usable. */
export function parseShieldsUp(stdout: string): boolean | undefined {
  try {
    const prefs: unknown = JSON.parse(stdout)
    const value = (prefs as { ShieldsUp?: unknown } | null)?.ShieldsUp
    return typeof value === 'boolean' ? value : undefined
  } catch {
    return undefined
  }
}

const runFile: RunFile = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 4000, windowsHide: true }, (error, stdout) =>
      error ? reject(error) : resolve(String(stdout))
    )
  })

/** Asks each candidate in turn; undefined when Tailscale is not installed or would not answer. */
export async function tailscaleShieldsUp(
  run: RunFile = runFile,
  candidates: string[] = tailscaleCandidates()
): Promise<boolean | undefined> {
  for (const file of candidates) {
    let stdout: string
    try {
      stdout = await run(file, ['debug', 'prefs'])
    } catch {
      continue
    }
    return parseShieldsUp(stdout)
  }
  return undefined
}
