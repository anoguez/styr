/** Wraps a value in single quotes for a POSIX shell, escaping any single quotes inside it. */
export function shellQuote(value: string): string {
  return value.replace(/'/g, "'\\''")
}
