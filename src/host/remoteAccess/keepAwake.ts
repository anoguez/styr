export interface KeepAwakePorts {
  /** Starts holding the computer awake; returns what to pass to `release`. */
  hold(): number
  release(id: number): void
}

/**
 * Holds the computer awake while a device is connected, if the user asked for it, and lets go when
 * the last one leaves or the setting is switched off.
 */
export function createKeepAwake(ports: KeepAwakePorts) {
  let wanted = false
  let count = 0
  let held: number | undefined

  function update(): void {
    const should = wanted && count > 0
    if (should && held === undefined) held = ports.hold()
    else if (!should && held !== undefined) {
      ports.release(held)
      held = undefined
    }
  }

  return {
    enabled(value: boolean): void {
      wanted = value
      update()
    },
    connections(value: number): void {
      count = value
      update()
    },
    holding: (): boolean => held !== undefined
  }
}
