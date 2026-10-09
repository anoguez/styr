import { selectTerminalEngine, type EngineSelection } from '@core/terminalEngine.js'
import type { TerminalEngineAvailability, TerminalEngineEnvironment } from '@core/types.js'

/**
 * The renderer's view of the engine environment, asked for once per run. Availability (is the
 * package bundled here?) does not load anything, so it is fetched at startup; the environment loads
 * the native package and is only fetched once something asks for the native engine.
 */
export interface EngineChoicePorts {
  availability: () => Promise<TerminalEngineAvailability>
  environment: () => Promise<TerminalEngineEnvironment>
}

export class EngineChoice {
  private availabilityPromise: Promise<TerminalEngineAvailability | null> | undefined
  private environmentPromise: Promise<TerminalEngineEnvironment | null> | undefined
  /** Set once availability has arrived, so the common case decides without waiting. */
  availabilityNow: TerminalEngineAvailability | null = null

  constructor(private readonly ports: EngineChoicePorts) {}

  availability(): Promise<TerminalEngineAvailability | null> {
    this.availabilityPromise ??= this.ports.availability().then(
      (value) => (this.availabilityNow = value),
      () => null
    )
    return this.availabilityPromise
  }

  /**
   * Whether a new terminal should even consider the native engine. Synchronous, so the standard
   * path — setting off, no override — mounts xterm.js exactly as before, without waiting on IPC.
   */
  wantsNative(settingEnabled: boolean): boolean {
    return this.availabilityNow?.override ?? settingEnabled
  }

  /** Loads the native package if need be and picks the engine. Never rejects. */
  async select(settingEnabled: boolean): Promise<EngineSelection> {
    this.environmentPromise ??= this.ports.environment().catch(() => null)
    const environment = await this.environmentPromise
    return selectTerminalEngine({
      settingEnabled,
      override: environment?.override,
      status: environment?.status ?? null
    })
  }
}

let shared: EngineChoice | undefined

/** The app's one `EngineChoice`, bound to `window.api`. */
export function engineChoice(): EngineChoice {
  shared ??= new EngineChoice({
    availability: () => window.api.terminal.engineAvailability(),
    environment: () => window.api.terminal.engineEnvironment()
  })
  return shared
}
