import type { ReactNode } from 'react'
import type { ShortcutBindings, ShortcutCommand } from '@core/types.js'
import { shortcutHint } from '@core/shortcuts.js'

function Glyph({ children }: { children: ReactNode }): ReactNode {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  )
}

const ICONS = {
  agents: (
    <Glyph>
      <rect x="2" y="3" width="12" height="10" rx="2" />
      <path d="M10 3v10" />
    </Glyph>
  ),
  terminal: (
    <Glyph>
      <path d="M3 4.5 6.5 8 3 11.5" />
      <path d="M8.5 11.5H13" />
    </Glyph>
  ),
  update: (
    <Glyph>
      <path d="M8 2.5v7.5" />
      <path d="M4.8 7 8 10.2 11.2 7" />
      <path d="M3 13h10" />
    </Glyph>
  ),
  settings: (
    <Glyph>
      <circle cx="8" cy="8" r="2.5" />
      <circle cx="8" cy="8" r="5.6" strokeDasharray="1.7 1.9" />
    </Glyph>
  )
}

function StatusItem({
  icon,
  label,
  count,
  badge,
  active = false,
  title,
  onClick
}: {
  icon: ReactNode
  label?: string
  count?: number
  badge?: number
  active?: boolean
  title: string
  onClick: () => void
}): ReactNode {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active}
      className={`flex h-full items-center gap-1.5 px-2.5 text-[11px] transition-colors ${
        active ? 'bg-raised text-ink' : 'text-dim hover:bg-raised hover:text-ink'
      }`}
      onClick={onClick}
    >
      <span className="flex items-center">{icon}</span>
      {label ? <span>{label}</span> : null}
      {badge !== undefined && badge > 0 ? (
        <span className="rounded bg-[var(--color-col-review)]/25 px-1 font-medium text-[var(--color-col-review)]">
          {badge}
        </span>
      ) : count !== undefined && count > 0 ? (
        <span className="font-mono text-[10px] text-faint">{count}</span>
      ) : null}
    </button>
  )
}

export function StatusBar({
  agentsOpen,
  terminalOpen,
  agentCount,
  waitingCount,
  sessionCount,
  summary,
  bindings,
  readyUpdate,
  onToggleAgents,
  onToggleTerminal,
  onOpenSettings,
  onInstallUpdate
}: {
  agentsOpen: boolean
  terminalOpen: boolean
  agentCount: number
  waitingCount: number
  sessionCount: number
  summary: string
  bindings: ShortcutBindings
  /** The version downloaded and waiting to install, if any. */
  readyUpdate?: string
  onToggleAgents: () => void
  onToggleTerminal: () => void
  onOpenSettings: () => void
  onInstallUpdate: () => void
}): ReactNode {
  const withKeys = (text: string, ...commands: ShortcutCommand[]): string => {
    const hints = commands.map((command) => shortcutHint(bindings, command)).filter(Boolean)
    return hints.length > 0 ? `${text}  (${hints.join(' or ')})` : text
  }

  return (
    <footer className="flex h-[26px] shrink-0 items-stretch border-t border-edge bg-chrome text-dim">
      <StatusItem
        icon={ICONS.agents}
        label="Agents"
        active={agentsOpen}
        count={agentCount}
        badge={waitingCount}
        title={
          waitingCount > 0
            ? `${waitingCount} agent${waitingCount === 1 ? '' : 's'} waiting on you`
            : withKeys('Toggle the agents sidebar', 'toggleAgents')
        }
        onClick={onToggleAgents}
      />
      <StatusItem
        icon={ICONS.terminal}
        label="Terminal"
        active={terminalOpen}
        count={sessionCount}
        title={withKeys('Toggle the terminal panel', 'toggleTerminal')}
        onClick={onToggleTerminal}
      />

      <div className="flex-1" />

      <span className="flex items-center px-2.5 text-[11px] text-faint">{summary}</span>

      {readyUpdate ? (
        <StatusItem
          icon={ICONS.update}
          label={`Restart to update to ${readyUpdate}`}
          active
          title={`Styr ${readyUpdate} is downloaded. It installs when you quit, or restart now.`}
          onClick={onInstallUpdate}
        />
      ) : null}

      <StatusItem
        icon={ICONS.settings}
        label="Settings"
        title={withKeys('Settings', 'settings')}
        onClick={onOpenSettings}
      />
    </footer>
  )
}
