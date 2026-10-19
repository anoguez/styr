import { useRef, useState, type DragEvent, type ReactNode } from 'react'
import { withContextFiles } from '../../lib/taskForm.js'
import { fileName } from '../../lib/terminalPath.js'
import { localPickerBlocked, useBoardAccess } from '../../lib/remoteStatus.js'
import { FileIcon, PlusIcon } from '../icons.js'
import { GHOST_BTN, RemoveButton } from './fields.js'
import { PickerGuard } from '../PickerGuard.js'

/** The task's markdown description and the files whose paths go into its prompt. */
export function BriefTab({
  description,
  contextFiles,
  repoPath,
  onChange
}: {
  description: string
  contextFiles: string[]
  /** Where the file picker opens. */
  repoPath: string
  onChange: (changes: { description?: string; contextFiles?: string[] }) => void
}): ReactNode {
  // Files dragged in from Finder or an editor anywhere on the tab attach like picked ones.
  // dragenter/dragleave fire for every child crossed, so count them to know when the drag left.
  const [dragging, setDragging] = useState(false)
  const depth = useRef(0)
  // On a remote board this computer's files mean nothing to the agent: no picking, no dropping.
  const pickerBlocked = localPickerBlocked(useBoardAccess())
  const carriesFiles = (event: DragEvent): boolean =>
    !pickerBlocked && event.dataTransfer.types.includes('Files')
  const add = (picked: string[]): void =>
    onChange({ contextFiles: withContextFiles(contextFiles, picked) })

  return (
    <div
      className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 pb-5 pt-4"
      onDragEnter={(event) => {
        if (!carriesFiles(event)) return
        event.preventDefault()
        depth.current += 1
        setDragging(true)
      }}
      onDragOver={(event) => {
        if (!carriesFiles(event)) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
      }}
      onDragLeave={(event) => {
        if (!carriesFiles(event)) return
        depth.current = Math.max(0, depth.current - 1)
        if (depth.current === 0) setDragging(false)
      }}
      onDrop={(event) => {
        if (!carriesFiles(event)) return
        event.preventDefault()
        depth.current = 0
        setDragging(false)
        add(window.api.terminal.pathsForFiles(Array.from(event.dataTransfer.files)))
      }}
    >
      <textarea
        aria-label="Description (markdown)"
        value={description}
        placeholder="Describe the task: what to do, and how you will know it is done."
        onChange={(event) => onChange({ description: event.target.value })}
        className="min-h-60 w-full flex-1 resize-none rounded-[10px] border border-edge bg-chrome px-3.5 py-3 font-mono text-[12px] leading-[1.65] text-ink outline-none placeholder:text-faint focus:border-accent"
      />
      <div
        className={`-m-2 flex flex-col gap-2 rounded-[10px] border border-dashed p-2 ${
          dragging ? 'border-accent bg-accent/10' : 'border-transparent'
        }`}
      >
        <div className="flex items-center gap-2">
          <span className="shrink-0 text-[12px] font-semibold text-dim">Context files</span>
          <span className="min-w-0 truncate text-[11.5px] text-faint">
            {dragging
              ? 'Drop to attach.'
              : pickerBlocked
                ? 'Type the remote paths into the description; files here are on this computer.'
                : 'Add or drop files and folders. Only paths go into the prompt.'}
          </span>
          <PickerGuard className="ml-auto inline-flex">
            {(disabled) => (
              <button
                type="button"
                disabled={disabled}
                className={`${GHOST_BTN} h-6 shrink-0 disabled:pointer-events-none disabled:opacity-40`}
                onClick={() => {
                  void window.api.settings.pickFiles(repoPath || undefined).then(add)
                }}
              >
                <PlusIcon size={12} />
                Add
              </button>
            )}
          </PickerGuard>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {contextFiles.map((file) => (
            <span
              key={file}
              title={file}
              className="inline-flex h-[26px] max-w-full items-center gap-1.5 rounded-[7px] border border-edge bg-card pl-2 pr-1 text-[12px] text-ink"
            >
              <span className="text-faint">
                <FileIcon size={12} />
              </span>
              <span className="whitespace-nowrap">{fileName(file)}</span>
              <span className="truncate font-mono text-[10.5px] text-faint">
                {file.replace(/\/[^/]+$/, '')}
              </span>
              <RemoveButton
                label={`Remove ${file}`}
                onClick={() =>
                  onChange({ contextFiles: contextFiles.filter((current) => current !== file) })
                }
              />
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}
