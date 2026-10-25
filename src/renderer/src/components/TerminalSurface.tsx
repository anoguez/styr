import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { runningSubagents, type AgentStatus } from '@core/agentState.js'
import { isAgentProgram } from '@core/handoff.js'
import { syntaxFor } from '@core/shell.js'
import { formatAccelerator, shortcutHint } from '@core/shortcuts.js'
import {
  type ShortcutBindings,
  type TaskStatus,
  type TerminalRuntimeState,
  type TerminalSessionInfo,
  type ThemeSettings
} from '@core/types.js'
import { onTerminalCommand, type TerminalCommand } from '../lib/terminalCommands.js'
import {
  firstLine,
  repoForDirectory,
  taskFromTerminal,
  type TerminalContext,
  type TerminalTaskKind
} from '../lib/terminalContext.js'
import { AskPrompt } from './AskPrompt.js'
import { ACTIVITY_RESERVE } from './TerminalActivity.js'
import { ContextBar, agentButton, iconProps, quietButton } from './TerminalContextBar.js'
import { ActionsMenu, type MenuItem } from './TerminalMenu.js'
import { TerminalBlocks, type ActionBlock, type BlockActions } from './TerminalBlocks.js'
import type { BlockLayout } from '../lib/blockTracker.js'
import { type TerminalHandle, type TerminalSelection } from './TerminalView.js'
import { TerminalEngineView } from './TerminalEngineView.js'
import { UsageButton } from './UsageButton.js'
import { DiffStatButton } from './ui.js'
import type { DiffStat } from '@core/diff.js'
import { useClaudeUsage } from '../hooks/useClaudeUsage.js'
import { useContextUsage } from '../hooks/useContextUsage.js'
import { useCodexUsage } from '../hooks/useCodexUsage.js'
import { FILE_MANAGER } from '../lib/platform.js'

const INTERRUPT = '\x03'
const CLEAR = '\x0c'

export interface TerminalTaskRequest {
  title: string
  description: string
  tags?: string[]
  /** Specified well enough to run as it is, so it skips the spec lane. */
  ready?: boolean
  /** Start an agent on the task straight away (Ask agent). */
  launch?: boolean
  /** The repository the task works in, when the terminal is inside one. */
  repoPath?: string
}

function CopyIcon(): ReactNode {
  return (
    <svg aria-hidden viewBox="0 0 16 16" width="12" height="12" {...iconProps}>
      <rect x="5.5" y="5.5" width="7.5" height="7.5" rx="1.5" />
      <path d="M10.5 3.5V3a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v5.5a1 1 0 0 0 1 1h.5" />
    </svg>
  )
}

function SelectionToolbar({
  selection,
  askHint,
  onCopy,
  onExplain,
  onAsk
}: {
  selection: TerminalSelection
  askHint: string
  onCopy: () => void
  onExplain: () => void
  onAsk: () => void
}): ReactNode {
  return (
    <div
      role="toolbar"
      aria-label="Selection actions"
      className="pointer-events-auto absolute z-20 flex items-center gap-0.5 whitespace-nowrap rounded-lg border border-edge-strong bg-panel p-[3px] shadow-2xl"
      style={{ left: Math.max(4, selection.x - 40), top: Math.max(4, selection.y - 40) }}
      onMouseDown={(event) => event.preventDefault()}
    >
      <button
        type="button"
        className={`${quietButton} h-[22px] px-[7px] text-[11.5px]`}
        onClick={onCopy}
      >
        <CopyIcon />
        Copy
      </button>
      <button
        type="button"
        className={`${quietButton} h-[22px] px-[7px] text-[11.5px]`}
        onClick={onExplain}
      >
        Explain
      </button>
      <span aria-hidden className="mx-0.5 h-3.5 w-px bg-edge-strong" />
      <button
        type="button"
        className={`${agentButton} h-[22px] border-transparent px-[7px] text-[11.5px]`}
        onClick={onAsk}
      >
        ✦ Ask agent
      </button>
      {askHint ? (
        <span className="pl-0.5 pr-1.5 font-mono text-[10px] text-faint">{askHint}</span>
      ) : null}
    </div>
  )
}

