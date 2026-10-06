import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const LCOV_FILE = 'coverage/lcov.info'
const README_FILE = 'README.md'
const BADGE_PATTERN = /!\[Test coverage\]\(https:\/\/img\.shields\.io\/badge\/coverage-[^)]+\)/

function coverageFromLcov(lcov) {
  let foundLines = 0
  let hitLines = 0

  for (const line of lcov.split('\n')) {
    if (line.startsWith('LF:')) foundLines += Number(line.slice(3))
    if (line.startsWith('LH:')) hitLines += Number(line.slice(3))
  }

  if (foundLines === 0) throw new Error(`No covered lines found in ${LCOV_FILE}`)
  return (hitLines / foundLines) * 100
}

function colourFor(coverage) {
  if (coverage >= 80) return 'brightgreen'
  if (coverage >= 70) return 'green'
  if (coverage >= 50) return 'yellow'
  if (coverage >= 30) return 'orange'
  return 'red'
}

if (!existsSync(LCOV_FILE))
  throw new Error(`${LCOV_FILE} does not exist; run tests with coverage first`)

const coverage = coverageFromLcov(readFileSync(LCOV_FILE, 'utf8'))
const badge = `![Test coverage](https://img.shields.io/badge/coverage-${coverage.toFixed(2)}%25-${colourFor(coverage)})`
const readme = readFileSync(README_FILE, 'utf8')

if (!BADGE_PATTERN.test(readme)) throw new Error(`Test coverage badge not found in ${README_FILE}`)

// `--check` fails only when coverage has fallen below the README badge (within half a point, so
// platform noise does not flake CI). A rise is good news and never fails: the pre-commit hook and
// the release workflow refresh the badge (`yarn coverage:badge`).
if (process.argv.includes('--check')) {
  const current = readme.match(BADGE_PATTERN)[0]
  const recorded = Number(current.match(/coverage-([\d.]+)%25/)[1])
  if (coverage < recorded - 0.5) {
    console.error(
      `Test coverage fell: the README badge says ${recorded}% but it is now ${coverage.toFixed(2)}%.\nAdd tests, or if the drop is deliberate run \`yarn coverage:badge\` and commit README.md.`
    )
    process.exit(1)
  }
} else {
  writeFileSync(README_FILE, readme.replace(BADGE_PATTERN, badge))
}
