import type { ReactNode } from 'react'
import { fileName } from '../../lib/terminalPath.js'
import { FileIcon, PlusIcon } from '../icons.js'
import { GHOST_BTN, RemoveButton } from './fields.js'

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
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 pb-5 pt-4">
      <textarea
        aria-label="Description (markdown)"
        value={description}
        placeholder="Describe the task: what to do, and how you will know it is done."
        onChange={(event) => onChange({ description: event.target.value })}
        className="min-h-60 w-full flex-1 resize-none rounded-[10px] border border-edge bg-chrome px-3.5 py-3 font-mono text-[12px] leading-[1.65] text-ink outline-none placeholder:text-faint focus:border-accent"
      />
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <span className="text-[12px] font-semibold text-dim">Context files</span>
          <span className="text-[11.5px] text-faint">
            Files or folders. Paths go into the prompt; nothing is copied.
          </span>
          <button
            type="button"
            className={`${GHOST_BTN} ml-auto h-6`}
            onClick={() => {
              void window.api.settings.pickFiles(repoPath || undefined).then((picked) =>
                onChange({
                  contextFiles: [
                    ...contextFiles,
                    ...picked.filter((file) => !contextFiles.includes(file))
                  ]
                })
              )
            }}
          >
            <PlusIcon size={12} />
            Add
          </button>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {contextFiles.map((file) => (
            <span
              key={file}
              title={file}
              className="inline-flex h-[26px] max-w-full items-center gap-1.5 rounded-[7px] border border-edge bg-card pl-2 pr-1 text-[12px] text-ink"
            >
              <FileIcon size={12} />
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
