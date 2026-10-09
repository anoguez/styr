import { useEffect, useState, type ReactNode } from 'react'
import { PLATFORM } from '../../lib/platform.js'
import {
  Card,
  CardRow,
  DirectoryInput,
  Field,
  Hint,
  Select,
  Stepper,
  SwitchRow,
  inputBase
} from '../ui.js'
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

export function PreferencesSection({ draft, patch }: SectionProps): ReactNode {
  return (
    <>
      <div className="flex flex-col gap-2.5">
        <span className="text-[12px] font-semibold text-dim">New tasks start with</span>
        <Card>
          <CardRow>
            <SwitchRow
              checked={draft.taskDefaults.useWorktree}
              onChange={(useWorktree) =>
                patch({ taskDefaults: { ...draft.taskDefaults, useWorktree } })
              }
              label="Own git worktree"
              hint="Each agent gets a separate checkout on a styr/TASK-… branch, so parallel runs never collide."
            />
          </CardRow>
          <CardRow>
            <SwitchRow
              checked={draft.taskDefaults.orchestrate}
              onChange={(orchestrate) =>
                patch({ taskDefaults: { ...draft.taskDefaults, orchestrate } })
              }
              label="Dispatch can start it"
              hint="Dispatch may pick the task up when a slot is free."
            />
          </CardRow>
        </Card>
        <Hint>You can still change both on any task.</Hint>
      </div>
      <div className="flex flex-col gap-2.5">
        <span className="text-[12px] font-semibold text-dim">Done column shows</span>
        <Card>
          <CardRow>
            <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-3.5 py-3">
              <span className="flex flex-col gap-[3px]">
                <span className="text-[12.5px] text-ink">Most recent tasks</span>
                <Hint>How many finished tasks stay on the board. 0 shows them all.</Hint>
              </span>
              <Stepper
                label="Most recent tasks"
                value={draft.doneCap.maxCount}
                min={0}
                max={1000}
                onChange={(maxCount) => patch({ doneCap: { ...draft.doneCap, maxCount } })}
              />
            </div>
          </CardRow>
          <CardRow>
            <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-3.5 py-3">
              <span className="flex flex-col gap-[3px]">
                <span className="text-[12.5px] text-ink">Finished within (days)</span>
                <Hint>Older tasks are hidden. 0 never hides by age.</Hint>
              </span>
              <Stepper
                label="Finished within (days)"
                value={draft.doneCap.maxAgeDays}
                min={0}
                max={365}
                onChange={(maxAgeDays) => patch({ doneCap: { ...draft.doneCap, maxAgeDays } })}
              />
            </div>
          </CardRow>
        </Card>
        <Hint>Hidden tasks are not archived — Show all in the Done column brings them back.</Hint>
      </div>
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
