import { describe, expect, it } from 'vitest'
import type { PromptTemplate, Settings } from '@core/types.js'
import {
  addTemplate,
  describeUpdate,
  insertToken,
  removeTemplate,
  routedTo,
  slugId,
  withProvider
} from './draft.js'

const template = (id: string): PromptTemplate => ({ id, name: id, template: '' })

describe('withProvider', () => {
  it('turns a provider on without duplicating it', () => {
    expect(
      withProvider({ enabledProviders: ['claude'], defaultProvider: 'claude' }, 'codex', true)
    ).toEqual({ enabledProviders: ['claude', 'codex'], defaultProvider: 'claude' })
    expect(
      withProvider({ enabledProviders: ['claude'], defaultProvider: 'claude' }, 'claude', true)
    ).toEqual({ enabledProviders: ['claude'], defaultProvider: 'claude' })
  })

  it('moves the default off a provider being turned off', () => {
    expect(
      withProvider(
        { enabledProviders: ['claude', 'codex'], defaultProvider: 'codex' },
        'codex',
        false
      )
    ).toEqual({ enabledProviders: ['claude'], defaultProvider: 'claude' })
  })

  it('never turns the last provider off', () => {
    expect(
      withProvider({ enabledProviders: ['codex'], defaultProvider: 'codex' }, 'codex', false)
    ).toBeNull()
  })
})

describe('templates', () => {
  it('slugs a name into an id, falling back when nothing is left', () => {
    expect(slugId('  My Template #2 ')).toBe('my-template-2')
    expect(slugId('!!!')).toBe('template')
  })

  it('adds a numbered starter template', () => {
    const { promptTemplates, id } = addTemplate([template('default')])
    expect(id).toBe('template-2')
    expect(promptTemplates.at(-1)).toMatchObject({ id, name: 'New template' })
  })

  it('removes a template and moves the fallback off it', () => {
    const draft = {
      promptTemplates: [template('a'), template('b')],
      defaultPromptTemplateId: 'a'
    }
    expect(removeTemplate(draft, 'a')).toEqual({
      promptTemplates: [template('b')],
      defaultPromptTemplateId: 'b'
    })
    expect(removeTemplate(draft, 'b')?.defaultPromptTemplateId).toBe('a')
  })

  it('keeps the last template', () => {
    expect(
      removeTemplate({ promptTemplates: [template('a')], defaultPromptTemplateId: 'a' }, 'a')
    ).toBeNull()
  })

  it('lists where a template is routed', () => {
    const settings = {
      promptRouting: {
        needsSpec: 'spec',
        byStatus: { backlog: 'impl', in_progress: 'impl', in_review: 'review', done: 'impl' }
      }
    } as Pick<Settings, 'promptRouting'>
    expect(routedTo(settings, 'spec')).toBe('Needs spec')
    expect(routedTo(settings, 'impl')).toBe('Backlog, In Progress, Done')
    expect(routedTo(settings, 'other')).toBe('Not routed')
  })

  it('inserts a placeholder over the selection and puts the caret after it', () => {
    expect(insertToken('Fix  now', 4, 4, '{{id}}')).toEqual({ text: 'Fix {{id}} now', caret: 10 })
    expect(insertToken('Fix THIS now', 4, 8, '{{id}}')).toEqual({
      text: 'Fix {{id}} now',
      caret: 10
    })
  })
})

describe('describeUpdate', () => {
  it('describes each update state', () => {
    expect(describeUpdate(null)).toBe('Not checked yet.')
    expect(describeUpdate({ kind: 'downloading', version: '1.2.0', percent: 40 })).toBe(
      'Downloading 1.2.0… 40%'
    )
    expect(describeUpdate({ kind: 'error', message: 'offline' })).toMatch(/offline$/)
  })
})
