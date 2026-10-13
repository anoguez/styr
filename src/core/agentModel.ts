import type { PromptTemplate, Task } from './types.js'

type ProviderId = 'claude' | 'codex'

/**
 * The model a launch asks the CLI for, or undefined to leave it to the CLI's default. Model names
 * are provider-specific, so each source only counts for its own provider:
 *
 * - the task's model, while the launch uses the provider the task is set to (a Dispatch lane that
 *   routes the task to the other CLI must not hand it a name that CLI does not know);
 * - then the prompt template's model, when the launch sends the template and it names this provider.
 *
 * Pure, so the renderer can show what a launch will use.
 */
export function launchModel(
  task: Pick<Task, 'provider' | 'model'>,
  defaultProvider: ProviderId,
  provider: ProviderId,
  template?: Pick<PromptTemplate, 'model'>
): string | undefined {
  const own = (task.provider ?? defaultProvider) === provider ? task.model?.trim() : undefined
  const fromTemplate =
    template?.model?.provider === provider ? template.model.name.trim() : undefined
  return own || fromTemplate || undefined
}

/** `models` with `name` registered: trimmed, and not twice. Unchanged for a blank or known name. */
export function withModel(models: readonly string[], name: string): string[] {
  const trimmed = name.trim()
  return !trimmed || models.includes(trimmed) ? [...models] : [...models, trimmed]
}
