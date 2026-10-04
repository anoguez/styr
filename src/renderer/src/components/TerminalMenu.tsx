import { useEffect, useRef, type ReactNode } from 'react'

function Kbd({ children }: { children: ReactNode }): ReactNode {
  return <span className="font-mono text-[10px] text-faint">{children}</span>
}

export interface MenuItem {
  label: string
  kbd?: string
  agent?: boolean
  disabled?: boolean
  run: () => void
}

/** A small menu of actions, opened from a "⋯" button. Arrow keys move, Escape closes. */
export function ActionsMenu({
  groups,
  onClose,
  className = 'bottom-full right-1.5 mb-1'
}: {
  groups: MenuItem[][]
  onClose: () => void
  /** Where the menu sits relative to whatever it opens from. */
  className?: string
}): ReactNode {
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    root.current?.querySelector<HTMLElement>('button:not(:disabled)')?.focus()
    const close = (event: MouseEvent): void => {
      if (!root.current?.contains(event.target as Node)) onClose()
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [onClose])

  return (
    <div
      ref={root}
      role="menu"
      className={`pointer-events-auto absolute z-20 flex w-[232px] ${className} flex-col rounded-lg border border-edge-strong bg-panel p-1 shadow-2xl`}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          onClose()
        } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          const items = [
            ...(root.current?.querySelectorAll<HTMLElement>('button:not(:disabled)') ?? [])
          ]
          const at = items.indexOf(document.activeElement as HTMLElement)
          const step = event.key === 'ArrowDown' ? 1 : -1
          items[(at + step + items.length) % items.length]?.focus()
        }
      }}
    >
      {groups.map((group, index) => (
        <div key={index} className={index > 0 ? 'mt-1 border-t border-edge pt-1' : ''}>
          {group.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              className={`flex h-[26px] w-full items-center gap-2 rounded-md px-2 text-left text-[12.5px] hover:bg-raised focus:bg-raised focus:outline-none disabled:opacity-40 ${
                item.agent ? 'text-[#d9b4e0]' : 'text-ink'
              }`}
              onClick={() => {
                onClose()
                item.run()
              }}
            >
              <span className="flex-1">{item.label}</span>
              {item.kbd ? <Kbd>{item.kbd}</Kbd> : null}
            </button>
          ))}
        </div>
      ))}
    </div>
  )
}
