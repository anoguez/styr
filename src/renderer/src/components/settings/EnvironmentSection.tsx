import { useEffect, useState, type ReactNode } from 'react'
import { PLATFORM } from '../../lib/platform.js'
import { DirectoryInput, Field, Segmented, Select, inputBase } from '../ui.js'
import type { SectionProps } from './sections.js'

const OTHER_APP = '\u0000other'

/** Picks the app that opens files: the system default, an installed app, or one found by browsing. */
function OpenWithSelect({
  value,
  onChange
}: {
  value: string
  onChange: (value: string) => void
}): ReactNode {
  const [apps, setApps] = useState<string[]>([])
  useEffect(() => {
    void window.api.settings.listApps().then(setApps)
  }, [])
  const options = value && !apps.includes(value) ? [value, ...apps] : apps
  return (
    <div className="w-60">
      <Select
        compact
        aria-label="Open files with"
        value={value}
        onChange={(event) => {
          if (event.target.value !== OTHER_APP) return onChange(event.target.value)
          void window.api.settings.pickApp().then((picked) => picked && onChange(picked))
        }}
      >
        <option value="">System default</option>
        {options.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
        <option value={OTHER_APP}>Other…</option>
      </Select>
    </div>
  )
}

export function EnvironmentSection({ draft, patch }: SectionProps): ReactNode {
  return (
    <>
      <Field
        label="Working directory"
        hint="Where agents run and where + Shell opens. Blank uses the storage folder."
      >
        <DirectoryInput
          value={draft.defaultRepoPath}
          onChange={(defaultRepoPath) => patch({ defaultRepoPath })}
          placeholder="Storage folder"
        />
      </Field>
      <Field
        label="Worktree location"
        hint={
          draft.worktreeLocation === 'inside'
            ? 'New worktrees go in <repo>/.styr/worktrees, so they reuse the repository’s installed dependencies such as node_modules. Styr adds a .gitignore there, so your project stays clean. Existing worktrees stay where they are.'
            : 'New worktrees go in a <repo>.worktrees folder next to the repository, outside your project. Existing worktrees stay where they are.'
        }
      >
        <Segmented
          label="Worktree location"
          value={draft.worktreeLocation}
          onChange={(worktreeLocation) => patch({ worktreeLocation })}
          options={[
            { value: 'beside', label: 'Beside the repository' },
            { value: 'inside', label: 'Inside .styr/worktrees' }
          ]}
        />
      </Field>
      <Field
        label="Shell"
        hint={
          PLATFORM === 'win32'
            ? 'Every terminal session starts in this shell. Agents launch from Git Bash or PowerShell 7 (pwsh.exe). Blank picks one for you.'
            : 'Every terminal session starts in this shell. Blank uses $SHELL.'
        }
      >
        <input
          className={`${inputBase} h-8 w-60 px-2.5 font-mono text-[11.5px]`}
          value={draft.shell}
          onChange={(event) => patch({ shell: event.target.value })}
        />
      </Field>
      <Field
        label="Restore terminal tabs"
        hint={
          draft.restoreTabs === 'always'
            ? 'After a relaunch, the tabs of your last session reopen on their own. Agent tabs resume their chat and send nothing.'
            : draft.restoreTabs === 'never'
              ? 'Styr does not remember your terminal tabs, and offers nothing after a relaunch.'
              : 'After a relaunch, a banner offers to reopen the tabs of your last session. Agent tabs resume their chat and send nothing.'
        }
      >
        <Segmented
          label="Restore terminal tabs"
          value={draft.restoreTabs}
          onChange={(restoreTabs) => patch({ restoreTabs })}
          options={[
            { value: 'ask', label: 'Ask' },
            { value: 'always', label: 'Always' },
            { value: 'never', label: 'Never' }
          ]}
        />
      </Field>
      <Field
        label="Open files with"
        hint="App that opens task files and folders. System default uses whatever the operating system has set for the file type."
      >
        <OpenWithSelect
          value={draft.openFilesWith}
          onChange={(openFilesWith) => patch({ openFilesWith })}
        />
      </Field>
    </>
  )
}
