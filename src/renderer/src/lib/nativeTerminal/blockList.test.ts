import { describe, expect, it } from 'vitest'
import type {
  BlockListEvent,
  EngineFrame,
  EngineFrameLine,
  FinishedCommandBlock
} from '@core/types.js'
import {
  BlockListStore,
  HISTORY_CHUNK_ROWS,
  VIEW_FINISHED_BLOCKS,
  VIEW_FINISHED_ROWS,
  VIEW_HISTORY_ROWS,
  chunkText,
  commandHistory,
  liveRows,
  logicalLines,
  outputChunks,
  rowsText
} from './blockList.js'
import { ScreenModel } from './screen.js'
import { agentPrompt, inputAction, promptRoute, stepHistory, submission } from './commandInput.js'

const row = (index: number, text: string, wrapped = false): EngineFrameLine => ({
  row: index,
  wrapped,
  runs: text ? [{ text, width: text.length, fg: -1, bg: -1, flags: 0 }] : []
})

function frame(seq: number, lines: EngineFrameLine[], cursorRow = 0, rows = 4): EngineFrame {
  return {
    seq,
    full: true,
    cols: 10,
    rows,
    cursor: { row: cursorRow, col: 0, visible: true, shape: 'block' },
    altScreen: false,
    modes: {
      appCursor: false,
      appKeypad: false,
      bracketedPaste: true,
      focusEvents: false,
      mouse: 'none',
      sgrMouse: false
    },
    historySize: 0,
    displayOffset: 0,
    bell: false,
    lines
  }
}

const block = (id: string, command = 'ls'): FinishedCommandBlock => ({
  id,
  command,
  startedAt: 0,
  endedAt: 5,
  exitCode: 0,
  cols: 10,
  output: [row(0, 'out')],
  truncated: false
})

const send = (store: BlockListStore, attachId: number, events: BlockListEvent[]): boolean =>
  store.received({ id: 's', attachId, events })

describe('BlockListStore', () => {
  it('stays a grid until the session prompts', () => {
    const store = new BlockListStore()
    store.attached(1, undefined)
    expect(store.state).toBeNull()
    expect(send(store, 1, [{ kind: 'finished', block: block('c1') }])).toBe(false)
    expect(store.state).toBeNull()
    send(store, 1, [
      { kind: 'segment', segment: { kind: 'prompt', id: 'p1' }, frame: frame(1, []) }
    ])
    expect(store.state?.active).toEqual({ kind: 'prompt', id: 'p1' })
  })

  it('starts from the attach snapshot and applies events in order', () => {
    const store = new BlockListStore()
    store.attached(1, {
      finished: [block('c1')],
      active: { kind: 'running', id: 'c2', command: 'seq', startedAt: 1 },
      history: [row(0, '1')],
      frame: frame(1, [row(0, '2')], 0)
    })
    send(store, 1, [
      { kind: 'history', rows: [row(0, '2')] },
      { kind: 'frame', frame: frame(2, [row(0, '3')]) },
      { kind: 'finished', block: block('c2', 'seq') },
      { kind: 'segment', segment: { kind: 'prompt', id: 'p3' }, frame: frame(1, []) }
    ])
    const state = store.state!
    expect(state.finished.map((item) => item.id)).toEqual(['c1', 'c2'])
    expect(state.active.kind).toBe('prompt')
    // A new segment starts with no history of its own.
    expect(state.history).toEqual([])
  })

  it('holds events that overtake the attach reply and drops a replaced engine’s', () => {
    const store = new BlockListStore()
    send(store, 2, [
      { kind: 'segment', segment: { kind: 'prompt', id: 'p1' }, frame: frame(1, []) }
    ])
    send(store, 1, [{ kind: 'cleared' }])
    expect(store.state).toBeNull()
    store.attached(2, undefined)
    expect(store.state?.active).toEqual({ kind: 'prompt', id: 'p1' })
    expect(send(store, 1, [{ kind: 'finished', block: block('old') }])).toBe(false)
  })

  it('clears, and keeps a bounded list', () => {
    const store = new BlockListStore()
    store.attached(1, undefined)
    send(store, 1, [{ kind: 'segment', segment: { kind: 'prompt', id: 'p' }, frame: frame(1, []) }])
    for (let index = 0; index < VIEW_FINISHED_BLOCKS + 3; index++) {
      send(store, 1, [{ kind: 'finished', block: block(`c${index}`) }])
    }
    expect(store.state!.finished).toHaveLength(VIEW_FINISHED_BLOCKS)
    expect(store.state!.finished[0]!.id).toBe('c3')
    send(store, 1, [{ kind: 'cleared' }])
    expect(store.state!.finished).toEqual([])
  })
})

