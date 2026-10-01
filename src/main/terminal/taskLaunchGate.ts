/** Ensures repeated start requests for one task share a single in-progress launch. */
export class TaskLaunchGate {
  private readonly launches = new Map<string, Promise<unknown>>()

  /**
   * The one-live-session rule: a task with a session gets that session back, never a second agent.
   * The check runs inside the gate so two simultaneous requests cannot both see "none yet".
   */
  startOrReuse<T>(
    taskId: string,
    findLive: () => T | undefined,
    start: () => Promise<T>
  ): Promise<T> {
    return this.run(taskId, async () => findLive() ?? (await start()))
  }

  run<T>(taskId: string, launch: () => Promise<T>): Promise<T> {
    const active = this.launches.get(taskId)
    if (active) return active as Promise<T>

    const pending = Promise.resolve().then(launch)
    const guarded = pending.finally(() => {
      if (this.launches.get(taskId) === guarded) this.launches.delete(taskId)
    })
    this.launches.set(taskId, guarded)
    return guarded
  }
}
