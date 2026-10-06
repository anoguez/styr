/**
 * `go` is ⌘P: things to jump to (tasks, agents, terminals). `command` is ⇧⌘P, or a leading `>`
 * typed into the go list: actions, workspaces and settings. Every entry belongs to exactly one.
 */
export type PaletteMode = 'go' | 'command'

/** Command mode is a `>` prefix on the input, so ⌘P plus `>` and ⇧⌘P read the same. */
export function splitQuery(raw: string): { mode: PaletteMode; text: string } {
  return raw.startsWith('>') ? { mode: 'command', text: raw.slice(1) } : { mode: 'go', text: raw }
}