describe('finished blocks', () => {
  it('keeps the rows across finished blocks bounded, newest first', () => {
    const store = new BlockListStore()
    store.attached(1, undefined)
    send(store, 1, [
      { kind: 'segment', segment: { kind: 'prompt', id: 'p1' }, frame: frame(1, []) }
    ])
    const big = (id: string): FinishedCommandBlock => ({
      ...block(id, 'cat log'),
      output: Array.from({ length: VIEW_FINISHED_ROWS / 4 }, (_, index) => row(index, 'x'))
    })
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f'])
      send(store, 1, [{ kind: 'finished', block: big(id) }])
    expect(store.state!.finished.map((item) => item.id)).toEqual(['c', 'd', 'e', 'f'])
    // A block bigger than the cap on its own is still shown.
    const huge = {
      ...big('g'),
      output: [
        ...big('g').output,
        ...big('g').output,
        ...big('g').output,
        ...big('g').output,
        row(0, 'y')
      ]
    }
    send(store, 1, [{ kind: 'finished', block: huge }])
    expect(store.state!.finished.map((item) => item.id)).toEqual(['g'])
  })
})

describe('running history', () => {
  const running = (): BlockListStore => {
    const store = new BlockListStore()
    store.attached(1, {
      finished: [],
      active: { kind: 'running', id: 'c1', command: 'cat log', startedAt: 0 },
      history: [],
      frame: frame(1, [])
    })
    return store
  }
  const lines = (from: number, count: number, wrapped = false): EngineFrameLine[] =>
    Array.from({ length: count }, (_, index) => row(from + index, String(from + index), wrapped))
  const history = (store: BlockListStore, rows: EngineFrameLine[]): void => {
    send(store, 1, [{ kind: 'history', rows }])
  }
  const texts = (store: BlockListStore): string[] =>
    store.state!.history.flatMap((chunk) => chunk.rows.map((item) => item.runs[0]!.text))

  it('closes chunks as they fill and leaves closed ones untouched', () => {
    const store = running()
    history(store, lines(0, 100))
    history(store, lines(100, 200))
    const [closed, open] = store.state!.history
    expect(closed!.rows).toHaveLength(HISTORY_CHUNK_ROWS)
    expect(open!.rows).toHaveLength(300 - HISTORY_CHUNK_ROWS)
    history(store, lines(300, 10))
    // The closed chunk is the same object, so the view need not draw it again.
    expect(store.state!.history[0]).toBe(closed)
    expect(store.state!.history[1]!.id).toBe(open!.id)
    expect(texts(store)).toEqual(lines(0, 310).map((item) => item.runs[0]!.text))
  })

  it('never ends a chunk inside a wrapped line, unless the line goes on and on', () => {
    const store = running()
    history(store, [...lines(0, HISTORY_CHUNK_ROWS - 1), row(255, 'wr', true), row(256, 'ap')])
    expect(store.state!.history[0]!.rows).toHaveLength(HISTORY_CHUNK_ROWS + 1)
    const endless = running()
    history(endless, lines(0, HISTORY_CHUNK_ROWS * 5, true))
    expect(endless.state!.history[0]!.rows).toHaveLength(HISTORY_CHUNK_ROWS * 4)
  })

  it('drops the oldest chunks past the cap and keeps the newest rows', () => {
    const store = running()
    for (let from = 0; from < VIEW_HISTORY_ROWS + 2000; from += 500)
      history(store, lines(from, 500))
    const kept = texts(store)
    expect(kept.length).toBeGreaterThanOrEqual(VIEW_HISTORY_ROWS)
    expect(kept.length).toBeLessThan(VIEW_HISTORY_ROWS + HISTORY_CHUNK_ROWS)
    expect(kept.at(-1)).toBe(String(VIEW_HISTORY_ROWS + 1999))
  })
})

