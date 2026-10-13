import type { ReactNode } from 'react'

/** A 16×16 stroke icon drawn in the current text colour. */
export function Icon({ children, size = 13 }: { children: ReactNode; size?: number }): ReactNode {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0"
    >
      {children}
    </svg>
  )
}

type IconProps = { size?: number }

export const CloseIcon = (props: IconProps): ReactNode => (
  <Icon {...props}>
    <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
  </Icon>
)

export const PlusIcon = (props: IconProps): ReactNode => (
  <Icon {...props}>
    <path d="M8 3.5v9M3.5 8h9" />
  </Icon>
)

export const FolderIcon = (props: IconProps): ReactNode => (
  <Icon {...props}>
    <path d="M2.5 4.5a1 1 0 0 1 1-1h3l1.5 1.5h4.5a1 1 0 0 1 1 1v5.5a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z" />
  </Icon>
)

export const FileIcon = (props: IconProps): ReactNode => (
  <Icon {...props}>
    <path d="M4 2.5h5l3 3v8H4z" />
    <path d="M9 2.5v3h3" />
  </Icon>
)

export const BranchIcon = (props: IconProps): ReactNode => (
  <Icon {...props}>
    <circle cx="4.5" cy="3.5" r="1.8" />
    <circle cx="4.5" cy="12.5" r="1.8" />
    <circle cx="11.5" cy="3.5" r="1.8" />
    <path d="M4.5 5.3v5.4M11.5 5.3c0 3-2.8 3.4-5.2 4" />
  </Icon>
)

export const ExternalIcon = (props: IconProps): ReactNode => (
  <Icon {...props}>
    <path d="M9 3h4v4M13 3 7.5 8.5" />
    <path d="M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3" />
  </Icon>
)

export const DiffIcon = (props: IconProps): ReactNode => (
  <Icon {...props}>
    <path d="M4 2.5h5l3 3v8H4z" />
    <path d="M6.25 7h3.5M8 5.25v3.5M6.25 11h3.5" />
  </Icon>
)

export const TrashIcon = (props: IconProps): ReactNode => (
  <Icon {...props}>
    <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" />
  </Icon>
)

export const ChevronIcon = (props: IconProps): ReactNode => (
  <Icon {...props}>
    <path d="M4 6l4 4 4-4" />
  </Icon>
)

export const ArchiveIcon = (props: IconProps): ReactNode => (
  <Icon {...props}>
    <path d="M2.5 3.5h11v3h-11zM3.5 6.5v6h9v-6M6.5 9h3" />
  </Icon>
)

export const RefreshIcon = (props: IconProps): ReactNode => (
  <Icon {...props}>
    <path d="M12.5 6.5A4.75 4.75 0 0 0 3.6 5.2M3.5 9.5a4.75 4.75 0 0 0 8.9 1.3" />
    <path d="M3.5 2.5v3h3M12.5 13.5v-3h-3" />
  </Icon>
)

export const UnlinkIcon = (props: IconProps): ReactNode => (
  <Icon {...props}>
    <path d="M6.5 4.5l1-1a2.5 2.5 0 0 1 3.5 3.5l-1 1M9.5 11.5l-1 1A2.5 2.5 0 0 1 5 9l1-1M3 3l10 10" />
  </Icon>
)

/** Three dots, for a "More actions" menu button. Filled, so it reads at small sizes. */
export const MoreIcon = ({ size = 13 }: IconProps): ReactNode => (
  <svg
    aria-hidden
    viewBox="0 0 16 16"
    width={size}
    height={size}
    fill="currentColor"
    className="shrink-0"
  >
    <circle cx="3.5" cy="8" r="1.3" />
    <circle cx="8" cy="8" r="1.3" />
    <circle cx="12.5" cy="8" r="1.3" />
  </svg>
)
