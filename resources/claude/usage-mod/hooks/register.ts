import type { Hook, Register } from 'claude-code'

type Engine = Parameters<Hook<'turn.complete'>>[0]
type PermissionRequest = Parameters<Hook<'classic.PermissionRequest'>>[1]
type Decision = NonNullable<Awaited<ReturnType<Hook<'classic.PermissionRequest'>>>>['decision']
type Suggestions = NonNullable<PermissionRequest['permission_suggestions']>

// Loaded only for agents Styr launches (CLAUDE_CODE_PLUGIN_DIRS). Styr names three files and the mod
// does nothing without them: STYR_USAGE_FILE, the account's rate-limit windows (shared by every
// session); STYR_CONTEXT_FILE, this terminal's own context-window fill; and STYR_CONVERSATION_FILE,
// this terminal's conversation in Styr's provider-neutral shape (src/core/agentConversation.ts),
// which Styr Terminal draws as blocks in place of the TUI. A fourth, STYR_PROMPT_INBOX, carries
// the person's side the other way: what they type in Styr's input, submitted as their own words,
// and their answers to the permission requests the conversation file shows.
async function record($: Engine): Promise<void> {
  try {
    const quotaFile = await $.env.get('STYR_USAGE_FILE')
    const contextFile = await $.env.get('STYR_CONTEXT_FILE')
    if (!quotaFile && !contextFile) return
    const { rateLimits, context } = await $.session.usage()
    const at = new Date().toISOString()
    if (quotaFile && rateLimits.length > 0) {
      await $.fs.write(quotaFile, JSON.stringify({ at, rateLimits }))
    }
    if (contextFile && context.percent !== undefined) {
      const { percent, tokens, window } = context
      await $.fs.write(contextFile, JSON.stringify({ at, context: { percent, tokens, window } }))
    }
  } catch {
    // Usage is a convenience; never disturb the session.
  }
}

/** Messages kept, and how much of any one text: the file is rewritten whole on each change. */
const MESSAGES = 300
const TEXT = 8000
const FIELD = 4000
const RESULT = 2000

