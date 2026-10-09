import { useState, type ReactNode } from 'react'
import {
  ANSI_COLOURS,
  DEFAULT_THEME,
  TASK_STATUS_LABELS,
  TASK_STATUSES,
  type AnsiColour,
  type TerminalPalette
} from '@core/types.js'
import { ansiLabel, TERMINAL_FONTS, TERMINAL_PALETTES, UI_FONTS } from '../../hooks/useTheme.js'
import { terminalTheme } from '../../lib/palette.js'
import { THEME_PRESETS, applyPreset } from '../../lib/themePresets.js'
import {
  Card,
  ColorInput,
  ColorPopover,
  ColorSwatch,
  Field,
  Hint,
  Select,
  Stepper,
  Switch
} from '../ui.js'
import type { SectionProps } from './sections.js'

function ThemeSlider({
  label,
  value,
  min,
  max,
  readout,
  onChange
}: {
  label: string
  value: number
  min: number
  max: number
  readout: string
  onChange: (value: number) => void
}): ReactNode {
  return (
    <label className="grid grid-cols-[72px_minmax(0,1fr)_40px] items-center gap-2.5">
      <span className="text-[12px] text-dim">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="w-full cursor-pointer accent-[var(--color-accent)]"
      />
      <span className="text-right font-mono text-[11px] text-faint">{readout}</span>
    </label>
  )
}

const PREVIEW_SLOTS: AnsiColour[] = ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan']

function samePalette(a: TerminalPalette, b: TerminalPalette): boolean {
  return ANSI_COLOURS.every((slot) => a[slot].toLowerCase() === b[slot].toLowerCase())
}

