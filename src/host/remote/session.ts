import { PROTOCOL_VERSION, RpcPeer } from '../rpc/jsonRpc.js'
import { HELLO_TIMEOUT_MS, exitReason, incompatibleMessage } from './connection.js'
import type { ServerHello, TransportChild } from './connection.js'

/**
 * A one-off session with a host's server: one `ssh … serve attach` child, the hello, one or more
 * requests, then the child ends. Setup uses it to create the workspace on a host the app is not
 * connected to yet; a connected host's shared connection is used instead (`router.requestOnHost`).
 */
export interface ServerSession {
  hello: ServerHello
  request(method: string, params?: unknown[]): Promise<unknown>
  close(): void
}

export interface SessionPorts {
  spawn(): TransportChild
  setTimer(run: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
}

/** Opens a session, resolving once the server says hello in this app's protocol. */
export function openServerSession(host: string, ports: SessionPorts): Promise<ServerSession> {
  return new Promise((resolve, reject) => {
    let stderr = ''
    let settled = false
    const child = ports.spawn()
    const close = (): void => {
      peer.close(`The session with ${host} closed.`)
      try {
        child.kill()
      } catch {
        // Already gone.
      }
    }
    const fail = (message: string): void => {
      if (settled) return
      settled = true
      ports.clearTimer(timer)
      close()
      reject(new Error(message))
    }
    const timer = ports.setTimer(
      () => fail(`${host} did not answer within ${HELLO_TIMEOUT_MS / 1000}s.`),
      HELLO_TIMEOUT_MS
    )
    const peer = new RpcPeer(
      (line) => {
        try {
          child.write(line)
        } catch {
          // The child is ending; its exit arrives next.
        }
      },
      {
        notification: (method, params) => {
          if (method !== 'server:hello' || settled) return
          const hello = params[0] as ServerHello
          if (hello?.protocol !== PROTOCOL_VERSION) {
            fail(incompatibleMessage(host, hello))
            return
          }
          settled = true
          ports.clearTimer(timer)
          resolve({ hello, request: (m, p = []) => peer.request(m, p), close })
        }
      }
    )
    child.onStdout((chunk) => peer.receive(chunk))
    child.onStderr((chunk) => {
      stderr = (stderr + String(chunk)).slice(-2_000)
    })
    child.onExit((code, error) => {
      peer.close(`The session with ${host} closed.`)
      fail(`Could not reach the Styr server on ${host}: ${exitReason(stderr, code, error)}`)
    })
  })
}
