import { execFile, execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { RemoteItem } from '../types.js'
import type { CliStatus, CommandRunner, RunResult, SourceAdapter, SourceWriter } from './types.js'

/** Oldest `gh` whose `issue list --json` and `issue close` we rely on. */
export const GH_MINIMUM_VERSION = '2.0.0'

/**
 * A Finder-launched app gets a bare PATH, which misses Homebrew. These are the places `gh` is
 * usually installed.
 */
const EXTRA_PATH = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']

export function ghEnv(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): NodeJS.ProcessEnv {
  // A Windows app inherits the full user PATH, and the installer puts `gh` on it.
  if (platform === 'win32') return { ...env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' }
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

interface BlockerPage {
  data?: {
    repository?: {
      issues: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null }
        nodes: {
          number: number
          blockedBy: { nodes: { number: number; repository: { nameWithOwner: string } }[] }
        }[]
      }
    }
  }
}

/**
 * "Blocked by" relations of a repository's open issues (a closed one is Done, so it has nothing to wait on), by issue number. `gh issue list` does not carry
 * them, so this is one GraphQL read per 100 issues. Best effort: null when it cannot be read
 * (older GitHub Enterprise, no access), which leaves local blockers alone.
 */
async function readBlockers(
  run: CommandRunner,
  target: string
): Promise<Map<string, { target: string; id: string }[]> | null> {
  const [owner, name] = target.split('/')
  const query = `query($owner:String!,$name:String!,$after:String){repository(owner:$owner,name:$name){issues(first:100,after:$after,states:OPEN,orderBy:{field:UPDATED_AT,direction:DESC}){pageInfo{hasNextPage endCursor}nodes{number blockedBy(first:50){nodes{number repository{nameWithOwner}}}}}}}`
  const found = new Map<string, { target: string; id: string }[]>()
  let after: string | null = null
  for (let page = 0; page < 5; page++) {
    const args = [
      'api',
      'graphql',
      '-f',
      `query=${query}`,
      '-F',
      `owner=${owner}`,
      '-F',
      `name=${name}`
    ]
    if (after) args.push('-F', `after=${after}`)
    const result = await run('gh', args)
    if (result.code !== 0) return null
    let parsed: BlockerPage
    try {
      parsed = JSON.parse(result.stdout) as BlockerPage
    } catch {
      return null
    }
    const issues = parsed.data?.repository?.issues
    if (!issues) return null
    for (const node of issues.nodes) {
      found.set(
        String(node.number),
        node.blockedBy.nodes.map((blocker) => ({
          target: blocker.repository.nameWithOwner,
          id: String(blocker.number)
        }))
      )
    }
    if (!issues.pageInfo.hasNextPage) break
    after = issues.pageInfo.endCursor
  }
  return found
}

function fail(result: RunResult, what: string): never {
  const detail = result.stderr.trim().split('\n')[0] || `exit ${result.code}`
  throw new Error(`${what}: ${detail}`)
}

function checked(target: string): string {
  if (!REPO_RE.test(target)) throw new Error(`"${target}" is not an owner/name repository`)
  return target
}

function parseIssues(stdout: string): GhIssue[] {
  const parsed: unknown = JSON.parse(stdout || '[]')
  if (!Array.isArray(parsed)) throw new Error('Unexpected reply from gh')
  return parsed as GhIssue[]
}

/** `owner/name` from a git remote URL (https or ssh) pointing at github.com, else null. */
export function parseGithubRemote(url: string): string | null {
  const match =
    /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(
      url.trim()
    )
  return match ? `${match[1]}/${match[2]}` : null
}

/** The GitHub repository a checkout's `origin` (else its first remote) points at. */
export function detectGithubRepo(repoPath: string): string | null {
  if (!repoPath || !existsSync(repoPath)) return null
  // a hook or an agent terminal may carry GIT_DIR and friends, which would point git elsewhere
  const env = { ...process.env }
  for (const key of Object.keys(env))
    if (key.startsWith('GIT_') && key !== 'GIT_SSH_COMMAND') delete env[key]
  const git = (args: string[]): string => {
    try {
      return execFileSync('git', args, {
        cwd: repoPath,
        env,
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim()
    } catch {
      return ''
    }
  }
  const origin = parseGithubRemote(git(['remote', 'get-url', 'origin']))
  if (origin) return origin
  for (const remote of git(['remote']).split('\n').filter(Boolean)) {
    const found = parseGithubRemote(git(['remote', 'get-url', remote]))
    if (found) return found
  }
  return null
}

/** Not on the adapter: `writableSource` is the only caller. */
export function githubWriter(target: string, run: CommandRunner): SourceWriter {
  const repo = checked(target)
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
  detectTarget: detectGithubRepo,

  async list(config, run, target, { limit }) {
    const args = [
      'issue',
      'list',
      '-R',
      checked(target),
      '--state',
      config.includeClosed ? 'all' : 'open',
      '--limit',
      String(limit),
      '--json',
      ISSUE_FIELDS
    ]
    for (const label of config.labels) args.push('--label', label)
    const result = await run('gh', args)
    if (result.code !== 0) fail(result, `Could not list issues of ${target}`)
    const items = parseIssues(result.stdout).map(toItem)
    const blockers = await readBlockers(run, target)
    if (blockers) for (const item of items) item.blockedBy = blockers.get(item.id) ?? []
    return items
  },

  async get(run, target, id) {
    const result = await run('gh', [
      'issue',
      'view',
      id,
      '-R',
      checked(target),
      '--json',
      ISSUE_FIELDS
    ])
    if (result.code !== 0) fail(result, `Could not read ${target}#${id}`)
    return toItem(JSON.parse(result.stdout) as GhIssue)
  },

  parseRef(text, defaultTarget) {
    const trimmed = text.trim()
    const url = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)/.exec(trimmed)
    if (url) return { target: url[1]!, id: url[2]! }
    const id = /^#?(\d+)$/.exec(trimmed)?.[1]
    return id && defaultTarget ? { target: defaultTarget, id } : null
  }
}
