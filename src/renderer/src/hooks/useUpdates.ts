import { useEffect, useState } from 'react'
import type { UpdateState } from '@core/types.js'

/** The main process's updater state, kept live. Null until the first read returns. */
export function useUpdates(): UpdateState | null {
  const [state, setState] = useState<UpdateState | null>(null)

  useEffect(() => {
    void window.api.updates.state().then(setState)
    return window.api.updates.onState(setState)
  }, [])

  return state
}

/**
 * The GitHub release notes for the version being downloaded or ready, or null until fetched (or
 * when they could not be). The main process tells us to ask again by re-sending the state.
 */
export function useReleaseNotes(update: UpdateState | null): string | null {
  const version =
    update?.kind === 'ready' || update?.kind === 'downloading' ? update.version : undefined
  const [notes, setNotes] = useState<{ version: string; text: string } | null>(null)
  useEffect(() => {
    if (!version || notes?.version === version) return
    let live = true
    void window.api.updates.notes(version).then((text) => {
      if (live && text) setNotes({ version, text })
    })
    return () => {
      live = false
    }
  }, [version, notes, update])
  return version && notes?.version === version ? notes.text : null
}