export function ThemeSection({ draft, patch }: SectionProps): ReactNode {
  const [ansiSlot, setAnsiSlot] = useState<AnsiColour>('red')
  const [editingAnsi, setEditingAnsi] = useState(false)
  const preview = terminalTheme(draft.theme)
  return (
    <>
      <div className="flex flex-col gap-2">
        <div className="flex items-center">
          <span className="text-[12px] font-semibold text-dim">Theme</span>
          <button
            type="button"
            className="ml-auto h-[22px] rounded-md px-1.5 text-[11.5px] text-faint transition-colors hover:text-ink"
            onClick={() => patch({ theme: DEFAULT_THEME })}
          >
            Reset theme
          </button>
        </div>
        <div className="flex flex-wrap gap-2">
          {THEME_PRESETS.map((preset) => {
            const on = draft.theme.base.toLowerCase() === preset.base
            return (
              <button
                key={preset.label}
                type="button"
                aria-pressed={on}
                onClick={() => patch({ theme: applyPreset(draft.theme, preset) })}
                className="flex flex-col items-center gap-[5px]"
              >
                <span
                  style={{ backgroundColor: preset.base }}
                  className={`flex h-[34px] w-[52px] items-end gap-[3px] rounded-lg border-2 p-1 shadow-[inset_0_0_0_1px_rgba(128,128,128,0.25)] ${
                    on ? 'border-[var(--color-accent-text)]' : 'border-transparent'
                  }`}
                >
                  <span style={{ backgroundColor: preset.accent }} className="h-2 w-3 rounded-sm" />
                  {Object.values(preset.columns).map((hex) => (
                    <span
                      key={hex}
                      style={{ backgroundColor: hex }}
                      className="h-2 w-[5px] rounded-sm"
                    />
                  ))}
                </span>
                <span className={`text-[11px] ${on ? 'text-ink' : 'text-faint'}`}>
                  {preset.label}
                </span>
              </button>
            )
          })}
          <ColorPopover
            value={draft.theme.base}
            onChange={(base) => patch({ theme: { ...draft.theme, base } })}
            trigger={({ open, toggle }) => {
              const custom = !THEME_PRESETS.some(
                (preset) => preset.base === draft.theme.base.toLowerCase()
              )
              return (
                <button
                  type="button"
                  aria-label="Custom base colour"
                  aria-expanded={open}
                  onClick={toggle}
                  className="flex flex-col items-center gap-[5px]"
                >
                  <span
                    style={custom ? { backgroundColor: draft.theme.base } : undefined}
                    className={`grid h-[34px] w-[52px] place-items-center rounded-lg border-2 text-[15px] text-dim shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)] ${
                      custom
                        ? 'border-[var(--color-accent-text)]'
                        : 'border-dashed border-edge-strong'
                    }`}
                  >
                    {custom ? null : '+'}
                  </span>
                  <span className={`text-[11px] ${custom ? 'text-ink' : 'text-faint'}`}>
                    Custom
                  </span>
                </button>
              )
            }}
          />
        </div>
        <Hint>
          A theme sets the base, accent and column colours together. Every surface and text colour
          is derived from the base, so contrast holds; change any colour below to make it your own.
        </Hint>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-[12px] font-semibold text-dim">Accent and columns</span>
        <div className="grid grid-cols-5 gap-2">
          <ColorSwatch
            label="Accent"
            value={draft.theme.accent}
            onChange={(accent) => patch({ theme: { ...draft.theme, accent } })}
          />
          {TASK_STATUSES.map((status, index) => (
            <ColorSwatch
              key={status}
              label={TASK_STATUS_LABELS[status]}
              value={draft.theme.columns[status]}
              align={index >= 2 ? 'end' : 'start'}
              onChange={(hex) =>
                patch({
                  theme: {
                    ...draft.theme,
                    columns: { ...draft.theme.columns, [status]: hex }
                  }
                })
              }
            />
          ))}
        </div>
        <Hint>
          Column colours also tint agent states: In Progress is Working, In Review is Waiting on
          you, Done is Idle.
        </Hint>
      </div>

      <div className="flex flex-col gap-2.5">
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4">
          <span className="flex flex-col gap-0.5">
            <span className="text-[12.5px] text-ink">Gradient background</span>
            <Hint>Washes the base with a hint of the accent.</Hint>
          </span>
          <Switch
            label="Gradient background"
            checked={draft.theme.gradient}
            onChange={(gradient) => patch({ theme: { ...draft.theme, gradient } })}
          />
        </div>
        {draft.theme.gradient ? (
          <div className="flex flex-col gap-2 pl-0.5">
            <ThemeSlider
              label="Strength"
              value={Math.round(draft.theme.gradientStrength * 100)}
              min={0}
              max={100}
              readout={`${Math.round(draft.theme.gradientStrength * 100)}%`}
              onChange={(value) =>
                patch({ theme: { ...draft.theme, gradientStrength: value / 100 } })
              }
            />
            <ThemeSlider
              label="Angle"
              value={draft.theme.gradientAngle}
              min={0}
              max={359}
              readout={`${draft.theme.gradientAngle}°`}
              onChange={(gradientAngle) => patch({ theme: { ...draft.theme, gradientAngle } })}
            />
          </div>
        ) : null}
      </div>

      <div className="h-px bg-edge" />

      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_104px] gap-3">
        <Field label="Interface font">
          <Select
            compact
            value={draft.theme.uiFont}
            onChange={(event) => patch({ theme: { ...draft.theme, uiFont: event.target.value } })}
          >
            {UI_FONTS.map((font) => (
              <option key={font.id} value={font.id}>
                {font.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Terminal font">
          <Select
            compact
            value={draft.theme.terminalFont}
            onChange={(event) =>
              patch({ theme: { ...draft.theme, terminalFont: event.target.value } })
            }
          >
            {TERMINAL_FONTS.map((font) => (
              <option key={font.label} value={font.stack}>
                {font.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Size">
          <Stepper
            label="Terminal font size"
            className="h-[30px]"
            value={draft.theme.terminalFontSize}
            min={9}
            max={24}
            onChange={(terminalFontSize) => patch({ theme: { ...draft.theme, terminalFontSize } })}
          />
        </Field>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-[12px] font-semibold text-dim">Terminal colours</span>
        <div className="flex flex-wrap gap-1.5">
          {TERMINAL_PALETTES.map((preset) => {
            const on = samePalette(draft.theme.terminalPalette, preset.palette)
            return (
              <button
                key={preset.label}
                type="button"
                aria-pressed={on}
                onClick={() =>
                  patch({ theme: { ...draft.theme, terminalPalette: preset.palette } })
                }
                className={`inline-flex h-7 items-center gap-2 rounded-[7px] border px-2.5 text-[12px] transition-colors ${
                  on
                    ? 'border-accent bg-accent/15 text-ink'
                    : 'border-edge-strong text-dim hover:text-ink'
                }`}
              >
                <span className="flex overflow-hidden rounded-[3px]">
                  {PREVIEW_SLOTS.map((slot) => (
                    <span
                      key={slot}
                      style={{ backgroundColor: preset.palette[slot] }}
                      className="h-2.5 w-2"
                    />
                  ))}
                </span>
                {preset.label}
              </button>
            )
          })}
        </div>

        <div
          className="rounded-[10px] border border-edge-strong px-3.5 py-3 font-mono leading-[1.65]"
          style={{
            fontFamily: draft.theme.terminalFont,
            fontSize: draft.theme.terminalFontSize,
            backgroundColor: preview.background,
            color: preview.foreground
          }}
        >
          <span style={{ color: preview.green }}>❯</span> claude --resume TASK-0004
          <br />
          <span style={{ color: preview.brightBlack }}>---</span>{' '}
          <span style={{ color: preview.red }}>- const THEME = &#123;</span>
          <br />
          <span style={{ color: preview.brightBlack }}>+++</span>{' '}
          <span style={{ color: preview.green }}>+ terminalTheme(theme)</span>
          <br />
          <span style={{ color: preview.yellow }}>warning</span>{' '}
          <span style={{ color: preview.blue }}>src/core/shortcuts.ts</span>{' '}
          <span style={{ color: preview.magenta }}>12 passed</span>{' '}
          <span style={{ color: preview.cyan }}>0 failed</span>
          <br />
          <span style={{ backgroundColor: preview.cursor, color: preview.background }}> </span>
        </div>
        <Hint>
          Background, text and cursor follow the base. These are what git, agents and your prompt
          draw with.
        </Hint>

        <button
          type="button"
          aria-expanded={editingAnsi}
          onClick={() => setEditingAnsi((current) => !current)}
          className="self-start text-[11.5px] text-faint transition-colors hover:text-ink"
        >
          {editingAnsi ? 'Hide individual colours' : 'Edit individual colours'}
        </button>
        {editingAnsi ? (
          <Card className="gap-3 p-3">
            <div className="grid grid-cols-8 gap-1.5">
              {ANSI_COLOURS.map((slot) => (
                <button
                  key={slot}
                  type="button"
                  title={ansiLabel(slot)}
                  aria-label={ansiLabel(slot)}
                  aria-pressed={slot === ansiSlot}
                  onClick={() => setAnsiSlot(slot)}
                  style={{ backgroundColor: draft.theme.terminalPalette[slot] }}
                  className={`h-6 rounded-md border transition-colors ${
                    slot === ansiSlot
                      ? 'border-[var(--color-accent-text)]'
                      : 'border-edge-strong hover:border-faint'
                  }`}
                />
              ))}
            </div>
            <ColorInput
              label={ansiLabel(ansiSlot)}
              value={draft.theme.terminalPalette[ansiSlot]}
              onChange={(hex) =>
                patch({
                  theme: {
                    ...draft.theme,
                    terminalPalette: { ...draft.theme.terminalPalette, [ansiSlot]: hex }
                  }
                })
              }
            />
          </Card>
        ) : null}
      </div>
    </>
  )
}
