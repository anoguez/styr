import { DEFAULT_WORKSPACE_ID } from '@core/types.js'

/** Fixed hues, so a workspace keeps its colour across themes and launches. */
const WORKSPACE_COLOURS = [
  '#aa75b5',
  '#5f8df7',
  '#00c6c0',
  '#e0a458',
  '#e57a7a',
  '#7fd1a8',
  '#f9f871'
] as const

/**
 * The colour that marks a workspace in the UI. Derived from the id rather than stored: a workspace
 * is just a folder (see `core/workspaces.ts`), and the id never changes after creation, so the
 * colour is stable without adding anything to the folder to drift. Default always gets the first.
 */
export function workspaceColor(id: string): string {
  if (id === DEFAULT_WORKSPACE_ID) return WORKSPACE_COLOURS[0]
  let hash = 0
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return WORKSPACE_COLOURS[1 + (hash % (WORKSPACE_COLOURS.length - 1))]
}
