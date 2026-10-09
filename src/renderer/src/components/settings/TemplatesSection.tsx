import { useRef, type ReactNode } from 'react'
import type { PromptTemplate } from '@core/types.js'
import { Hint, inputBase } from '../ui.js'
import { addTemplate, insertToken, removeTemplate, routedTo } from './draft.js'
import type { SectionProps } from './sections.js'

const PLACEHOLDERS = [
  '{{id}}',
  '{{title}}',
  '{{description}}',
  '{{status}}',
  '{{priority}}',
  '{{readiness}}',
  '{{project}}',
  '{{tags}}',
  '{{filePath}}',
  '{{repoPath}}',
  '{{contextFiles}}',
  '{{board}}'
]

export function TemplatesSection({
  draft,
  patch,
  selectedId,
  onSelect
}: SectionProps & {
  /** Kept by the dialog, which selects the first template when another workspace loads. */
  selectedId: string
  onSelect: (id: string) => void
}): ReactNode {
  const bodyRef = useRef<HTMLTextAreaElement>(null)
  const selected = draft.promptTemplates.find((template) => template.id === selectedId) ?? null

  function updateTemplate(changes: Partial<PromptTemplate>): void {
    if (!selected) return
    patch({
      promptTemplates: draft.promptTemplates.map((template) =>
        template.id === selected.id ? { ...template, ...changes } : template
      )
    })
  }

  /** Put a placeholder where the caret is, replacing any selection, and keep typing from there. */
  function insertPlaceholder(token: string): void {
    const box = bodyRef.current
    if (!selected || !box) return
    const { text, caret } = insertToken(
      selected.template,
      box.selectionStart,
      box.selectionEnd,
      token
    )
    updateTemplate({ template: text })
    requestAnimationFrame(() => {
      box.focus()
      box.setSelectionRange(caret, caret)
    })
  }

  function add(): void {
    const { promptTemplates, id } = addTemplate(draft.promptTemplates)
    patch({ promptTemplates })
    onSelect(id)
  }

  function remove(): void {
    if (!selected) return
    const next = removeTemplate(draft, selected.id)
    if (!next) return
    patch(next)
    onSelect(next.promptTemplates[0]?.id ?? '')
  }

  return (
    <div className="grid h-full grid-cols-[180px_minmax(0,1fr)] gap-4">
      <div className="flex flex-col gap-0.5">
        {draft.promptTemplates.map((template) => (
          <button
            key={template.id}
            type="button"
            aria-current={template.id === selectedId}
            onClick={() => onSelect(template.id)}
            className={`flex flex-col items-start gap-0.5 rounded-[7px] border px-[9px] py-[7px] text-left transition-colors ${
              template.id === selectedId
                ? 'border-edge-strong bg-raised'
                : 'border-transparent hover:bg-raised/70'
            }`}
          >
            <span className="text-[12.5px] font-medium text-ink">{template.name}</span>
            <span className="text-[11px] text-faint">{routedTo(draft, template.id)}</span>
          </button>
        ))}
        <button
          type="button"
          onClick={add}
          className="mt-1 inline-flex h-7 items-center gap-1.5 rounded-[7px] border border-dashed border-edge-strong px-[9px] text-[12px] font-medium text-dim transition-colors hover:border-faint hover:text-ink"
        >
          <svg
            aria-hidden
            viewBox="0 0 16 16"
            width="12"
            height="12"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          >
            <path d="M8 3.5v9M3.5 8h9" />
          </svg>
          New template
        </button>
      </div>

      {selected ? (
        <div className="flex min-h-0 min-w-0 flex-col gap-2.5">
          <div className="flex items-center gap-2">
            <input
              aria-label="Template name"
              className={`${inputBase} h-8 flex-1 px-2.5 text-[13px] font-semibold`}
              value={selected.name}
              onChange={(event) => updateTemplate({ name: event.target.value })}
            />
            <button
              type="button"
              aria-label="Delete template"
              title="Delete template"
              onClick={remove}
              disabled={draft.promptTemplates.length <= 1}
              className="grid size-8 shrink-0 place-items-center rounded-[7px] text-danger transition-colors hover:bg-red-500/10 disabled:pointer-events-none disabled:opacity-35"
            >
              <svg
                aria-hidden
                viewBox="0 0 16 16"
                width="14"
                height="14"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" />
              </svg>
            </button>
          </div>
          <textarea
            ref={bodyRef}
            aria-label="Template body"
            className={`${inputBase} min-h-40 w-full flex-1 resize-none px-3.5 py-3 font-mono text-[12px] leading-[1.65]`}
            value={selected.template}
            onChange={(event) => updateTemplate({ template: event.target.value })}
          />
          <div className="flex flex-col gap-1.5">
            <Hint>
              Click to insert. The board protocol and context files are added automatically if you
              leave them out.
            </Hint>
            <div className="flex flex-wrap gap-1">
              {PLACEHOLDERS.map((token) => (
                <button
                  key={token}
                  type="button"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => insertPlaceholder(token)}
                  className="h-5 rounded-[5px] bg-raised px-1.5 font-mono text-[10.5px] text-dim transition-colors hover:bg-edge-strong hover:text-ink"
                >
                  {token}
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
