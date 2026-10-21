import type { TerminalOutput } from '@core/types.js'

type Subscribe<Payload> = (handler: (payload: Payload) => void) => () => void
type Handler<Payload> = (payload: Payload) => void

/**
 * Routes a broadcast terminal event to the views of the one session it names. Each event crosses
 * the preload bridge once, however many terminals are open, instead of once for every mounted
 * view, each dropping the others' output. The bridge subscription is made on the first
 * registration and dropped with the last.
 */
export function sessionDispatcher<Payload extends { id: string }>(
  subscribe: Subscribe<Payload>
): (id: string, handler: Handler<Payload>) => () => void {
  const handlers = new Map<string, Set<Handler<Payload>>>()
  let unsubscribe: (() => void) | undefined

  const dispatch = (payload: Payload): void => {
    const forSession = handlers.get(payload.id)
    if (forSession) for (const handler of forSession) handler(payload)
  }

  return (id, handler) => {
    let forSession = handlers.get(id)
    if (!forSession) {
      forSession = new Set()
      handlers.set(id, forSession)
    }
    forSession.add(handler)
    unsubscribe ??= subscribe(dispatch)
    return () => {
      forSession.delete(handler)
      if (forSession.size === 0 && handlers.get(id) === forSession) handlers.delete(id)
      if (handlers.size === 0) {
        unsubscribe?.()
        unsubscribe = undefined
      }
    }
  }
}

/** One session's output, live. */
export const onSessionData = sessionDispatcher<{ id: string } & TerminalOutput>((handler) =>
  window.api.terminal.onData(handler)
)

/** One session's exit. */
export const onSessionExit = sessionDispatcher<{ id: string; exitCode: number }>((handler) =>
  window.api.terminal.onExit(handler)
)