/** Shown after a command fails: the design's inline agent actions, without turning output into UI. */
function FailureActions({
  runtime,
  onFix,
  onExplain,
  onCreate
}: {
  runtime: TerminalRuntimeState
  onFix: () => void
  onExplain: () => void
  onCreate: () => void
}): ReactNode {
  const last = runtime.lastCommand
  const note = last?.output ? firstLine(last.output) : ''
  return (
    <div className="pointer-events-none flex shrink-0 flex-wrap items-center gap-1 border-t border-edge px-1.5 py-1">
      <button
        type="button"
        className={`${agentButton} h-[22px] px-2 text-[11.5px]`}
        onClick={onFix}
      >
        ✦ Fix with agent
      </button>
      <button
        type="button"
        className={`${quietButton} h-[22px] border-edge-strong px-2 text-[11.5px]`}
        onClick={onExplain}
      >
        Explain
      </button>
      <button
        type="button"
        className={`${quietButton} hidden h-[22px] px-2 text-[11.5px] @md:inline-flex`}
        onClick={onCreate}
      >
        Create task
      </button>
      <span className="ml-1.5 hidden min-w-0 truncate text-[11px] text-faint @md:block">
        {last ? `exit ${runtime.lastExitCode} · ${last.command}` : ''}
        {note ? ` — ${note}` : ''}
      </span>
    </div>
  )
}

/**
 * The native React boundary around xterm. It owns semantic state presentation while TerminalView
 * remains exclusively responsible for terminal emulation and lifecycle.
 */