const clip = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max)}…` : text

/** A tool's arguments, strings clipped: enough to name the call and draw an edit's diff. */
function clipInput(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'string') out[key] = clip(value, FIELD)
    else if (typeof value === 'number' || typeof value === 'boolean') out[key] = value
    else if (key === 'edits' && Array.isArray(value)) {
      out[key] = value
        .slice(0, 20)
        .map((edit) =>
          typeof edit === 'object' && edit !== null ? clipInput(edit as Record<string, unknown>) : {}
        )
    }
  }
  return out
}

/** The slash commands on offer, refreshed when the session starts and after each turn. */
let commands: { name: string; description: string }[] = []

async function listCommands($: Engine): Promise<void> {
  try {
    commands = (await $.command.list()).map(({ name, description }) => ({
      name,
      description: clip(description, 200)
    }))
  } catch {
    // Keep the last list.
  }
}

/** The inbox is being read, so Styr may send prompts through it rather than as keystrokes. */
let inboxReady = false

/** A prompt line from Styr's inbox: `{"text": "…"}`; anything else is ignored. */
function promptOf(line: string): string | undefined {
  try {
    const value: unknown = JSON.parse(line)
    if (typeof value !== 'object' || value === null) return undefined
    const text = (value as { text?: unknown }).text
    return typeof text === 'string' && text.trim() ? text : undefined
  } catch {
    return undefined
  }
}

/**
 * Reads the prompts Styr appends to its inbox for as long as the session lives, and submits each
 * as the person's own words. Typed into the TUI instead, a prompt of several lines arrives as a
 * paste, which Claude Code files as pasted content rather than as what the person wrote. `tail`
 * starts where the file ends now, so a prompt appended while it starts is still read.
 */
async function readInbox($: Engine): Promise<void> {
  try {
    const file = await $.env.get('STYR_PROMPT_INBOX')
    if (!file) return
    if (!(await $.fs.exists(file))) await $.fs.write(file, '')
    const { size } = await $.fs.stat(file)
    const tail = $.process.spawn({ argv: ['tail', '-c', `+${size + 1}`, '-F', file] })
    inboxReady = true
    await conversation($, false)
    let pending = ''
    for await (const piece of tail) {
      if (piece.stream !== 'stdout') continue
      pending += piece.text
      for (let end = pending.indexOf('\n'); end >= 0; end = pending.indexOf('\n')) {
        const text = promptOf(pending.slice(0, end))
        pending = pending.slice(end + 1)
        if (text) await $.prompt.submit({ text, asUser: true })
      }
    }
  } catch {
    // No inbox (no `tail` on this system, say): Styr goes on typing prompts into the TUI.
  } finally {
    if (inboxReady) {
      inboxReady = false
      await conversation($, false)
    }
  }
}

type Message = {
  role: string
  text: string
  toolUses: Record<string, unknown>[]
}

/** The messages as last read, so a streamed piece rewrites the file without reading them again. */
let messages: Message[] = []
let working = false

/** Writes the conversation so far for Styr, whether a turn is running, and the commands. */
async function conversation($: Engine, running: boolean): Promise<void> {
  try {
    const file = await $.env.get('STYR_CONVERSATION_FILE')
    if (!file) return
    working = running
    // The messages now hold whatever had streamed.
    streaming = ''
    messages = (await $.session.messages()).slice(-MESSAGES).map((message) => ({
      role: message.role,
      text: clip(message.text, TEXT),
      toolUses: message.toolUses.map((use) => ({
        id: use.tool_use_id,
        tool: use.tool,
        input: clipInput(use.input),
        ...(use.text !== undefined ? { text: clip(use.text, RESULT) } : {}),
        ...(use.isError ? { isError: true } : {})
      }))
    }))
    await write($, file)
  } catch {
    // The block view is a convenience; never disturb the session.
  }
}

/** The file from what is known now; `conversation` reads the messages first. */
async function write($: Engine, file: string): Promise<void> {
  const approval = approvals.values().next().value
  await $.fs.write(
    file,
    JSON.stringify({
      at: new Date().toISOString(),
      working,
      messages,
      commands,
      promptInbox: inboxReady,
      ...(working && streaming ? { streaming } : {}),
      ...(approval ? { approval: approval.shown } : {})
    })
  )
}

/** The reply's text so far in the step streaming now, clipped as a message's text is. */
let streaming = ''
/** At most one streamed write in flight, and this long between them: the file is rewritten whole. */
const STREAM_EVERY_MS = 150
let streamedAt = 0
let streamWrite: Promise<void> | undefined

/** Writes the streamed text when the last write is done and long enough ago; drops it otherwise. */
function streamed($: Engine, file: string): void {
  const now = Date.now()
  if (streamWrite || now - streamedAt < STREAM_EVERY_MS) return
  streamedAt = now
  streamWrite = write($, file)
    .catch(() => {})
    .finally(() => {
      streamWrite = undefined
    })
}

/** An approval Styr shows while Claude Code's own dialog asks too; whichever answers first wins. */
interface Pending {
  shown: {
    id: string
    prompt: string
    tool: string
    input: Record<string, unknown>
    options: { id: string; label: string; kind: 'allow' | 'allow-always' | 'deny' }[]
  }
  /** Ends the wait: the dialog was answered in the TUI, or the turn is over. */
  cancel: AbortController
}

const approvals = new Map<string, Pending>()
let approvalCount = 0

/** A suggested rule as Claude Code writes it: `Bash(npm test:*)`, `WebFetch`. */
const rule = (value: { toolName: string; ruleContent?: string }): string =>
  value.ruleContent ? `${value.toolName}(${value.ruleContent})` : value.toolName

/** What "don't ask again" would do, in the words of Claude Code's own option. */
function alwaysLabel(suggestions: Suggestions): string {
  const parts = suggestions.map((update) => {
    if (update.type === 'addRules' || update.type === 'replaceRules') {
      return `don't ask again for ${update.rules.map(rule).join(', ')}`
    }
    if (update.type === 'setMode' && update.mode === 'acceptEdits') {
      return 'allow all edits during this session'
    }
    if (update.type === 'addDirectories') {
      return `always allow access to ${update.directories.join(', ')}`
    }
    return undefined
  })
  const known = parts.filter((part): part is string => part !== undefined)
  return clip(`Yes, ${known.length > 0 ? known.join('; ') : "and don't ask again"}`, 200)
}

/** Claude Code's dialog: Yes; Yes and remember, when it suggests a rule; No. */
function approvalOptions(suggestions: Suggestions): Pending['shown']['options'] {
  return [
    { id: 'allow', label: 'Yes', kind: 'allow' },
    ...(suggestions.length > 0
      ? [{ id: 'always', label: alwaysLabel(suggestions), kind: 'allow-always' as const }]
      : []),
    { id: 'deny', label: 'No', kind: 'deny' }
  ]
}

/** The answer an option gives, as the dialog's would: No stops the turn for the person's word. */
function decisionFor(option: string, suggestions: Suggestions): Decision | undefined {
  if (option === 'allow') return { behavior: 'allow' }
  if (option === 'always' && suggestions.length > 0) {
    return { behavior: 'allow', updatedPermissions: suggestions }
  }
  if (option === 'deny') {
    return {
      behavior: 'deny',
      message: "The user doesn't want to proceed with this tool use.",
      interrupt: true
    }
  }
  return undefined
}

/** An answer line from Styr's inbox for approval `id`: `{"approval": id, "option": "…"}`. */
function answerOf(line: string, id: string): string | undefined {
  try {
    const value: unknown = JSON.parse(line)
    if (typeof value !== 'object' || value === null) return undefined
    const { approval, option } = value as { approval?: unknown; option?: unknown }
    return approval === id && typeof option === 'string' ? option : undefined
  } catch {
    return undefined
  }
}

