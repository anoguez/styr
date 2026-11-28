import { useId, type ReactNode } from 'react'

/**
 * The app icon's rune. Its gradient runs between theme colours rather than the icon's fixed ones,
 * which match them at the default theme, so it follows a re-theme.
 */
export function StyrMark({ className }: { className?: string }): ReactNode {
  // Its own gradient id, so two marks on a page (the header and the chat) never share one.
  const gradient = useId()
  return (
    <svg aria-hidden viewBox="0 0 16 16" className={className}>
      <defs>
        <linearGradient id={gradient} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" style={{ stopColor: 'var(--color-accent-text)' }} />
          <stop offset="1" style={{ stopColor: 'var(--color-col-progress)' }} />
        </linearGradient>
      </defs>
      <polyline
        points="5.6,2.6 5.6,8.4 10.4,7 10.4,13.4"
        transform="rotate(30 8 8)"
        fill="none"
        stroke={`url(#${gradient})`}
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** The mark on its tile, as the agent's avatar in the chat. */
export function StyrAvatar(): ReactNode {
  return (
    <span
      aria-hidden
      className="border-accent/25 bg-accent/15 grid size-7 shrink-0 place-items-center rounded-[8px] border"
    >
      <StyrMark className="size-[18px]" />
    </span>
  )
}
