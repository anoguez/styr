// electron-builder `afterAllArtifactBuild` hook. electron-builder notarises the .app but not the DMG
// around it, and a DMG that is signed but not notarised is *rejected* by Gatekeeper, which is worse
// than leaving it unsigned. So the DMG is notarised and stapled here, under the same APPLE_*
// credentials. Without them it is skipped, just as electron-builder skips the app.
//
// Stapling rewrites the DMG after its .blockmap was computed. That only matters for delta
// auto-updates, which Styr does not use.
import { execFileSync } from 'node:child_process'

export default function notarizeDmg(buildResult) {
  const dmgs = buildResult.artifactPaths.filter((path) => path.endsWith('.dmg'))
  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env
  if (dmgs.length === 0) return []
  if (!APPLE_ID || !APPLE_APP_SPECIFIC_PASSWORD || !APPLE_TEAM_ID) {
    console.warn('  • skipped DMG notarization  reason=APPLE_* credentials are not set')
    return []
  }

  for (const dmg of dmgs) {
    console.log(`  • notarizing DMG  file=${dmg}`)
    execFileSync(
      'xcrun',
      [
        'notarytool',
        'submit',
        dmg,
        '--apple-id',
        APPLE_ID,
        '--password',
        APPLE_APP_SPECIFIC_PASSWORD,
        '--team-id',
        APPLE_TEAM_ID,
        '--wait'
      ],
      { stdio: 'inherit' }
    )
    execFileSync('xcrun', ['stapler', 'staple', dmg], { stdio: 'inherit' })
  }
  return []
}
