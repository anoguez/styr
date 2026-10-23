export const RELEASES_API = 'https://api.github.com/repos/anoguez/styr/releases/tags'
const TIMEOUT_MS = 5_000

type FetchLike = (
  url: string,
  init: { signal: AbortSignal; headers: Record<string, string> }
) => Promise<{
  ok: boolean
  json: () => Promise<unknown>
}>

/**
 * The GitHub release body for a version: markdown that release-please wrote, fetched best-effort
 * by the main process. Any failure (offline, rate limit, 404, timeout) is a quiet `null`. A body is
 * cached per version; a failure is not, so the next discovery of that version may try again.
 */
export function createReleaseNotes(
  fetchFn: FetchLike,
  timeoutMs = TIMEOUT_MS
): { load: (version: string) => Promise<string | null>; get: (version: string) => string | null } {
  const cache = new Map<string, string>()
  const inflight = new Map<string, Promise<string | null>>()

  async function request(version: string): Promise<string | null> {
    try {
      const response = await fetchFn(`${RELEASES_API}/v${encodeURIComponent(version)}`, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: 'application/vnd.github+json' }
      })
      if (!response.ok) return null
      const body = ((await response.json()) as { body?: unknown } | null)?.body
      if (typeof body !== 'string' || body.trim() === '') return null
      cache.set(version, body)
      return body
    } catch {
      return null
    }
  }

  return {
    load(version) {
      const cached = cache.get(version)
      if (cached !== undefined) return Promise.resolve(cached)
      let pending = inflight.get(version)
      if (!pending) {
        pending = request(version).finally(() => inflight.delete(version))
        inflight.set(version, pending)
      }
      return pending
    },
    get: (version) => cache.get(version) ?? null
  }
}
