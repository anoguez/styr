/** Strips Electron's "Error invoking remote method …" wrapper so a message reads as the app wrote it. */
export function ipcMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}
