import { serverStopQuestion } from './remoteStatus.js'

/**
 * Upgrade server and Stop server, from Settings → Remote hosts and the connection badge. Both end
 * the server's agents, so each lists them and proceeds only on confirm (warn, don't refuse).
 * Returns false when the user said no.
 */
export async function upgradeServer(host: string): Promise<boolean> {
  const running = await window.api.remote.runningAgents(host)
  if (!window.confirm(serverStopQuestion(host, 'restart', running))) return false
  await window.api.remote.upgrade(host)
  return true
}

export async function stopServer(host: string): Promise<boolean> {
  const running = await window.api.remote.runningAgents(host)
  if (!window.confirm(serverStopQuestion(host, 'stop', running))) return false
  await window.api.remote.stopServer(host)
  return true
}