/**
 * Waits for Styr's answer to approval `id` on its own `tail` of the inbox, started before the
 * approval is shown so no answer is missed; undefined once `signal` ends the wait. Leaving the
 * loop ends the `tail`.
 */
async function awaitAnswer(
  $: Engine,
  file: string,
  id: string,
  shown: () => Promise<void>,
  signal: AbortSignal
): Promise<string | undefined> {
  const { size } = await $.fs.stat(file)
  const tail = $.process.spawn({ argv: ['tail', '-c', `+${size + 1}`, '-F', file] })
  const stopped = new Promise<undefined>((resolve) => {
    if (signal.aborted) resolve(undefined)
    signal.addEventListener('abort', () => resolve(undefined), { once: true })
  })
  try {
    await shown()
    let pending = ''
    for (;;) {
      const piece = await Promise.race([tail.next(), stopped])
      if (!piece || piece.done) return undefined
      if (piece.value.stream !== 'stdout') continue
      pending += piece.value.text
      for (let end = pending.indexOf('\n'); end >= 0; end = pending.indexOf('\n')) {
        const option = answerOf(pending.slice(0, end), id)
        pending = pending.slice(end + 1)
        if (option) return option
      }
    }
  } finally {
    void tail.return(undefined as never).catch(() => {})
  }
}

/** Ends the waits for the approvals `match` picks: their dialog was answered in the TUI. */
function settleApprovals(match: (pending: Pending) => boolean): void {
  for (const pending of approvals.values()) if (match(pending)) pending.cancel.abort()
}

export const register: Register = on => {
  on('turn.complete', async ($, e, next) => {
    settleApprovals(() => true)
    const result = await next(e)
    await record($)
    await listCommands($)
    await conversation($, false)
    return result
  })

  // A resumed chat already has a context fill and a conversation; show both before the first turn.
  // The conversation is read once the session is up: inside session.start it is not loaded yet.
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await record($)
    $.clock.after(500, () => void listCommands($).then(() => conversation($, false)))
    // The session's life: the loop ends with the session or a reload, which starts it again.
    void readInbox($)
    return result
  })

  // The reply as it streams: each step's text pieces, coalesced into the conversation file. Main's
  // steps only; a subagent's text is not the conversation.
  on('turn.step', async function* ($, e, next) {
    const stream = next(e)
    const file = e.agentId === undefined ? await $.env.get('STYR_CONVERSATION_FILE') : undefined
    if (!file) return yield* stream
    // A step is a turn's: the turn runs, whatever was last written.
    working = true
    streaming = ''
    for await (const chunk of stream) {
      yield chunk
      if (chunk.kind === 'text' && streaming.length < TEXT) {
        streaming = clip(streaming + chunk.text, TEXT)
        streamed($, file)
      }
    }
    // The last pieces, held back by the coalescing, until the CLI records the message.
    if (streaming) void (streamWrite ?? Promise.resolve()).then(() => write($, file)).catch(() => {})
    return await stream.result
  })

  // A permission Claude Code asks for, shown in Styr with its real options while the TUI's dialog
  // is up. Styr's answer comes back through the inbox and decides it as the dialog would; answered
  // in the TUI first, the call settles and the wait ends. Without an inbox it is the dialog alone.
  on('classic.PermissionRequest', async ($, e, next) => {
    const inbox = inboxReady ? await $.env.get('STYR_PROMPT_INBOX') : undefined
    const file = await $.env.get('STYR_CONVERSATION_FILE')
    if (!inbox || !file) return next(e)
    const suggestions = e.permission_suggestions ?? []
    const id = `p${Date.now().toString(36)}${++approvalCount}`
    const input =
      typeof e.tool_input === 'object' && e.tool_input !== null
        ? clipInput(e.tool_input as Record<string, unknown>)
        : {}
    const pending: Pending = {
      shown: {
        id,
        prompt: `Claude wants to use ${e.tool_name}`,
        tool: e.tool_name,
        input,
        options: approvalOptions(suggestions)
      },
      cancel: new AbortController()
    }
    const cancel = (): void => pending.cancel.abort()
    next.signal.addEventListener('abort', cancel, { once: true })
    let option: string | undefined
    try {
      option = await awaitAnswer(
        $,
        inbox,
        id,
        async () => {
          approvals.set(id, pending)
          await write($, file)
        },
        pending.cancel.signal
      )
    } catch {
      // No `tail`, or the inbox is gone: the dialog alone answers.
    } finally {
      next.signal.removeEventListener('abort', cancel)
      if (approvals.delete(id)) await write($, file).catch(() => {})
    }
    const decision = option ? decisionFor(option, suggestions) : undefined
    return decision ? { decision } : next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const result = await next(e)
    await conversation($, true)
    return result
  })

  // Before a tool runs, so the call shows as running, and after, with its result.
  on('tool.call', async ($, e, next) => {
    await conversation($, true)
    const result = await next(e)
    // Its permission, if it asked one, was answered (here or in the TUI) or dropped.
    settleApprovals((pending) => pending.shown.tool === e.tool)
    await conversation($, true)
    return result
  })
}
