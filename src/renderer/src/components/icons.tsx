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
