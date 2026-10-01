/**
 * Upgrades the provider fields of a task written before Codex support. Runs on raw data, before
 * validation, so an old file loads exactly as if it had been written today: the Claude-only
 * `claudeSessionId` becomes a provider-tagged `agentSession`, and every untagged history entry is
 * a Claude chat. Nothing is dropped — a pointer whose chat is missing from the history is added to
 * it as an earlier chat.
 */
export function migrateProviderFields(data: Record<string, unknown>): Record<string, unknown> {
  const { claudeSessionId, ...rest } = data
  const out: Record<string, unknown> = { ...rest }

  const sessions = Array.isArray(out.sessions)
    ? (out.sessions as Record<string, unknown>[]).map((entry) =>
        entry && typeof entry === 'object' && !entry.provider
          ? { ...entry, provider: 'claude' }
          : entry
      )
    : []

  if (typeof claudeSessionId === 'string' && claudeSessionId) {
    if (!out.agentSession) out.agentSession = { provider: 'claude', id: claudeSessionId }
    if (!sessions.some((entry) => entry?.id === claudeSessionId)) {
      sessions.unshift({
        id: claudeSessionId,
        provider: 'claude',
        startedAt: typeof out.updatedAt === 'string' ? out.updatedAt : new Date().toISOString(),
        label: 'Earlier chat'
      })
    }
  }
  if (sessions.length > 0 || 'sessions' in out) out.sessions = sessions
  return out
}
