import { z } from 'zod'
import {
  ANSI_COLOURS,
  DEFAULT_SHORTCUTS,
  DEFAULT_TERMINAL_PALETTE,
  SHORTCUT_COMMANDS,
  TASK_PRIORITIES,
  TASK_READINESS,
  TASK_STATUSES
} from './types.js'

export const taskStatusSchema = z.enum(TASK_STATUSES)
export const taskPrioritySchema = z.enum(TASK_PRIORITIES)
export const taskReadinessSchema = z.enum(TASK_READINESS)

export const externalRefSchema = z.object({
  provider: z.string(),
  id: z.string(),
  url: z.string().optional()
})

export const taskSessionRefSchema = z.object({
  id: z.string(),
  provider: z.enum(['claude', 'codex']).default('claude'),
  startedAt: z.string(),
  label: z.string()
})

export const activityEntrySchema = z.object({
  at: z.string(),
  author: z.string(),
  message: z.string()
})

export const taskFrontmatterSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: taskStatusSchema.default('backlog'),
  priority: taskPrioritySchema.default('medium'),
  readiness: taskReadinessSchema.default('ready'),
  project: z.string().optional(),
  tags: z.array(z.string()).default([]),
  repoPath: z.string().optional(),
  orchestrate: z.boolean().default(true),
  useWorktree: z.boolean().default(false),
  worktreePath: z.string().optional(),
  contextFiles: z.array(z.string()).default([]),
  promptTemplateId: z.string().optional(),
  provider: z.enum(['claude', 'codex']).optional(),
  agentSession: z.object({ provider: z.enum(['claude', 'codex']), id: z.string() }).optional(),
  sessions: z.array(taskSessionRefSchema).default([]),
  externalRef: externalRefSchema.optional(),
  order: z.number().default(0),
  createdAt: z.string(),
  updatedAt: z.string()
})

export const jsonTaskSchema = taskFrontmatterSchema.extend({
  description: z.string().default(''),
  activity: z.array(activityEntrySchema).default([])
})

export const taskDraftSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  status: taskStatusSchema.optional(),
  priority: taskPrioritySchema.optional(),
  readiness: taskReadinessSchema.optional(),
  project: z.string().optional(),
  tags: z.array(z.string()).optional(),
  repoPath: z.string().optional(),
  orchestrate: z.boolean().optional(),
  useWorktree: z.boolean().optional(),
  worktreePath: z.string().optional(),
  contextFiles: z.array(z.string()).optional(),
  promptTemplateId: z.string().optional(),
  provider: z.enum(['claude', 'codex']).optional(),
  sessions: z.array(taskSessionRefSchema).optional(),
  externalRef: externalRefSchema.optional(),
  order: z.number().optional()
})

export const taskPatchSchema = taskDraftSchema.partial()

export const taskFilterSchema = z.object({
  status: z.union([taskStatusSchema, z.array(taskStatusSchema)]).optional(),
  readiness: taskReadinessSchema.optional(),
  project: z.string().optional(),
  tag: z.string().optional(),
  query: z.string().optional()
})

export const promptTemplateSchema = z.object({
  id: z.string(),
  name: z.string(),
  template: z.string()
})

export const promptRoutingSchema = z.object({
  needsSpec: z.string(),
  byStatus: z.record(taskStatusSchema, z.string())
})

export const orchestrationSchema = z.object({
  spec: z.number().int().min(0).max(20),
  implement: z.number().int().min(0).max(20),
  review: z.number().int().min(0).max(20)
})

export const providerRoutingSchema = z.object({
  spec: z.enum(['claude', 'codex']).default('claude'),
  implement: z.enum(['claude', 'codex']).default('claude'),
  review: z.enum(['claude', 'codex']).default('claude')
})

const hexColour = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a 6-digit hex colour')

export const themeSchema = z.object({
  base: hexColour,
  gradient: z.boolean(),
  gradientStrength: z.number().min(0).max(1),
  gradientAngle: z.number().int().min(0).max(359),
  accent: hexColour,
  columns: z.record(taskStatusSchema, hexColour),
  uiFont: z.string().min(1),
  terminalFont: z.string().min(1),
  terminalFontSize: z.number().int().min(9).max(24),
  terminalPalette: z
    .partialRecord(z.enum(ANSI_COLOURS), hexColour)
    .default({})
    .transform((value) => ({ ...DEFAULT_TERMINAL_PALETTE, ...value }))
})

export const shortcutsSchema = z
  .partialRecord(z.enum(SHORTCUT_COMMANDS), z.array(z.string()))
  .default({})
  .transform((value) => ({ ...DEFAULT_SHORTCUTS, ...value }))

export const settingsSchema = z.object({
  workspaceDir: z.string(),
  defaultRepoPath: z.string().default(''),
  shell: z.string().default(''),
  claudeCommand: z.string().default('claude'),
  codexCommand: z.string().default('codex'),
  codexApprovalReviewer: z.enum(['user', 'auto_review']).default('user'),
  enabledProviders: z
    .array(z.enum(['claude', 'codex']))
    .min(1)
    .default(['claude']),
  defaultProvider: z.enum(['claude', 'codex']).default('claude'),
  providerRouting: providerRoutingSchema.default({
    spec: 'claude',
    implement: 'claude',
    review: 'claude'
  }),
  defaultPromptTemplateId: z.string().default('default'),
  promptTemplates: z.array(promptTemplateSchema).default([]),
  promptRouting: promptRoutingSchema,
  orchestration: orchestrationSchema,
  theme: themeSchema,
  shortcuts: shortcutsSchema,
  updates: z
    .object({ checkAutomatically: z.boolean().default(true) })
    .default({ checkAutomatically: true })
})
