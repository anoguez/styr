import type { ReactNode } from 'react'
import type { AppInfo, UpdateState } from '@core/types.js'
import { IS_MAC } from '../../lib/platform.js'
import { Chip } from '../ui.js'

/**
 * The title bar's layout: `start` beside the window controls, `center` in the middle, `end` at the
 * far edge. Styr is laid out for macOS, where the window controls sit on the left beside the brand.
 * Windows and Linux draw them on the right, so the bar is mirrored there: the brand moves next to the
 * controls and New task to the far edge. Positions mirror; the insides of a control (the logo and
 * wordmark, Board | Inbox, text) never do.
 */
export function AppHeader({
  start,
  center,
  end,
  live
}: {
  start: ReactNode
  center: ReactNode
  end: ReactNode
  /** A Dispatch run or Auto-run is going: a sweep runs along the bar's bottom edge. */
  live: boolean
}): ReactNode {
  return (
    <header
      className={`relative flex h-[44px] shrink-0 items-center gap-3 border-b border-edge bg-chrome [-webkit-app-region:drag] ${IS_MAC ? 'pl-[86px] pr-3' : 'flex-row-reverse pl-3 pr-[150px]'}`}
    >
      {/* On macOS these wrappers are `contents`: no box, so the bar lays out exactly as before. */}
      <div className={IS_MAC ? 'contents' : 'flex min-w-0 flex-row-reverse items-center gap-3'}>
        {start}
      </div>
      <div className="flex flex-1 justify-center">{center}</div>
      <div
        className={`flex shrink-0 items-center gap-2 [-webkit-app-region:no-drag] ${IS_MAC ? '' : 'flex-row-reverse'}`}
      >
        {end}
      </div>
      {live ? (
        <span
          aria-hidden
          className="dispatch-sweep pointer-events-none absolute inset-x-0 -bottom-px h-0.5"
        />
      ) : null}
    </header>
  )
}

/** The app's rune and wordmark, then its version (a link to Updates) and a DEV chip from source. */
export function BrandMark({
  appInfo,
  update,
  onOpenUpdates
}: {
  appInfo: AppInfo | null
  update: UpdateState | null
  onOpenUpdates: () => void
}): ReactNode {
  const newVersion =
    update?.kind === 'ready' || update?.kind === 'downloading' ? update.version : undefined
  return (
    <>
      <span className={IS_MAC ? 'contents' : 'flex shrink-0 items-center gap-3'}>
        <span
          aria-hidden
          className="grid size-[22px] shrink-0 place-items-center rounded-[6px] bg-accent/15"
        >
          {/* The app icon's rune. Its gradient runs between theme colours rather than the icon's
              fixed ones, which match them at the default theme, so it follows a re-theme. */}
          <svg viewBox="0 0 16 16" className="size-[15px]">
            <defs>
              <linearGradient id="styr-mark" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" style={{ stopColor: 'var(--color-accent-text)' }} />
                <stop offset="1" style={{ stopColor: 'var(--color-col-progress)' }} />
              </linearGradient>
            </defs>
            <polyline
              points="5.6,2.6 5.6,8.4 10.4,7 10.4,13.4"
              transform="rotate(30 8 8)"
              fill="none"
              stroke="url(#styr-mark)"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
        <span className="font-wordmark -ml-1 text-[13.5px] font-semibold tracking-[0.02em] text-ink">
          Styr
        </span>
      </span>
      {appInfo ? (
        <button
          type="button"
          className={`text-[11px] [-webkit-app-region:no-drag] ${
            newVersion ? 'font-medium text-accent hover:underline' : 'text-faint hover:text-dim'
          }`}
          title={
            newVersion
              ? `Styr ${newVersion} is ${update?.kind === 'ready' ? 'ready to install' : 'downloading'} — open Settings`
              : 'Updates'
          }
          onClick={onOpenUpdates}
        >
          v{appInfo.version}
        </button>
      ) : null}
      {appInfo && !appInfo.isPackaged ? (
        <Chip tone="warn" title={`Running from source · v${appInfo.version}`}>
          DEV
        </Chip>
      ) : null}
    </>
  )
}
