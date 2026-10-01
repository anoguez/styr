/** Ensures repeated start requests for one task share a single in-progress launch. */
export class TaskLaunchGate {
  private readonly launches = new Map<string, Promise<unknown>>()

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
