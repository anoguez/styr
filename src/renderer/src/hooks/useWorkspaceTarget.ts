import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction
} from 'react'
import {
  workspaceSettingsFor,
  type Settings,
  type WorkspaceInfo,
  type WorkspaceSettings
} from '@core/types.js'
import type { Workspaces } from './useWorkspaces.js'

export interface WorkspaceTarget {
  workspaces: WorkspaceInfo[]
  editedWorkspaceId: string
  editedWorkspaceName: string
  savedWorkspaceSettings: WorkspaceSettings
  hasUnsavedChanges: boolean
  editingActiveWorkspace: boolean
  /** Some or all of the edited workspace's `settings.json` could not be used, so defaults fill in. */
  editedFileBroken: boolean
  /** A workspace picked while there were unsaved changes, waiting on Discard or Stay. */
  requestedWorkspaceId: string | null
  /** Why the edited workspace changed without being picked, or why a load failed. */
  notice: string
  choose: (id: string) => void
  confirmDiscard: () => void
  cancelSwitch: () => void
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Which workspace the Settings dialog edits. Switching swaps only the workspace keys of the draft —
 * app-level edits belong to no workspace and survive — and waits for Discard or Stay when it would
 * throw away unsaved changes. Only the newest load lands, so quick switches apply in order, and a
 * workspace deleted while it is being edited hands over to the active one with a notice.
 */
export function useWorkspaceTarget({
  settings,
  workspaces,
  draft,
  setDraft,
  onLoaded
}: {
  settings: Settings
  workspaces: Workspaces
  draft: Settings
  setDraft: Dispatch<SetStateAction<Settings>>
  /** Called with a newly loaded workspace's settings, after they are in the draft. */
  onLoaded: (loaded: WorkspaceSettings) => void
}): WorkspaceTarget {
  const activeWorkspaceId = settings.activeWorkspaceId
  const { overview, names } = workspaces
  const [editedWorkspaceId, setEditedWorkspaceId] = useState(activeWorkspaceId)
  const [savedWorkspaceSettings, setSavedWorkspaceSettings] = useState<WorkspaceSettings>(() =>
    workspaceSettingsFor(settings)
  )
  const [requestedWorkspaceId, setRequestedWorkspaceId] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const [brokenWorkspaceIds, setBrokenWorkspaceIds] = useState<ReadonlySet<string>>(new Set())
  const loadRequestCount = useRef(0)
  const lastKnownName = useRef(names.get(activeWorkspaceId) ?? activeWorkspaceId)
  const onLoadedRef = useRef(onLoaded)

  const editedWorkspaceName = names.get(editedWorkspaceId) ?? lastKnownName.current
  const hasUnsavedChanges = useMemo(
    () => JSON.stringify(workspaceSettingsFor(draft)) !== JSON.stringify(savedWorkspaceSettings),
    [draft, savedWorkspaceSettings]
  )
  const editedDeleted =
    overview.workspaces.length > 0 &&
    !overview.workspaces.some((workspace) => workspace.id === editedWorkspaceId)

  useEffect(() => {
    onLoadedRef.current = onLoaded
  }, [onLoaded])

  useEffect(() => {
    const name = names.get(editedWorkspaceId)
    if (name) lastKnownName.current = name
  }, [names, editedWorkspaceId])

  useEffect(() => {
    window.api.settings.brokenFiles().then(
      (files) => setBrokenWorkspaceIds(new Set(files.map((file) => file.workspaceId))),
      (error: unknown) => setNotice(`Couldn't check the settings files: ${errorMessage(error)}`)
    )
  }, [])

  const load = useCallback(
    (id: string, noticeOnLoad = '') => {
      const request = ++loadRequestCount.current
      setRequestedWorkspaceId(null)
      window.api.settings.get(id).then(
        (loaded) => {
          if (request !== loadRequestCount.current) return
          const own = workspaceSettingsFor(loaded)
          const resolvedId = loaded.activeWorkspaceId
          setDraft((current) => ({ ...current, ...own }))
          setSavedWorkspaceSettings(own)
          setEditedWorkspaceId(resolvedId)
          setNotice(
            resolvedId === id
              ? noticeOnLoad
              : 'That workspace no longer exists, so the Default workspace is shown instead.'
          )
          onLoadedRef.current(own)
        },
        (error: unknown) => {
          if (request !== loadRequestCount.current) return
          setNotice(`Couldn't load that workspace's settings: ${errorMessage(error)}`)
        }
      )
    },
    [setDraft]
  )

  useEffect(() => {
    if (!editedDeleted) return
    const name = lastKnownName.current
    load(
      activeWorkspaceId,
      hasUnsavedChanges
        ? `${name} was deleted, so its unsaved changes were discarded.`
        : `${name} was deleted.`
    )
  }, [editedDeleted, activeWorkspaceId, hasUnsavedChanges, load])

  const choose = useCallback(
    (id: string) => {
      if (id === editedWorkspaceId) setRequestedWorkspaceId(null)
      else if (hasUnsavedChanges) setRequestedWorkspaceId(id)
      else load(id)
    },
    [editedWorkspaceId, hasUnsavedChanges, load]
  )

  const confirmDiscard = useCallback(() => {
    if (requestedWorkspaceId) load(requestedWorkspaceId)
  }, [requestedWorkspaceId, load])

  const cancelSwitch = useCallback(() => setRequestedWorkspaceId(null), [])

  return {
    workspaces: overview.workspaces,
    editedWorkspaceId,
    editedWorkspaceName,
    savedWorkspaceSettings,
    hasUnsavedChanges,
    editingActiveWorkspace: editedWorkspaceId === activeWorkspaceId,
    editedFileBroken: brokenWorkspaceIds.has(editedWorkspaceId),
    requestedWorkspaceId,
    notice,
    choose,
    confirmDiscard,
    cancelSwitch
  }
}
