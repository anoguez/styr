import type { ReactNode } from 'react'

/**
 * Whether the Done column has a footer at all. The column shows its empty state only without one,
 * so callers pass `DoneFooter` only when this holds.
 */
export function hasDoneFooter(
  hiddenDone: number,
  showAll: boolean,
  archivedCount: number
): boolean {
  return hiddenDone > 0 || showAll || archivedCount > 0
}

/** Under the Done column: reveal tasks the done cap hides, and open the archive. */
export function DoneFooter({
  hiddenDone,
  showAll,
  archivedCount,
  onToggleShowAll,
  onOpenArchive
}: {
  hiddenDone: number
  showAll: boolean
  archivedCount: number
  onToggleShowAll: () => void
  onOpenArchive: () => void
}): ReactNode {
  const canToggle = hiddenDone > 0 || showAll
  return (
    <div className="mt-auto flex shrink-0 flex-col items-center gap-1 pt-1 text-[11px] text-faint">
      {canToggle ? (
        <button type="button" className="hover:text-ink" onClick={onToggleShowAll}>
          {showAll ? 'Show fewer' : `${hiddenDone} older hidden — Show all`}
        </button>
      ) : null}
      {archivedCount > 0 ? (
        <button type="button" className="hover:text-ink" onClick={onOpenArchive}>
          {archivedCount} archived — View
        </button>
      ) : null}
    </div>
  )
}
