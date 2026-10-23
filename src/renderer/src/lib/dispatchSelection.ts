/** The dialog's one-run override of the plan: a launch order and the ids left unchecked. */
export interface DispatchSelection {
  order: string[]
  skipped: string[]
}

/** Plan order, everything checked: what the dialog shows when it opens. */
export function initialSelection(planIds: readonly string[]): DispatchSelection {
  return { order: [...planIds], skipped: [] }
}

/**
 * Merges a refreshed plan into the user's choices: ids still in the plan keep their place and
 * check state, ids that left are dropped, new ids are appended checked.
 */
export function mergeSelection(
  previous: DispatchSelection,
  planIds: readonly string[]
): DispatchSelection {
  const inPlan = new Set(planIds)
  const kept = previous.order.filter((id) => inPlan.has(id))
  const known = new Set(kept)
  const added = planIds.filter((id) => !known.has(id))
  return {
    order: [...kept, ...added],
    skipped: previous.skipped.filter((id) => inPlan.has(id))
  }
}

/** The ids the confirm starts: checked rows, in the user's order. */
export function checkedIds(selection: DispatchSelection): string[] {
  const skipped = new Set(selection.skipped)
  return selection.order.filter((id) => !skipped.has(id))
}

/** Whether the order differs from the plan's (checks do not count). */
export function orderDiffers(selection: DispatchSelection, planIds: readonly string[]): boolean {
  return (
    selection.order.length !== planIds.length ||
    selection.order.some((id, index) => id !== planIds[index])
  )
}