export function TerminalSurface({
  session,
  active,
  theme,
  bindings,
  nativeTerminal = false,
  runtime,
  agentStatus,
  shownState,
  taskStatus,
  taskPrsDone,
  diffStat,
  onShowChanges,
  onAskReview,
  onAskFork,
  onFullscreenChange,
  onSplit,
  onCreateTask,
  onLaunchTask,
  onOpenTaskById,
  activity,
  children
}: {
  session: TerminalSessionInfo
  active: boolean
  theme: ThemeSettings
  bindings: ShortcutBindings
  /** `experimental.nativeTerminal`: try Styr Terminal for this view (xterm.js otherwise). */
  nativeTerminal?: boolean
  /** The main process's semantic state for this session, once it has reported any. */
  runtime?: TerminalRuntimeState
  /** The hook-reported state of this task's agent, when it is a task session. */
  agentStatus?: AgentStatus
  /** `agentStatus`'s state as the views label it (`shownAgentState`). */
  shownState?: AgentStatus['state']
  /** The board status of this session's task, when it has one. */
  taskStatus?: TaskStatus
  /** The task's pull request, once there is one. */
  /** Every repository of the task already has its pull request. */
  taskPrsDone?: boolean
  /** The task branch's change totals; absent when it has none. */
  diffStat?: DiffStat
  /** Open the Changes dialog for this session's task. */
  onShowChanges?: () => void
  /** Start a fresh reviewer on the task (what Orchestrate does for the review lane). */
  onAskReview?: (taskId: string) => Promise<void>
  /** Ask a question in a copy of this task session's chat; false when there is no saved chat to copy. */
  onAskFork?: (sessionId: string, question: string) => Promise<boolean>
  /** A full-screen program took over (or gave back) the panel. */
  onFullscreenChange?: (sessionId: string, fullscreen: boolean) => void
  /** Open another shell tab starting in this directory. */
  onSplit?: (cwd: string) => void
  /** Hand terminal output to an agent as a new task; resolves to the task id. */
  onCreateTask?: (request: TerminalTaskRequest) => Promise<string>
  /** Start an agent on a task this terminal just created. */
  onLaunchTask?: (taskId: string) => Promise<void>
  /** Show a task this terminal just created on the board. */
  onOpenTaskById?: (taskId: string) => void
  /**
   * The task's floating activity panel, when it is showing. The terminal narrows to leave it room,
   * so nothing it prints sits underneath.
   */
  activity?: ReactNode
  /** Controls for the context bar, beside Ask agent. */
  children?: ReactNode
}): ReactNode {
  const handle = useRef<TerminalHandle | null>(null)
  const [altScreen, setAltScreen] = useState(false)
  const [selection, setSelection] = useState<TerminalSelection | null>(null)
  const [picking, setPicking] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [git, setGit] = useState<{ root: string | null; branch: string | null }>({
    root: null,
    branch: null
  })
  const [notice, setNotice] = useState<string>()
  // A task this terminal just made, offered with Launch and Open until the notice is dismissed.
  const [created, setCreated] = useState<string>()
  const [layout, setLayout] = useState<BlockLayout | null>(null)
  // The native engine is showing its own block list, which draws commands itself.
  const [blockList, setBlockList] = useState(false)
  const [hoverLine, setHoverLine] = useState<number | null>(null)
  const [stickyBlock, setStickyBlock] = useState<string | null>(null)
  const [blockMenu, setBlockMenu] = useState<string | null>(null)

  const cwd = runtime?.cwd || session.cwd
  const running = runtime?.runningCommand
  const canChange = Boolean(runtime?.promptReady && !running)
  const lastCommandId = runtime?.lastCommand?.id

  useEffect(() => {
    let current = true
    void window.api.terminal.gitContext(cwd).then((context) => {
      if (current) setGit(context)
    })
    return () => {
      current = false
    }
    // A finished command may have switched branches, so it re-reads as well as a new directory.
  }, [cwd, lastCommandId])

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(undefined), 4000)
    return () => clearTimeout(timer)
  }, [notice])

  useEffect(() => {
    if (!created) return
    const timer = setTimeout(() => setCreated(undefined), 10000)
    return () => clearTimeout(timer)
  }, [created])

  const write = useCallback(
    (data: string) => window.api.terminal.write(session.id, data),
    [session.id]
  )

  const changeDirectory = (directory: string): void => {
    setPicking(false)
    // The new directory is observed back from the shell integration rather than assumed, and the
    // value is quoted so a path is never interpreted as shell syntax.
    write(`${syntaxFor(session.dialect).cd(directory)}\r`)
    handle.current?.focus()
  }

  const copy = useCallback((text: string, what: string) => {
    void navigator.clipboard.writeText(text).then(() => setNotice(`Copied ${what}`))
  }, [])

  const contextFor = useCallback(
    async (preferSelection: boolean): Promise<TerminalContext> => {
      const last = runtime?.lastCommand
      const text =
        (preferSelection ? selection?.text : undefined) ??
        last?.output ??
        (await handle.current?.text()) ??
        ''
      return {
        cwd,
        command: last?.command,
        exitCode: runtime?.lastExitCode,
        text
      }
    },
    [cwd, runtime, selection]
  )

  const sendToAgent = useCallback(
    async (
      kind: TerminalTaskKind,
      preferSelection = false,
      context?: TerminalContext
    ): Promise<void> => {
      if (!onCreateTask) return
      const resolved = context ?? (await contextFor(preferSelection))
      const request: TerminalTaskRequest = taskFromTerminal(kind, resolved)
      if (kind === 'ask') Object.assign(request, { launch: true, repoPath: git.root ?? undefined })
      else request.repoPath = await repoForDirectory(resolved.cwd, window.api.terminal.gitContext)
      setSelection(null)
      try {
        const id = await onCreateTask(request)
        if (request.launch) setNotice(`Asking the agent in ${id}`)
        else if (onLaunchTask || onOpenTaskById) setCreated(id)
        else setNotice(`Created ${id} — find it in Backlog`)
      } catch (reason) {
        setNotice(reason instanceof Error ? reason.message : 'Could not create the task')
      }
    },
    [contextFor, onCreateTask, onLaunchTask, onOpenTaskById, git.root]
  )

  // The context is captured when the prompt opens: focusing its field can clear the selection.
  const [asking, setAsking] = useState<{ context: TerminalContext; attached: string } | null>(null)
  const openAsk = useCallback(
    (preferSelection: boolean) => {
      if (!onCreateTask) return
      // The selection is read before the first await, so focusing the prompt cannot lose it.
      void contextFor(preferSelection).then((context) => {
        const attached =
          preferSelection && selection
            ? 'Your selection'
            : context.command
              ? `Output of ${context.command}`
              : 'This terminal'
        setAsking({ context, attached })
      })
    },
    [contextFor, onCreateTask, selection]
  )
  const closeAsk = useCallback(() => {
    setAsking(null)
    handle.current?.focus()
  }, [])
  const submitAsk = useCallback(
    async (question: string): Promise<void> => {
      const pending = asking
      if (!pending) return
      closeAsk()
      if (session.taskId && onAskFork) {
        try {
          if (await onAskFork(session.id, question)) {
            setSelection(null)
            setNotice('Asked a copy of this chat — it is open in a new tab')
            return
          }
        } catch (reason) {
          setNotice(reason instanceof Error ? reason.message : 'Could not ask the agent')
          return
        }
      }
      // Nothing to fork (a shell, or a chat that was never saved): hand over the terminal text.
      await sendToAgent('ask', false, { ...pending.context, question })
    },
    [asking, closeAsk, onAskFork, session.id, session.taskId, sendToAgent]
  )

  const reviewable =
    Boolean(session.taskId && onAskReview) &&
    taskStatus === 'in_review' &&
    agentStatus?.state !== 'working' &&
    agentStatus?.state !== 'waiting'

  // Ask for the PR once the review has passed: the task is in review, has a repository without a PR yet, and its agent is
  // running but not mid-turn (text typed at a bare shell would run as a command).
  const canCreatePr =
    Boolean(session.taskId) &&
    taskStatus === 'in_review' &&
    !taskPrsDone &&
    Boolean(runtime?.runningCommand) &&
    agentStatus?.state !== 'working' &&
    agentStatus?.state !== 'waiting'

  const createPr = useCallback(async (): Promise<void> => {
    if (!session.taskId || !canCreatePr) return
    try {
      await window.api.terminal.createPr(session.taskId)
      setNotice('Asked the agent to create the pull request')
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : 'Could not ask for a pull request')
    }
  }, [session.taskId, canCreatePr])

  const askReview = useCallback(async (): Promise<void> => {
    if (!session.taskId || !onAskReview || !reviewable) return
    try {
      await onAskReview(session.taskId)
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : 'Could not start the review')
    }
  }, [session.taskId, onAskReview, reviewable])

  const handOffWork = useCallback(async (): Promise<void> => {
    try {
      const text = (await handle.current?.text()) ?? runtime?.lastCommand?.output ?? ''
      const result = await window.api.terminal.handOff(session.id, text)
      setNotice(
        result.agentAsked
          ? `Asked the agent to write the handoff — ${result.taskId} is in Backlog`
          : `Handed off as ${result.taskId} — find it in Backlog`
      )
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : 'Could not hand off')
    }
  }, [session.id, runtime])

  const retry = useCallback(() => {
    const command = runtime?.lastCommand?.command
    if (command && canChange) write(`${command}\r`)
  }, [runtime, canChange, write])

  const copyAll = useCallback(
    () =>
      void Promise.resolve(handle.current?.text() ?? '').then((text) => copy(text, 'all output')),
    [copy]
  )

  const failed =
    runtime !== undefined &&
    !running &&
    runtime.lastExitCode !== undefined &&
    runtime.lastExitCode !== 0
  // Only a program on the alternate screen (vim, htop) owns the whole panel. Agent CLIs such as
  // Claude Code and Codex draw inline, so their sessions keep the bar.
  const claudeUsage = useClaudeUsage()
  const contextUsage = useContextUsage(session.id)
  const isClaude =
    session.provider === 'claude' ||
    /^(\S*\/)?claude$/.test(runtime?.runningCommand?.command?.trim().split(/\s+/)[0] ?? '')
  const isCodex = session.provider === 'codex'
  const codexUsage = useCodexUsage(session.id, isCodex)
  const agent = Boolean(session.taskId) || isAgentProgram(runtime?.runningCommand?.command)
  const fullscreen = altScreen && !agent
  // A shell's commands become blocks; an agent session is one long command, which is not a block.
  const blocksOn = !agent && !blockList && layout !== null && !layout.alternate
  const shellBlocks = layout?.blocks.filter((block) => !isAgentProgram(block.command)) ?? []
  const hoveredBlock =
    blockMenu ??
    stickyBlock ??
    (hoverLine === null
      ? null
      : (shellBlocks.find((block) => hoverLine >= block.startLine && hoverLine < block.endLine)
          ?.id ?? null))
  const outputOf = async (block: ActionBlock): Promise<string> =>
    block.readOutput
      ? block.readOutput()
      : ((await handle.current?.lines(block.startLine + 1, block.endLine)) ?? '')
  // The directory a block ran in is only recorded for the last command; older blocks use the current one.
  const blockCwd = (block: ActionBlock): string => {
    const last = runtime?.lastCommand
    return last && last.command === block.command && last.cwd ? last.cwd : cwd
  }
  const contextOfBlock = async (block: ActionBlock): Promise<TerminalContext> => ({
    cwd: blockCwd(block),
    command: block.command,
    exitCode: block.exitCode,
    text: await outputOf(block)
  })
  const askAboutBlock = (kind: TerminalTaskKind, block: ActionBlock): void =>
    void contextOfBlock(block).then((context) => sendToAgent(kind, false, context))
  const blockActions: BlockActions = {
    copyOutput: (block) => void outputOf(block).then((text) => copy(text, 'output')),
    copyCommand: (block) => copy(block.command, 'command'),
    retry: (block) => {
      if (canChange) write(`${block.command}\r`)
    },
    fix: (block) => askAboutBlock('fix', block),
    explain: (block) => askAboutBlock('explain', block),
    createTask: (block) => askAboutBlock('output', block),
    interrupt: () => write(INTERRUPT)
  }
  // Handing off only makes sense while an agent is running; a task's exited session is a bare shell.
  const canHandOff = agent && Boolean(runtime?.runningCommand)
  const showBar = runtime !== undefined && !runtime.terminated && !fullscreen

  useEffect(() => {
    if (!active) return
    return onTerminalCommand((command: TerminalCommand) => {
      switch (command) {
        case 'terminalDirectory':
          if (canChange) setPicking((open) => !open)
          return
        case 'terminalAskAgent':
          return openAsk(true)
        case 'terminalCopyOutput':
          return copyAll()
        case 'terminalRetry':
          return retry()
        case 'terminalSplit':
          return onSplit?.(cwd)
        case 'terminalFixLast':
          if (failed) return void sendToAgent('fix', true)
          return setNotice('The last command did not fail')
        case 'terminalAskReview':
          return void askReview()
        case 'terminalHandOff':
          return canHandOff ? void handOffWork() : undefined
        case 'terminalCreatePr':
          return void createPr()
      }
    })
  }, [
    active,
    canChange,
    canHandOff,
    sendToAgent,
    failed,
    openAsk,
    handOffWork,
    askReview,
    createPr,
    copyAll,
    retry,
    onSplit,
    cwd
  ])
  useEffect(() => {
    onFullscreenChange?.(session.id, fullscreen)
  }, [onFullscreenChange, session.id, fullscreen])
  const askHint = shortcutHint(bindings, 'terminalAskAgent')

  const groups: MenuItem[][] = [
    [
      { label: 'Copy all output', kbd: shortcutHint(bindings, 'terminalCopyOutput'), run: copyAll },
      {
        label: 'Clear',
        kbd: formatAccelerator('ctrl+l'),
        disabled: !canChange,
        run: () => write(CLEAR)
      },
      {
        label: 'Retry last command',
        kbd: shortcutHint(bindings, 'terminalRetry'),
        disabled: !canChange || !runtime?.lastCommand,
        run: retry
      }
    ],
    [
      { label: '✦ Explain last output', agent: true, run: () => void sendToAgent('explain') },
      { label: 'Create task from output', run: () => void sendToAgent('output') },
      ...(reviewable
        ? [{ label: '✓ Ask to review', agent: true, run: () => void askReview() }]
        : []),
      ...(canCreatePr
        ? [{ label: '⎇ Create pull request', agent: true, run: () => void createPr() }]
        : []),
      ...(canHandOff
        ? [{ label: 'Hand off to another agent', agent: true, run: () => void handOffWork() }]
        : [])
    ],
    [
      // A remote session's folder is on its host, out of reach of this file manager.
      ...(session.host
        ? []
        : [
            {
              label: `Reveal directory in ${FILE_MANAGER}`,
              run: () => void window.api.terminal.revealDirectory(cwd)
            }
          ]),
      {
        label: 'Split terminal',
        kbd: shortcutHint(bindings, 'terminalSplit'),
        run: () => onSplit?.(cwd)
      }
    ]
  ]

  return (
    <div className="@container flex h-full w-full flex-col">
      <div className="relative min-h-0 flex-1">
        {/* Always rendered, so opening the panel resizes the terminal rather than remounting it. */}
        <div
          className="relative h-full"
          style={{ marginRight: activity ? ACTIVITY_RESERVE : undefined }}
        >
          <TerminalEngineView
            nativeTerminal={nativeTerminal}
            sessionId={session.id}
            dialect={session.dialect}
            active={active}
            theme={theme}
            bindings={bindings}
            handle={handle}
            onSelection={setSelection}
            onFullscreenChange={setAltScreen}
            onBlocks={setLayout}
            onHoverLine={setHoverLine}
            blockActions={blockActions}
            canRetry={canChange}
            commandHints={[
              { keys: askHint, label: 'ask agent' },
              { keys: shortcutHint(bindings, 'terminalDirectory'), label: 'change directory' }
            ]}
            onBlockListChange={setBlockList}
            agentProvider={session.provider}
            agentWaiting={
              agentStatus?.state === 'waiting' ? agentStatus.lastMessage || 'Waiting on you' : null
            }
          />
          {blocksOn && layout ? (
            <TerminalBlocks
              layout={{ ...layout, blocks: shellBlocks }}
              hoveredId={hoveredBlock}
              menuId={blockMenu}
              canRetry={canChange}
              actions={blockActions}
              onHover={setStickyBlock}
              onMenu={setBlockMenu}
            />
          ) : null}
          {selection && !fullscreen && onCreateTask ? (
            <SelectionToolbar
              selection={selection}
              askHint={askHint}
              onCopy={() => {
                copy(selection.text, 'selection')
                setSelection(null)
              }}
              onExplain={() => void sendToAgent('explain', true)}
              onAsk={() => openAsk(true)}
            />
          ) : null}
          {asking ? (
            <AskPrompt
              attached={asking.attached}
              forking={Boolean(session.taskId && onAskFork)}
              sendHint="↵"
              onSubmit={(question) => void submitAsk(question)}
              onCancel={closeAsk}
            />
          ) : null}
          {created ? (
            <div
              role="status"
              className="absolute bottom-2 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 rounded-md border border-edge-strong bg-panel px-2.5 py-1 text-[11.5px] text-ink shadow-xl"
            >
              <span>Created {created}</span>
              {onLaunchTask ? (
                <button
                  type="button"
                  className="font-medium text-accent-ink hover:underline"
                  onClick={() => {
                    setCreated(undefined)
                    void onLaunchTask(created).catch((reason: unknown) =>
                      setNotice(reason instanceof Error ? reason.message : 'Could not launch')
                    )
                  }}
                >
                  Launch
                </button>
              ) : null}
              {onOpenTaskById ? (
                <button
                  type="button"
                  className="font-medium text-accent-ink hover:underline"
                  onClick={() => {
                    setCreated(undefined)
                    onOpenTaskById(created)
                  }}
                >
                  Open
                </button>
              ) : null}
            </div>
          ) : null}
          {notice ? (
            <div
              role="status"
              className="pointer-events-none absolute bottom-2 left-1/2 z-20 -translate-x-1/2 rounded-md border border-edge-strong bg-panel px-2.5 py-1 text-[11.5px] text-ink shadow-xl"
            >
              {notice}
            </div>
          ) : null}
        </div>
        {activity}
      </div>
      {showBar && failed && runtime && !blockList ? (
        <FailureActions
          runtime={runtime}
          onFix={() => void sendToAgent('fix')}
          onExplain={() => void sendToAgent('explain')}
          onCreate={() => void sendToAgent('output')}
        />
      ) : null}
      {showBar ? (
        <ContextBar
          runtime={runtime}
          fallbackCwd={session.cwd}
          isAgent={agent}
          agentState={shownState ?? agentStatus?.state}
          subagents={runningSubagents(agentStatus)}
          taskStatus={session.taskId ? taskStatus : undefined}
          blocksOn={blocksOn || blockList}
          inputHints={blockList}
          branch={git.branch}
          repoRoot={git.root}
          diff={
            diffStat && onShowChanges ? (
              // The bar ignores the pointer so it never blocks the terminal; the button opts back in.
              <span className="pointer-events-auto flex">
                <DiffStatButton stat={diffStat} onClick={onShowChanges} />
              </span>
            ) : undefined
          }
          usage={
            isClaude ? (
              <UsageButton
                agent="Claude"
                usage={claudeUsage}
                context={contextUsage}
                onCompact={() => write('/compact\r')}
              />
            ) : isCodex && codexUsage ? (
              <UsageButton
                agent="Codex"
                usage={codexUsage.usage}
                context={codexUsage.context}
                onCompact={() => write('/compact\r')}
              />
            ) : undefined
          }
          onOpenBranch={() => {
            if (!git.root) return
            void window.api.terminal.openInCode(git.root).then((result) => {
              if (result === 'folder')
                setNotice('VS Code is not installed — opened the folder instead.')
              else if (result === 'failed') setNotice('Could not open the folder.')
            })
          }}
          picking={picking}
          menuOpen={menuOpen}
          askHint={askHint}
          directoryHint={shortcutHint(bindings, 'terminalDirectory')}
          menu={
            menuOpen ? <ActionsMenu groups={groups} onClose={() => setMenuOpen(false)} /> : null
          }
          onTogglePicker={() => setPicking((open) => !open)}
          onClosePicker={() => {
            setPicking(false)
            handle.current?.focus()
          }}
          onToggleMenu={() => {
            setPicking(false)
            setMenuOpen((open) => !open)
          }}
          onChoose={changeDirectory}
          onInterrupt={() => write(INTERRUPT)}
          onAsk={() => openAsk(false)}
          onReview={reviewable ? () => void askReview() : undefined}
          onCreatePr={canCreatePr ? () => void createPr() : undefined}
          onHandOff={canHandOff ? () => void handOffWork() : undefined}
          reviewHint={shortcutHint(bindings, 'terminalAskReview')}
        >
          {children}
        </ContextBar>
      ) : null}
    </div>
  )
}
