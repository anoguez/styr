/** Pure presentation model of a unified patch: rows the renderer can draw, no DOM, no node. */

export interface Segment {
  text: string
  /** Part of the line that actually changed, highlighted over the line tint. */
  em: boolean
}

export type DiffRow =
  | { kind: 'hunk'; text: string }
  | { kind: 'fold'; count: number }
  | { kind: 'ctx' | 'add' | 'del'; oldLine?: number; newLine?: number; segments: Segment[] }

interface PatchLine {
  kind: 'ctx' | 'add' | 'del'
  text: string
}

interface Hunk {
  oldStart: number
  oldLength: number
  newStart: number
  newLength: number
  context: string
  lines: PatchLine[]
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/

export function parseHunks(patch: string): Hunk[] {
  const hunks: Hunk[] = []
  let current: Hunk | undefined
  for (const line of patch.split('\n')) {
    const header = HUNK_HEADER.exec(line)
    if (header) {
      current = {
        oldStart: Number(header[1]),
        oldLength: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newLength: header[4] === undefined ? 1 : Number(header[4]),
        context: header[5] ?? '',
        lines: []
      }
      hunks.push(current)
      continue
    }
    if (!current || line.startsWith('\\')) continue
    const marker = line[0]
    if (marker === '+') current.lines.push({ kind: 'add', text: line.slice(1) })
    else if (marker === '-') current.lines.push({ kind: 'del', text: line.slice(1) })
    else if (marker === ' ') current.lines.push({ kind: 'ctx', text: line.slice(1) })
  }
  // The trailing newline of a patch yields one empty context line that is not part of the file.
  const last = hunks[hunks.length - 1]
  if (last) {
    const counted = last.lines.filter((l) => l.kind !== 'add').length
    if (counted > last.oldLength) last.lines.pop()
  }
  return hunks
}

/** Common prefix and suffix are unchanged; what is left in the middle is the edit. */
export function emphasise(oldText: string, newText: string): [Segment[], Segment[]] {
  let start = 0
  const max = Math.min(oldText.length, newText.length)
  while (start < max && oldText[start] === newText[start]) start++
  let oldEnd = oldText.length
  let newEnd = newText.length
  while (oldEnd > start && newEnd > start && oldText[oldEnd - 1] === newText[newEnd - 1]) {
    oldEnd--
    newEnd--
  }
  const split = (text: string, end: number): Segment[] =>
    [
      { text: text.slice(0, start), em: false },
      { text: text.slice(start, end), em: true },
      { text: text.slice(end), em: false }
    ].filter((segment) => segment.text.length > 0)
  // Nearly everything changed: highlighting the whole line adds nothing over the tint.
  if (start === 0 && oldEnd === oldText.length && newEnd === newText.length) {
    return [[{ text: oldText, em: false }], [{ text: newText, em: false }]]
  }
  return [split(oldText, oldEnd), split(newText, newEnd)]
}

const plain = (text: string): Segment[] => [{ text, em: false }]

export function buildRows(patch: string): DiffRow[] {
  const rows: DiffRow[] = []
  const hunks = parseHunks(patch)
  hunks.forEach((hunk, index) => {
    const previous = hunks[index - 1]
    if (previous) {
      const gap = hunk.oldStart - (previous.oldStart + previous.oldLength)
      if (gap > 0) rows.push({ kind: 'fold', count: gap })
    }
    rows.push({
      kind: 'hunk',
      text: `@@ -${hunk.oldStart},${hunk.oldLength} +${hunk.newStart},${hunk.newLength} @@ ${hunk.context}`.trimEnd()
    })
    let oldLine = hunk.oldStart
    let newLine = hunk.newStart
    const lines = hunk.lines
    for (let i = 0; i < lines.length;) {
      const line = lines[i]!
      if (line.kind === 'ctx') {
        rows.push({
          kind: 'ctx',
          oldLine: oldLine++,
          newLine: newLine++,
          segments: plain(line.text)
        })
        i++
        continue
      }
      // A run of deletions then additions: pair them up for word-level emphasis.
      let j = i
      while (lines[j]?.kind === 'del') j++
      const dels = lines.slice(i, j)
      let k = j
      while (lines[k]?.kind === 'add') k++
      const adds = lines.slice(j, k)
      const paired = dels.length === adds.length
      dels.forEach((del, n) => {
        const segments = paired ? emphasise(del.text, adds[n]!.text)[0] : plain(del.text)
        rows.push({ kind: 'del', oldLine: oldLine++, segments })
      })
      adds.forEach((add, n) => {
        const segments = paired ? emphasise(dels[n]!.text, add.text)[1] : plain(add.text)
        rows.push({ kind: 'add', newLine: newLine++, segments })
      })
      i = k
    }
  })
  return rows
}
