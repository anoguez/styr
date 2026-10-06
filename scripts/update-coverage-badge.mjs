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

// `--check` fails when the README badge has drifted from the measured coverage, so CI makes the
// author refresh it (within half a point, so platform noise does not flake CI) (`yarn coverage:badge`) instead of it going stale.
if (process.argv.includes('--check')) {
  const current = readme.match(BADGE_PATTERN)[0]
  const recorded = Number(current.match(/coverage-([\d.]+)%25/)[1])
  if (Math.abs(recorded - coverage) > 0.5) {
    console.error(
      `README coverage badge is stale.\n  found:    ${current}\n  expected: ${badge}\nRun \`yarn coverage:badge\` and commit README.md.`
    )
    process.exit(1)
  }
} else {
  writeFileSync(README_FILE, readme.replace(BADGE_PATTERN, badge))
}
