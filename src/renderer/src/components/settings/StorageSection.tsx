import type { ReactNode } from 'react'
import { Card, DirectoryInput, Field, Hint } from '../ui.js'
import type { SectionProps } from './sections.js'

export function StorageSection({ draft, patch }: SectionProps): ReactNode {
  return (
    <>
      <Field label="Storage folder">
        <DirectoryInput value={draft.storageDir} onChange={(storageDir) => patch({ storageDir })} />
      </Field>
      <Card className="gap-2 px-3.5 py-3 font-mono text-[11.5px] text-dim">
        <span>{draft.storageDir}/</span>
        <span className="pl-4">
          <span className="text-ink">tasks/*.md</span>
          <span className="font-[family-name:var(--font-ui)] text-faint">
            {'  '}— Default workspace
          </span>
        </span>
        <span className="pl-4">
          <span className="text-ink">workspaces/&lt;name&gt;/</span>
          <span className="font-[family-name:var(--font-ui)] text-faint">
            {'  '}— every other workspace
          </span>
        </span>
      </Card>
      <Hint>
        This is Styr’s own data, not your code. Point it at a git repo if you want tasks versioned.
      </Hint>
    </>
  )
}
