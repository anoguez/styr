import { useEffect, useState, type ReactNode } from 'react'
import { AGENT_PROVIDER_LABELS } from '@core/types.js'
import { AgentCliStatus } from '../AgentCliStatus.js'
import { Button, Card, Chip, Hint, Segmented, Switch, inputBase } from '../ui.js'
import { withProvider } from './draft.js'
import type { SectionProps } from './sections.js'

export function AgentsSection({ draft, patch }: SectionProps): ReactNode {
  const [mcpCommand, setMcpCommand] = useState('')
  const [codexMcpCommand, setCodexMcpCommand] = useState('')
  const [copied, setCopied] = useState<'claude' | 'codex' | null>(null)

  useEffect(() => {
    void window.api.app.mcpCommand('claude').then(setMcpCommand)
    void window.api.app.mcpCommand('codex').then(setCodexMcpCommand)
  }, [])

  function toggleProvider(provider: 'claude' | 'codex', enabled: boolean): void {
    const next = withProvider(draft, provider, enabled)
    if (next) patch(next)
  }

  return (
    <>
      {(
        [
          { id: 'claude', label: AGENT_PROVIDER_LABELS.claude, command: draft.claudeCommand },
          { id: 'codex', label: AGENT_PROVIDER_LABELS.codex, command: draft.codexCommand }
        ] as const
      ).map((provider) => {
        const on = draft.enabledProviders.includes(provider.id)
        const only = on && draft.enabledProviders.length === 1
        const isDefault = on && draft.defaultProvider === provider.id
        const mcp = provider.id === 'claude' ? mcpCommand : codexMcpCommand
        return (
          <Card key={provider.id}>
            <div className="flex items-center gap-3 px-3.5 py-3">
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex items-center gap-2 text-[13px] font-semibold text-ink">
                  {provider.label}
                  {isDefault ? <Chip tone="accent">Default</Chip> : null}
                </span>
                <span className="text-[11.5px] text-faint">
                  {!on
                    ? 'Off. Tasks and lanes cannot use it.'
                    : isDefault
                      ? 'Used by manual launches. Dispatch lanes can pick either.'
                      : 'Available for tasks and Dispatch lanes.'}
                </span>
              </span>
              {on && !isDefault ? (
                <Button variant="subtle" onClick={() => patch({ defaultProvider: provider.id })}>
                  Make default
                </Button>
              ) : null}
              <Switch
                label={`Enable ${provider.label}`}
                checked={on}
                disabled={only}
                title={only ? 'At least one provider must stay on' : undefined}
                onChange={(enabled) => toggleProvider(provider.id, enabled)}
              />
            </div>

            {on ? (
              <div className="flex flex-col gap-3 border-t border-edge px-3.5 pb-3.5 pt-3">
                <div className="grid grid-cols-[96px_minmax(0,1fr)] items-center gap-2.5">
                  <span className="text-[12px] text-dim">Command</span>
                  <input
                    aria-label={`${provider.label} command`}
                    className={`${inputBase} h-7 w-full max-w-[260px] px-2.5 font-mono text-[11.5px]`}
                    value={provider.command}
                    onChange={(event) =>
                      patch(
                        provider.id === 'claude'
                          ? { claudeCommand: event.target.value }
                          : { codexCommand: event.target.value }
                      )
                    }
                  />
                </div>

                <div className="grid grid-cols-[96px_minmax(0,1fr)] items-start gap-2.5">
                  <span className="pt-[3px] text-[12px] text-dim">Status</span>
                  <AgentCliStatus
                    provider={provider.id}
                    command={provider.command}
                    shell={draft.shell}
                  />
                </div>

                {provider.id === 'claude' ? (
                  <div className="grid grid-cols-[96px_minmax(0,1fr)] items-start gap-2.5">
                    <span className="pt-[5px] text-[12px] text-dim">Approvals</span>
                    <div className="flex flex-col gap-1.5">
                      <Segmented
                        label="Claude approvals"
                        value={draft.claudeApprovalMode}
                        onChange={(claudeApprovalMode) => patch({ claudeApprovalMode })}
                        options={[
                          { value: 'user', label: 'Ask me' },
                          { value: 'auto', label: 'Approve for me' }
                        ]}
                      />
                      <Hint>
                        {draft.claudeApprovalMode === 'user'
                          ? 'Claude Code pauses and asks before risky actions.'
                          : 'Permission prompts go to Claude Code’s auto mode classifier; it does not grant full access. Needs a recent Claude Code.'}
                      </Hint>
                    </div>
                  </div>
                ) : null}

                {provider.id === 'codex' ? (
                  <div className="grid grid-cols-[96px_minmax(0,1fr)] items-start gap-2.5">
                    <span className="pt-[5px] text-[12px] text-dim">Approvals</span>
                    <div className="flex flex-col gap-1.5">
                      <Segmented
                        label="Codex approvals"
                        value={draft.codexApprovalReviewer}
                        onChange={(codexApprovalReviewer) => patch({ codexApprovalReviewer })}
                        options={[
                          { value: 'user', label: 'Ask me' },
                          { value: 'auto_review', label: 'Approve for me' }
                        ]}
                      />
                      <Hint>
                        {draft.codexApprovalReviewer === 'user'
                          ? 'Codex pauses and asks before risky commands.'
                          : 'Eligible requests go to Codex’s automatic reviewer; it does not grant full access.'}{' '}
                        Codex runs in the workspace-write sandbox with network access, so it can
                        push and use `gh`.
                      </Hint>
                    </div>
                  </div>
                ) : null}

                <div className="grid grid-cols-[96px_minmax(0,1fr)] items-start gap-2.5">
                  <span className="pt-1.5 text-[12px] text-dim">Board access</span>
                  <div className="flex min-w-0 flex-col gap-1.5">
                    <div className="flex min-w-0 items-center gap-1.5 rounded-[7px] border border-edge bg-surface py-1 pl-2.5 pr-1">
                      <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-dim">
                        {mcp || 'Building command…'}
                      </code>
                      <Button
                        className="h-6 shrink-0 px-2 text-[11.5px]"
                        disabled={!mcp}
                        onClick={() => {
                          void navigator.clipboard.writeText(mcp).then(() => {
                            setCopied(provider.id)
                            setTimeout(() => setCopied(null), 1600)
                          })
                        }}
                      >
                        {copied === provider.id ? 'Copied' : 'Copy'}
                      </Button>
                    </div>
                    <Hint>
                      Run once in a terminal, then start a new {provider.label} session. It lets the
                      agent read and move tasks on the board from anywhere. Registered once for
                      every workspace, built from the active workspace’s command.
                    </Hint>
                  </div>
                </div>
              </div>
            ) : null}
          </Card>
        )
      })}
    </>
  )
}
