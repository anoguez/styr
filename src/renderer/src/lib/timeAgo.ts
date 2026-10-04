/** `14s`, `2m`, `3h`, `1d` since an ISO timestamp; empty when there is none or it is in the future. */
export function timeAgo(iso?: string): string {
  if (!iso) return ''
  const seconds = Math.round((Date.now() - Date.parse(iso)) / 1000)
  if (!Number.isFinite(seconds) || seconds < 0) return ''
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`
  return `${Math.floor(seconds / 86400)}d`
}