describe('block list rows', () => {
  it('rejoins wrapped rows, keeping a space that fell at the wrap', () => {
    const rows = [row(0, 'hello', true), row(1, 'world'), row(2, ''), row(3, 'end')]
    const lines = logicalLines(rows, 6)
    expect(lines.map((runs) => runs.map((run) => run.text).join(''))).toEqual([
      'hello world',
      '',
      'end'
    ])
    expect(rowsText(rows, 6)).toBe('hello world\n\nend')
  })

  it('cuts finished output into chunks at line ends, every row kept once', () => {
    const rows = Array.from({ length: HISTORY_CHUNK_ROWS * 2 + 10 }, (_, index) =>
      row(index, `line ${index}`, index === HISTORY_CHUNK_ROWS - 1)
    )
    const chunks = outputChunks(rows)
    expect(chunks.map((chunk) => chunk.length)).toEqual([
      HISTORY_CHUNK_ROWS + 1,
      HISTORY_CHUNK_ROWS,
      9
    ])
    expect(chunks.flat()).toEqual(rows)
    expect(chunks.every((chunk) => !chunk.at(-1)!.wrapped || chunk === chunks.at(-1))).toBe(true)
    expect(outputChunks([])).toEqual([])
  })

  it('writes a chunk as the text its styled lines show, line for line', () => {
    const rows = [row(0, 'hello', true), row(1, 'world'), row(2, ''), row(3, 'end  ')]
    // What selecting the styled lines copies: one line per logical line, wrap padding kept.
    const styled = logicalLines(rows, 6).map((runs) => runs.map((run) => run.text).join(''))
    expect(chunkText(rows, 6)).toBe(styled.join('\n'))
    expect(chunkText(rows, 6).split('\n')).toHaveLength(3)
    // A trailing line break draws no line, so a final empty line needs one more.
    expect(chunkText([row(0, 'a'), row(1, '')], 6)).toBe('a\n\n')
    expect(chunkText([row(0, '')], 6)).toBe('\n')
  })

  it('shows the live screen down to the cursor or the last row with text', () => {
    const screen = new ScreenModel()
    screen.reset(frame(1, [row(0, '$ '), row(1, ''), row(2, ''), row(3, '')], 0))
    expect(liveRows(screen)).toHaveLength(1)
    screen.reset(frame(2, [row(0, 'a'), row(1, ''), row(2, 'c'), row(3, '')], 1))
    expect(liveRows(screen)).toHaveLength(3)
    expect(liveRows(new ScreenModel())).toEqual([])
  })

  it('steps through commands without blanks or repeats, the running one last', () => {
    const store = new BlockListStore()
    store.attached(1, {
      finished: [block('a', 'ls'), block('b', 'ls'), block('c', ''), block('d', 'git status')],
      active: { kind: 'running', id: 'e', command: 'make', startedAt: 0 },
      history: [],
      frame: frame(1, [])
    })
    expect(commandHistory(store.state!)).toEqual(['ls', 'git status', 'make'])
  })
})

