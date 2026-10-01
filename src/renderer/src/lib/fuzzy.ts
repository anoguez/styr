const BOUNDARY = /[\s\-_/.:]/

/**
 * Scores a subsequence match, or null when the query does not fit. Higher is better: matches at the
 * start of a word and runs of consecutive characters score well, scattered matches poorly, so
 * "trm" ranks "Toggle terminal" above a word that merely contains those letters apart.
 */
export function fuzzyScore(query: string, target: string): number | null {
  const q = query.trim().toLowerCase()
  if (q.length === 0) return 0
  const t = target.toLowerCase()

  let score = 0
  let cursor = 0
  let previousMatch = -2

  for (const char of q) {
    const found = t.indexOf(char, cursor)
    if (found === -1) return null

    const atStart = found === 0
    const afterBoundary = found > 0 && BOUNDARY.test(t[found - 1] as string)
    const consecutive = found === previousMatch + 1

    score += 10
    if (atStart) score += 30
    else if (afterBoundary) score += 20
    if (consecutive) score += 15
    score -= Math.min(found - cursor, 10)

    previousMatch = found
    cursor = found + 1
  }

  return score - Math.min(t.length - q.length, 20) / 4
}

export interface Ranked<T> {
  item: T
  score: number
}

export function rankBy<T>(query: string, items: T[], text: (item: T) => string): Ranked<T>[] {
  const ranked: Ranked<T>[] = []
  for (const item of items) {
    const score = fuzzyScore(query, text(item))
    if (score !== null) ranked.push({ item, score })
  }
  return ranked.sort((a, b) => b.score - a.score)
}
