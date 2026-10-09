import {
  TASK_STATUS_LABELS,
  TASK_STATUSES,
  type PromptTemplate,
  type Settings,
  type UpdateState
} from '@core/types.js'

type Provider = Settings['defaultProvider']

/**
 * Switches a provider on or off. The last one cannot go off (null: no change), and the default moves
 * to a provider that is still on.
 */
export function withProvider(
  draft: Pick<Settings, 'enabledProviders' | 'defaultProvider'>,
  provider: Provider,
  enabled: boolean
): Pick<Settings, 'enabledProviders' | 'defaultProvider'> | null {
  const enabledProviders = enabled
    ? [...new Set([...draft.enabledProviders, provider])]
    : draft.enabledProviders.filter((item) => item !== provider)
  if (enabledProviders.length === 0) return null
  return {
    enabledProviders,
    defaultProvider: enabledProviders.includes(draft.defaultProvider)
      ? draft.defaultProvider
      : enabledProviders[0]!
  }
}

export function slugId(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'template'
  )
}

/** Which routing slots point at a template, for the template list's subtitle. */
export function routedTo(settings: Pick<Settings, 'promptRouting'>, id: string): string {
  const used = [
    settings.promptRouting.needsSpec === id ? 'Needs spec' : null,
    ...TASK_STATUSES.map((status) =>
      settings.promptRouting.byStatus[status] === id ? TASK_STATUS_LABELS[status] : null
    )
  ].filter((label): label is string => label !== null)
  return used.length > 0 ? used.join(', ') : 'Not routed'
}

/** A starter template appended to the list, with the id to select. */
export function addTemplate(templates: PromptTemplate[]): {
  promptTemplates: PromptTemplate[]
  id: string
} {
  const id = slugId(`template ${templates.length + 1}`)
  return {
    id,
    promptTemplates: [
      ...templates,
      { id, name: 'New template', template: 'Work on {{id}}: {{title}}\n\n{{description}}' }
    ]
  }
}

/**
 * Removes a template, moving the fallback off it when it was the fallback. The last one stays (null),
 * since a prompt always needs a template.
 */
export function removeTemplate(
  draft: Pick<Settings, 'promptTemplates' | 'defaultPromptTemplateId'>,
  id: string
): Pick<Settings, 'promptTemplates' | 'defaultPromptTemplateId'> | null {
  if (draft.promptTemplates.length <= 1) return null
  const remaining = draft.promptTemplates.filter((template) => template.id !== id)
  return {
    promptTemplates: remaining,
    defaultPromptTemplateId:
      draft.defaultPromptTemplateId === id
        ? (remaining[0]?.id ?? 'default')
        : draft.defaultPromptTemplateId
  }
}

/** `text` with `token` in place of the selection `[start, end)`, and where the caret goes after. */
type TemplateModel = PromptTemplate['model']

/** A template model as one `<select>` value: `provider:name`, or empty for the CLI default. */
export function modelValue(model: TemplateModel): string {
  return model ? `${model.provider}:${model.name}` : ''
}

/** Back from `modelValue`. Splits on the first colon only: Bedrock-style names contain colons. */
export function parseModelValue(value: string): TemplateModel {
  const at = value.indexOf(':')
  if (at === -1) return undefined
  const provider = value.slice(0, at)
  const name = value.slice(at + 1)
  return (provider === 'claude' || provider === 'codex') && name ? { provider, name } : undefined
}

/**
 * What a template's Model dropdown offers: the registered models of each enabled provider, plus
 * the template's current one if it has since been unregistered or its provider switched off, so
 * the control never shows a choice the file does not hold.
 */
export function modelChoices(
  settings: Pick<Settings, 'enabledProviders' | 'agentModels'>,
  current: TemplateModel
): { provider: 'claude' | 'codex'; models: string[] }[] {
  const providers =
    current && !settings.enabledProviders.includes(current.provider)
      ? [...settings.enabledProviders, current.provider]
      : settings.enabledProviders
  return providers
    .map((provider) => {
      const models = settings.agentModels[provider]
      const kept =
        current?.provider === provider && !models.includes(current.name)
          ? [...models, current.name]
          : models
      return { provider, models: kept }
    })
    .filter((group) => group.models.length > 0)
}

export function insertToken(
  text: string,
  start: number,
  end: number,
  token: string
): { text: string; caret: number } {
  return { text: text.slice(0, start) + token + text.slice(end), caret: start + token.length }
}

export function describeUpdate(state: UpdateState | null): string {
  switch (state?.kind) {
    case undefined:
    case 'idle':
      return 'Not checked yet.'
    case 'unsupported':
      return 'Updates are off when running from source. Install a release to get them.'
    case 'checking':
      return 'Checking for updates…'
    case 'current':
      return `You're up to date. Last checked ${new Date(state.checkedAt).toLocaleTimeString([], {
        hour: 'numeric',
        minute: '2-digit'
      })}.`
    case 'downloading':
      return `Downloading ${state.version}… ${state.percent}%`
    case 'ready':
      return `Version ${state.version} is ready. It installs when you quit Styr, or restart now.`
    case 'error':
      return `Couldn't check for updates: ${state.message}`
  }
}