describe('command input', () => {
  const key = (
    name: string,
    mods: Partial<Record<'ctrl' | 'shift' | 'meta' | 'alt', boolean>> = {}
  ) => ({
    key: name,
    ctrlKey: mods.ctrl ?? false,
    shiftKey: mods.shift ?? false,
    metaKey: mods.meta ?? false,
    altKey: mods.alt ?? false
  })
  const at = (text: string, caret = text.length) => ({ text, start: caret, end: caret })

  it('submits on Enter and leaves Shift+Enter a newline', () => {
    expect(inputAction(key('Enter'), at('ls'))).toEqual({ kind: 'submit' })
    expect(inputAction(key('Enter', { shift: true }), at('ls'))).toEqual({ kind: 'default' })
    expect(inputAction({ ...key('Enter'), isComposing: true }, at('ls'))).toEqual({
      kind: 'default'
    })
  })

  it('maps Ctrl+C, Ctrl+L and Tab, and leaves Cmd+C to the browser', () => {
    expect(inputAction(key('c', { ctrl: true }), at('ls'))).toEqual({ kind: 'discard' })
    expect(inputAction(key('l', { ctrl: true }), at(''))).toEqual({ kind: 'clearBlocks' })
    expect(inputAction(key('Tab'), at('gi'))).toEqual({ kind: 'swallow' })
    expect(inputAction(key('c', { meta: true }), at('ls'))).toEqual({ kind: 'default' })
  })

  it('uses Up and Down for history only on the first and last line', () => {
    expect(inputAction(key('ArrowUp'), at('a\nb', 0))).toEqual({ kind: 'history', step: -1 })
    expect(inputAction(key('ArrowUp'), at('a\nb', 3))).toEqual({ kind: 'default' })
    expect(inputAction(key('ArrowDown'), at('a\nb', 3))).toEqual({ kind: 'history', step: 1 })
    expect(inputAction(key('ArrowDown'), at('a\nb', 0))).toEqual({ kind: 'default' })
    expect(inputAction(key('ArrowUp'), { text: 'ab', start: 0, end: 2 })).toEqual({
      kind: 'default'
    })
  })

  it('sends a line with Enter, and several lines as one bracketed paste', () => {
    expect(submission('ls -la', true)).toBe('ls -la\r')
    expect(submission('for x in 1 2\ndo echo $x\ndone', true)).toBe(
      '\x1b[200~for x in 1 2\rdo echo $x\rdone\x1b[201~\r'
    )
    expect(submission('a\nb', false)).toBe('a\rb\r')
  })

  it('hands an agent its prompt as a paste, with Enter kept apart', () => {
    // Written together, an agent's input box takes the Enter as part of the paste: a newline.
    expect(agentPrompt('fix the watcher')).toEqual({
      paste: '\x1b[200~fix the watcher\x1b[201~',
      enter: '\r'
    })
    expect(agentPrompt('one\ntwo').paste).toBe('\x1b[200~one\rtwo\x1b[201~')
    expect(agentPrompt('/compact').paste).not.toContain('\r')
  })

  it('routes prompts through the inbox, except what only the TUI handles', () => {
    expect(promptRoute('fix the watcher', true)).toBe('inbox')
    expect(promptRoute('just\ntesting', true)).toBe('inbox')
    expect(promptRoute('fix the watcher', false)).toBe('keys')
    expect(promptRoute('/model', true)).toBe('keys')
    expect(promptRoute('/compact keep tests', true)).toBe('keys')
    expect(promptRoute('look at @src/app.ts', true)).toBe('keys')
    expect(promptRoute('mail me at a@b.com', true)).toBe('inbox')
    expect(promptRoute('look at\n@src/app.ts', true)).toBe('inbox')
  })

  it('steps through history and returns to the draft', () => {
    const history = ['ls', 'pwd']
    let cursor = { index: null as number | null, draft: '' }
    expect(stepHistory(history, cursor, 'gi', 1)).toBeNull()
    const up = stepHistory(history, cursor, 'gi', -1)!
    expect(up.text).toBe('pwd')
    cursor = up.cursor
    const older = stepHistory(history, cursor, up.text, -1)!
    expect(older.text).toBe('ls')
    expect(stepHistory(history, older.cursor, 'ls', -1)).toBeNull()
    const back = stepHistory(history, older.cursor, 'ls', 1)!
    const draft = stepHistory(history, back.cursor, back.text, 1)!
    expect(draft).toEqual({ cursor: { index: null, draft: '' }, text: 'gi' })
    expect(stepHistory([], cursor, '', -1)).toBeNull()
  })
})
