/** One `### Features`-style group of a release. */
export interface ChangelogGroup {
  title: string
  items: string[]
}

/** One `## [x.y.z](compare-url) (date)` section of release-please's CHANGELOG.md. */
export interface ChangelogSection {
  version: string
  date: string
  groups: ChangelogGroup[]
}

const SECTION =
  /^##\s+\[?v?(\d+\.\d+\.\d+[^\]\s)]*)\]?(?:\([^)]*\))?\s*(?:\((\d{4}-\d{2}-\d{2})\))?/
const GROUP = /^###\s+(.+?)\s*$/
const BULLET = /^[*-]\s+(.*)$/

/** Parses release-please's changelog. Anything it does not recognise is skipped, never thrown. */
export function parseChangelog(text: string): ChangelogSection[] {
  const sections: ChangelogSection[] = []
  let section: ChangelogSection | undefined
  let group: ChangelogGroup | undefined
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd()
    const head = SECTION.exec(line)
    if (head?.[1]) {
      section = { version: head[1], date: head[2] ?? '', groups: [] }
      group = undefined
      sections.push(section)
      continue
    }
    if (!section) continue
    const title = GROUP.exec(line)?.[1]
    if (title) {
      group = { title, items: [] }
      section.groups.push(group)
      continue
    }
    const item = BULLET.exec(line)?.[1]
    if (item && group) group.items.push(item)
    // A wrapped bullet continues the previous one.
    else if (group && group.items.length > 0 && /^\s+\S/.test(raw))
      group.items[group.items.length - 1] += ` ${line.trim()}`
  }
  return sections
}

/** Numeric `[major, minor, patch]`; a pre-release suffix is ignored. */
function parts(version: string): number[] {
  return version
    .replace(/^v/, '')
    .split(/[-+]/)[0]!
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0)
}

/** Negative when `a` is older than `b`, zero when equal. */
export function compareVersions(a: string, b: string): number {
  const left = parts(a)
  const right = parts(b)
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/** The sections newer than `seen` up to and including `current`, newest first. */
export function sectionsBetween(
  sections: readonly ChangelogSection[],
  seen: string,
  current: string
): ChangelogSection[] {
  return sections
    .filter(
      (section) =>
        compareVersions(section.version, seen) > 0 && compareVersions(section.version, current) <= 0
    )
    .sort((a, b) => compareVersions(b.version, a.version))
}

/** How many sections the post-update dialog shows before pointing at the releases page. */
export const WHATS_NEW_CAP = 5

/** What the post-update dialog opens with, and what to remember afterwards. */
export interface WhatsNewDecision {
  /** The version to store as seen, always the current one. */
  store: string
  show: ChangelogSection[] | null
  /** More sections than the cap: the dialog links to all releases. */
  truncated: boolean
}

/** Behaviour 2 of TASK-0178: show once per new version, never on a fresh install or a dev build. */
export function whatsNewToShow(
  seen: string | null,
  current: string,
  packaged: boolean,
  sections: readonly ChangelogSection[]
): WhatsNewDecision {
  const nothing = { store: current, show: null, truncated: false }
  if (!packaged || seen === null || compareVersions(seen, current) >= 0) return nothing
  const between = sectionsBetween(sections, seen, current)
  if (between.length === 0) return nothing
  return {
    store: current,
    show: between.slice(0, WHATS_NEW_CAP),
    truncated: between.length > WHATS_NEW_CAP
  }
}
