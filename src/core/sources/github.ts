import { execFile } from 'node:child_process'
import type { RemoteItem, SourceConfig } from '../types.js'
import type { CliStatus, CommandRunner, RunResult, SourceAdapter, SourceWriter } from './types.js'

/** Oldest `gh` whose `issue list --json` and `issue close` we rely on. */
export const GH_MINIMUM_VERSION = '2.0.0'

/**
 * A Finder-launched app gets a bare PATH, which misses Homebrew. These are the places `gh` is
 * usually installed.
 */
const EXTRA_PATH = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']

export function ghEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const current = (env.PATH ?? '').split(':').filter(Boolean)
  const merged = [...current, ...EXTRA_PATH.filter((dir) => !current.includes(dir))]
  return { ...env, PATH: merged.join(':'), GH_PROMPT_DISABLED: '1', NO_COLOR: '1' }
}

export const runCommand: CommandRunner = (command, args) =>
  new Promise<RunResult>((resolve) => {
    execFile(
      command,
      args,
      { env: ghEnv(), encoding: 'utf8', timeout: 60_000, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (!error) return resolve({ code: 0, stdout, stderr })
        const failure = error as NodeJS.ErrnoException & { code?: string | number }
        if (failure.code === 'ENOENT') {
          return resolve({ code: 127, stdout: '', stderr: String(failure.message), notFound: true })
        }
        resolve({
          code: typeof failure.code === 'number' ? failure.code : 1,
          stdout: stdout ?? '',
          stderr: stderr || String(failure.message)
        })
      }
    )
  })

export function compareVersions(a: string, b: string): number {
  const left = a.split('.').map((part) => Number.parseInt(part, 10) || 0)
  const right = b.split('.').map((part) => Number.parseInt(part, 10) || 0)
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0)
    if (diff !== 0) return diff < 0 ? -1 : 1
  }
  return 0
}

export function parseGhVersion(output: string): string | null {
  return /gh version (\d+\.\d+(?:\.\d+)?)/.exec(output)?.[1] ?? null
}

/** Is `gh` installed, new enough, and logged in? Never throws. */
export async function checkGh(run: CommandRunner): Promise<CliStatus> {
  const version = await run('gh', ['--version'])
  if (version.notFound) return { state: 'missing' }
  const parsed = version.code === 0 ? parseGhVersion(version.stdout) : null
  if (!parsed) return { state: 'missing' }
  if (compareVersions(parsed, GH_MINIMUM_VERSION) < 0) {
    return { state: 'outdated', version: parsed, minimum: GH_MINIMUM_VERSION }
  }
  const auth = await run('gh', ['auth', 'status'])
  if (auth.code !== 0) return { state: 'unauthenticated', version: parsed }
  const who = await run('gh', ['api', 'user', '--jq', '.login'])
  const account = who.code === 0 ? who.stdout.trim() : ''
  return { state: 'ready', version: parsed, ...(account ? { account } : {}) }
}

const REPO_RE = /^[\w.-]+\/[\w.-]+$/

interface GhIssue {
  number: number
  title: string
  body: string | null
  state: string
  url: string
  updatedAt: string
  labels: { name: string }[]
}

const ISSUE_FIELDS = 'number,title,body,state,url,updatedAt,labels'

function toItem(issue: GhIssue): RemoteItem {
  return {
    id: String(issue.number),
    url: issue.url,
    title: issue.title,
    body: issue.body ?? '',
    state: issue.state.toUpperCase() === 'CLOSED' ? 'closed' : 'open',
    labels: issue.labels.map((label) => label.name),
    updatedAt: issue.updatedAt
  }
}

function fail(result: RunResult, what: string): never {
  const detail = result.stderr.trim().split('\n')[0] || `exit ${result.code}`
  throw new Error(`${what}: ${detail}`)
}

function repoOf(config: SourceConfig): string {
  if (!REPO_RE.test(config.repo))
    throw new Error(`"${config.repo}" is not an owner/name repository`)
  return config.repo
}

function parseIssues(stdout: string): GhIssue[] {
  const parsed: unknown = JSON.parse(stdout || '[]')
  if (!Array.isArray(parsed)) throw new Error('Unexpected reply from gh')
  return parsed as GhIssue[]
}

function writer(config: SourceConfig, run: CommandRunner): SourceWriter {
  const repo = repoOf(config)
  const issue = async (verb: string[], id: string, what: string): Promise<void> => {
    const result = await run('gh', ['issue', ...verb, id, '-R', repo])
    if (result.code !== 0) fail(result, what)
  }
  return {
    close: (id) => issue(['close'], id, `Could not close #${id}`),
    reopen: (id) => issue(['reopen'], id, `Could not reopen #${id}`),
    async comment(id, body) {
      const result = await run('gh', ['issue', 'comment', id, '-R', repo, '--body', body])
      if (result.code !== 0) fail(result, `Could not comment on #${id}`)
    }
  }
}

export const githubAdapter: SourceAdapter = {
  provider: 'github',
  label: 'GitHub',
  tagPrefix: 'github',
  status: checkGh,

  async check(config, run) {
    const status = await checkGh(run)
    if (status.state === 'missing')
      return { ok: false, reason: 'The GitHub CLI (gh) is not installed.' }
    if (status.state === 'outdated') {
      return {
        ok: false,
        reason: `gh ${status.version} is too old; ${status.minimum} or newer is needed.`
      }
    }
    if (status.state === 'unauthenticated') {
      return { ok: false, reason: 'gh is not logged in. Run `gh auth login`.' }
    }
    if (!REPO_RE.test(config.repo)) {
      return { ok: false, reason: 'Enter the repository as owner/name.' }
    }
    const repo = await run('gh', ['repo', 'view', config.repo, '--json', 'name'])
    if (repo.code !== 0) {
      return {
        ok: false,
        reason: `Cannot reach ${config.repo}: ${repo.stderr.trim().split('\n')[0]}`
      }
    }
    return { ok: true, ...(status.account ? { account: status.account } : {}) }
  },

  async list(config, run, { limit }) {
    const args = [
      'issue',
      'list',
      '-R',
      repoOf(config),
      '--state',
      config.includeClosed ? 'all' : 'open',
      '--limit',
      String(limit),
      '--json',
      ISSUE_FIELDS
    ]
    for (const label of config.labels) args.push('--label', label)
    const result = await run('gh', args)
    if (result.code !== 0) fail(result, 'Could not list issues')
    return parseIssues(result.stdout).map(toItem)
  },

  async get(config, run, id) {
    const result = await run('gh', [
      'issue',
      'view',
      id,
      '-R',
      repoOf(config),
      '--json',
      ISSUE_FIELDS
    ])
    if (result.code !== 0) fail(result, `Could not read #${id}`)
    return toItem(JSON.parse(result.stdout) as GhIssue)
  },

  parseRef(config, text) {
    const trimmed = text.trim()
    const url = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)/.exec(trimmed)
    if (url) return url[1]!.toLowerCase() === config.repo.toLowerCase() ? url[2]! : null
    return /^#?(\d+)$/.exec(trimmed)?.[1] ?? null
  },

  writer
}
