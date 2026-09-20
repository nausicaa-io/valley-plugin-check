import { afterEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { createMockValleyApi } from '@valley/plugin-testkit'
import { PLUGIN_SURFACE_V1, type PluginIndexPage } from '@valley/plugin-sdk'
import type { IndexEntry } from '@valley/plugin-sdk/types'
import * as checks from '../src/check'
import { acquireCheckProjection, CheckProjection } from '../src/projection'
import { register } from '../src/index'
import type { CheckConfig } from '../src/types'

const config: CheckConfig = {
  strictFilename: true, templateCheck: true, templatesFolder: 'Templates',
  excludedFolders: [], excludedPatterns: [], ignoredKeys: [], ignoredExtensions: []
}
const note = (relPath: string, frontmatter: Record<string, unknown> = { type: 'note' }): IndexEntry => ({
  relPath, frontmatter, kind: 'note', title: relPath, mtimeMs: 1
})
const template = note('Templates/Note.md')
const setup = (entries: IndexEntry[]) => createMockValleyApi({
  manifest: { id: 'check', indexState: 'scoped' }, indexEntries: entries, templateFolder: 'Templates',
  settings: { strictFilename: true, templateCheck: true }
})

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('incremental Check projection', () => {
  it('validates one changed note and only a changed template’s dependants among 2000 notes', () => {
    const validate = vi.spyOn(checks, 'checkNote')
    const model = new CheckProjection()
    let entries = [template, note('Templates/Task.md', { type: 'task', done: false }),
      ...Array.from({ length: 2000 }, (_, i) => note(`Notes/${i}.md`, i % 2 ? { type: 'task', done: false } : { type: 'note' }))]
    model.update(entries, config)
    expect(validate).toHaveBeenCalledTimes(2000)
    const initial = model.getSnapshot()
    validate.mockClear()
    model.update(entries, config)
    model.update(entries.map((entry) => ({ ...entry, mtimeMs: 2 })), { ...config })
    expect(model.getSnapshot()).toBe(initial)
    expect(validate).not.toHaveBeenCalled()

    entries = entries.map((entry) => entry.relPath === 'Notes/0.md' ? note(entry.relPath, { type: 'note', extra: true }) : entry)
    model.update(entries, config)
    expect(validate.mock.calls.map(([entry]) => entry.relPath)).toEqual(['Notes/0.md'])
    const retainedError = model.getSnapshot().result.deviations[0]
    validate.mockClear()
    entries = entries.map((entry) => entry.relPath === 'Templates/Task.md' ? note(entry.relPath, { type: 'task', done: false, due: '' }) : entry)
    model.update(entries, config)
    expect(validate).toHaveBeenCalledTimes(1000)
    expect(validate.mock.calls.every(([entry]) => entry.frontmatter?.type === 'task')).toBe(true)
    expect(model.getSnapshot().result.deviations[0]).toBe(retainedError)
    expect(model.getSnapshot().result).toEqual(checks.runChecks(entries, config))
  })

  it('updates duplicate buckets across add, rename, delete, exclusions and index order', () => {
    const model = new CheckProjection()
    let entries = [template, note('B/Fern.md'), note('A/fern.md'), note('C/Moss.md')]
    const verify = (nextConfig = config): void => {
      model.update(entries, nextConfig)
      expect(model.getSnapshot().result).toEqual(checks.runChecks(entries, nextConfig))
    }
    verify()
    expect(model.getSnapshot().result.conflicts[0]).toEqual({ name: 'Fern', paths: ['A/fern.md', 'B/Fern.md'] })
    entries = [entries[0], entries[2], entries[1], entries[3]]
    verify()
    expect(model.getSnapshot().result.conflicts[0].name).toBe('fern')
    entries = entries.map((entry) => entry.relPath === 'B/Fern.md' ? note('B/Moss.md') : entry)
    verify()
    expect(model.getSnapshot().result.conflicts[0].paths).toEqual(['B/Moss.md', 'C/Moss.md'])
    verify({ ...config, excludedFolders: ['B'] })
    expect(model.getSnapshot().result.conflicts).toEqual([])
    verify()
    entries = entries.filter((entry) => entry.relPath !== 'C/Moss.md')
    verify()
    expect(model.getSnapshot().result.conflicts).toEqual([])
    entries = [...entries, { relPath: 'Images/Moss.png', title: 'Moss', kind: 'asset', mtimeMs: 1 }]
    verify()
    verify({ ...config, ignoredExtensions: ['.png'] })
    expect(model.getSnapshot().result.conflicts).toEqual([])
  })

  it('does not rebuild unchanged filename or template indexes for a single asset rename', () => {
    const names = vi.spyOn(checks, 'baseName')
    const schemas = vi.spyOn(checks, 'templateSchema')
    const validate = vi.spyOn(checks, 'checkNote')
    const model = new CheckProjection()
    const entries: IndexEntry[] = [template, note('Notes/Fern.md'),
      ...Array.from({ length: 1000 }, (_, i) => ({ relPath: `Images/Image${i}.png`, title: 'Image', kind: 'asset' as const, mtimeMs: 1 }))]
    model.update(entries, config)
    names.mockClear(); schemas.mockClear(); validate.mockClear()
    model.update(entries.map((entry) => entry.relPath === 'Images/Image0.png' ? { ...entry, relPath: 'Images/Fern.png' } : entry), config)
    expect(names).toHaveBeenCalledTimes(2)
    expect(schemas).toHaveBeenCalledTimes(1)
    expect(validate).not.toHaveBeenCalled()
    expect(model.getSnapshot().result.conflicts).toEqual([{ name: 'Fern', paths: ['Images/Fern.png', 'Notes/Fern.md'] }])
  })

  it('preserves last-template precedence, fallback, unknown-type invalidation and key order', () => {
    const validate = vi.spyOn(checks, 'checkNote')
    const model = new CheckProjection()
    let entries = [template, note('Templates/Override.md', { type: 'note', title: '' }),
      note('Notes/A.md', { type: 'note', title: '' }), note('Notes/B.md', { type: 'unknown' })]
    const verify = (): void => {
      model.update(entries, config)
      expect(model.getSnapshot().result).toEqual(checks.runChecks(entries, config))
    }
    verify()
    validate.mockClear()
    entries = entries.map((entry) => entry === template ? note(template.relPath, { type: 'note', ignored: false }) : entry)
    verify()
    expect(validate).not.toHaveBeenCalled()
    entries = [entries[1], entries[0], ...entries.slice(2)]
    verify()
    expect(validate.mock.calls.map(([entry]) => entry.relPath)).toEqual(['Notes/A.md'])
    validate.mockClear()
    entries = entries.filter((entry) => entry.relPath !== template.relPath)
    verify()
    expect(validate).toHaveBeenCalledTimes(1)
    entries = [...entries, note('Templates/Unknown.md', { type: 'unknown' })]
    verify()
    expect(model.getSnapshot().result.deviations).toEqual([])
    entries = entries.map((entry) => entry.relPath === 'Templates/Override.md' ? note(entry.relPath, { title: '', type: 'note' }) : entry)
    verify()
    expect(model.getSnapshot().result.deviations).toMatchObject([{ filePath: 'Notes/A.md', kind: 'wrong_order' }])
    entries = entries.map((entry) => entry.relPath === 'Notes/A.md' ? note(entry.relPath, { type: 'unknown' }) : entry)
    verify()
    expect(model.getSnapshot().result.deviations).toEqual([])
  })

  it('matches full validation throughout mixed edits, source moves and settings changes', () => {
    const model = new CheckProjection()
    let entries = [template, note('Templates/Task.md', { type: 'task', done: false }),
      ...Array.from({ length: 80 }, (_, i) => note(`Folder${i % 4}/Name${i}.md`, { type: i % 2 ? 'task' : 'note', done: false }))]
    for (let turn = 0; turn < 90; turn++) {
      const index = 2 + turn % 80
      if (turn % 3 === 0) entries = entries.map((entry, i) => i === index ? { ...entry, frontmatter: { type: turn % 2 ? 'task' : 'missing', extra: turn } } : entry)
      else if (turn % 3 === 1) entries = entries.map((entry, i) => i === index ? { ...entry, relPath: `Moved${turn}/Name${turn % 20}.md` } : entry)
      else entries = [...entries].reverse()
      const epoch = Math.floor(turn / 15)
      const nextConfig = { ...config, strictFilename: epoch % 3 !== 0, templateCheck: epoch % 4 !== 0,
        templatesFolder: epoch === 2 ? 'Moved2' : 'Templates', excludedPatterns: epoch % 2 ? [] : ['Folder1'], ignoredKeys: epoch % 3 ? [] : ['done'] }
      model.update(entries, nextConfig)
      expect(model.getSnapshot().result).toEqual(checks.runChecks(entries, nextConfig))
    }
  })
})

describe('Check projection ownership', () => {
  it('keeps a status command pending until every scoped page is present', async () => {
    const entries = [template, ...Array.from({ length: 128 }, (_, i) => note(`Notes/${i}.md`)), note('Other/127.md')]
    const mock = setup(entries)
    const observe = mock.api.index.observe
    let release!: (page: PluginIndexPage) => void
    const gate = new Promise<PluginIndexPage>(resolve => { release = resolve })
    let captured: PluginIndexPage | undefined
    vi.spyOn(mock.api.index, 'observe').mockImplementation(async (scope, listener) => {
      const observation = await observe(scope, listener)
      return { ...observation, read: async request => {
        const page = await observation.read(request)
        if (request?.offset === 128) { captured = page; return gate }
        return page
      } }
    })
    const off = register(mock.api)
    try {
      let settled = false
      const status = mock.api.commands.execute('check:status').then(result => { settled = true; return result })
      await vi.waitFor(() => expect(captured).toBeDefined())
      expect(settled).toBe(false)
      expect(mock.api.getState().indexEntries).toEqual([])
      expect(mock.api.index.observe).toHaveBeenCalledWith({ fields: ['frontmatter', 'kind'] }, expect.any(Function))
      release(captured!)
      expect(await status).toMatchObject({ ok: true, value: { filenameConflicts: 1, templateDeviations: 0 } })
    } finally { release(captured!); await off() }
  })

  it('joins an accepted scoped read on disposal and rejects waiting diagnostic commands', async () => {
    const mock = setup([template, note('Notes/A.md')])
    const observe = mock.api.index.observe
    let release!: (page: PluginIndexPage) => void
    const gate = new Promise<PluginIndexPage>(resolve => { release = resolve })
    let captured: PluginIndexPage | undefined
    const close = vi.fn()
    vi.spyOn(mock.api.index, 'observe').mockImplementation(async (scope, listener) => {
      const observation = await observe(scope, listener)
      return { read: async request => { captured = await observation.read(request); return gate }, dispose: async () => { close(); await observation.dispose() } }
    })
    const owner = acquireCheckProjection(mock.api)
    const listener = vi.fn()
    owner.subscribe(listener)
    const ready = expect(owner.ready()).rejects.toThrow('disposed')
    await vi.waitFor(() => expect(captured).toBeDefined())
    let settled = false
    const closing = owner.dispose()
    void closing.then(() => { settled = true })
    expect(owner.dispose()).toBe(closing)
    await ready
    expect(settled).toBe(false)
    expect(close).toHaveBeenCalledOnce()
    release(captured!)
    await closing
    expect(listener).not.toHaveBeenCalled()
  })

  it('resynchronizes a missed scope revision and applies a new template folder without broad index state', async () => {
    const mock = setup([template, note('First/A.md')])
    const observe = mock.api.index.observe
    let skip = true
    vi.spyOn(mock.api.index, 'observe').mockImplementation((scope, listener) => observe(scope, change => {
      if (skip) { skip = false; return }
      listener(change)
    }))
    const owner = acquireCheckProjection(mock.api)
    try {
      await owner.ready()
      mock.emitState({ indexEntries: [template, note('First/A.md', { type: 'note', extra: true })] })
      mock.emitState({ indexEntries: [template, note('First/A.md', { type: 'note', extra: true }), note('Second/A.md')] })
      await vi.waitFor(() => expect(owner.getSnapshot().result.conflicts).toHaveLength(1))
      expect(owner.getSnapshot().result.deviations).toMatchObject([{ filePath: 'First/A.md', kind: 'extra_key' }])
      mock.emitState({ templateFolder: 'Missing' })
      expect(owner.getSnapshot().result.deviations).toHaveLength(3)
      expect(owner.getSnapshot().result.deviations.every(item => item.kind === 'unknown_type')).toBe(true)
      expect(mock.api.index.observe).toHaveBeenCalledOnce()
      expect(mock.api.getState().indexEntries).toEqual([])
    } finally { await owner.dispose() }
  })

  it('shares one subscription and result per API session and rejects callbacks after final release', async () => {
    const mock = setup([template, note('Notes/A.md')])
    const state = vi.spyOn(mock.api, 'subscribeState')
    const settings = vi.spyOn(mock.api.settings, 'subscribe')
    const validate = vi.spyOn(checks, 'checkNote')
    const first = acquireCheckProjection(mock.api)
    const second = acquireCheckProjection(mock.api)
    await first.ready()
    expect(state).toHaveBeenCalledTimes(1)
    expect(settings).toHaveBeenCalledTimes(1)
    expect(validate).toHaveBeenCalledTimes(1)
    expect(first.getSnapshot()).toBe(second.getSnapshot())
    const listener = vi.fn()
    second.subscribe(listener)
    await first.dispose(); await first.dispose()
    mock.emitState({ indexEntries: [template, note('Notes/A.md', { type: 'note', extra: true })] })
    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(1))
    const last = second.getSnapshot()
    await second.dispose()
    mock.emitState({ indexEntries: [] })
    state.mock.calls[0][1]({ revision: 99, state: mock.api.getState() })
    settings.mock.calls[0][0]()
    await Promise.resolve()
    expect(second.getSnapshot()).toBe(last)
    expect(listener).toHaveBeenCalledTimes(1)
    const replacement = acquireCheckProjection(mock.api)
    await replacement.ready()
    expect(replacement.getSnapshot().result).toEqual({ conflicts: [], deviations: [] })
    await replacement.dispose()
  })

  it('does no note validation or result publication for unrelated host/settings changes', async () => {
    const mock = setup([template, note('Notes/A.md')])
    const owner = acquireCheckProjection(mock.api)
    await owner.ready()
    const validate = vi.spyOn(checks, 'checkNote')
    const listener = vi.fn()
    owner.subscribe(listener)
    const before = owner.getSnapshot()
    mock.emitState({ activePath: 'Other.md', canGoBack: true })
    await mock.api.settings.set('unrelated', 'changed')
    mock.emitState({ indexEntries: [template, note('Notes/A.md')].map((entry) => ({ ...entry, mtimeMs: 2 })) })
    expect(owner.getSnapshot()).toBe(before)
    expect(validate).not.toHaveBeenCalled()
    expect(listener).not.toHaveBeenCalled()
    await mock.api.settings.set('ignoredKeys', 'extra')
    expect(validate).toHaveBeenCalledTimes(1)
    owner.dispose()
  })

  it('retires a rebound API without allowing its old disposer or callbacks to affect the replacement', async () => {
    const firstApi = setup([template, note('First/A.md')])
    const staleState = vi.spyOn(firstApi.api, 'subscribeState')
    const first = acquireCheckProjection(firstApi.api)
    const secondApi = setup([template, note('Second/B.md', { type: 'note', extra: true })])
    const rebound = { ...secondApi.api, runtime: firstApi.api.runtime }
    const second = acquireCheckProjection(rebound)
    await second.ready()
    const listener = vi.fn()
    second.subscribe(listener)
    const before = second.getSnapshot()
    await first.dispose()
    firstApi.emitState({ indexEntries: [] })
    staleState.mock.calls[0][1]({ revision: 99, state: firstApi.api.getState() })
    expect(second.getSnapshot()).toBe(before)
    secondApi.emitState({ indexEntries: [template, note('Second/B.md')] })
    await vi.waitFor(() => expect(second.getSnapshot().result.deviations).toEqual([]))
    expect(listener).toHaveBeenCalledTimes(1)
    await second.dispose()
  })

  it('shares actual validation across the mounted footer/popover, commands and surface restoration', async () => {
    const mock = setup([template, note('First/Fern.md', { type: 'note', extra: true }), note('Second/Fern.md')])
    const validate = vi.spyOn(checks, 'checkNote')
    const openPopover = vi.spyOn(mock.api.ui, 'openPopover')
    const off = register(mock.api)
    await mock.api.commands.execute('check:status')
    const views = vi.mocked(mock.api.registerView).mock.calls
    const Footer = views.find(([id]) => id === 'check.footer')![1] as React.ComponentType
    const footer = render(<Footer />)
    fireEvent.click(footer.container.querySelector('.check-badge')!)
    const Popover = openPopover.mock.calls[0][0] as React.ComponentType
    const popover = render(<Popover />)
    const surface = mock.api.interop.extensions.providers(PLUGIN_SURFACE_V1)[0].extension
    const reads = vi.spyOn(mock.api, 'getState')
    for (let i = 0; i < 20; i++) {
      expect(await mock.api.commands.execute('check:status')).toMatchObject({ ok: true, value: { filenameConflicts: 1, templateDeviations: 1 } })
      expect(await mock.api.commands.execute('check:results', { category: 'files' })).toMatchObject({ ok: true, value: { total: 2 } })
      await act(async () => { await surface.restore({ category: 'validation', path: 'First/Fern.md' }, undefined, { background: true }) })
    }
    expect(validate).toHaveBeenCalledTimes(2)
    expect(reads).not.toHaveBeenCalled()
    await act(async () => {
      mock.emitState({ indexEntries: [template, note('First/Fern.md'), note('Second/Fern.md')] })
      await vi.waitFor(() => expect(validate).toHaveBeenCalledTimes(3))
    })
    expect(validate).toHaveBeenCalledTimes(3)
    expect(popover.container.querySelectorAll('.check-popover-row')).toHaveLength(0)
    expect(await mock.api.commands.execute('check:status')).toMatchObject({ ok: true, value: { templateDeviations: 0 } })
    await expect(surface.restore({ category: 'validation', path: 'First/Fern.md' })).rejects.toThrow('no longer exists')
    footer.unmount(); popover.unmount(); await off()
  })

  it('updates translated diagnostics without rerunning validation', async () => {
    const mock = setup([template, note('Notes/Fern.md', { type: 'note', extra: true })])
    const language = vi.spyOn(mock.api.ui, 'onLanguageChanged')
    const off = register(mock.api)
    await mock.api.commands.execute('check:status')
    const Footer = vi.mocked(mock.api.registerView).mock.calls.find(([id]) => id === 'check.footer')![1] as React.ComponentType
    const view = render(<Footer />)
    const validate = vi.spyOn(checks, 'checkNote')
    mock.api.ui.t = () => 'Translated diagnostic'
    act(() => { for (const [callback] of language.mock.calls) callback() })
    expect(view.getByRole('button', { name: 'Translated diagnostic' })).toBeTruthy()
    expect(validate).not.toHaveBeenCalled()
    view.unmount(); await off()
  })
})

it('applies an accepted delta without iterating unchanged entries and preserves validation parity', () => {
  const model = new CheckProjection()
  const original = [template, ...Array.from({ length: 2000 }, (_, index) => note(`Notes/${index}.md`))]
  model.update(original, config)
  const changed = note('Notes/1000.md', { type: 'note', extra: true })
  const next = original.map(entry => entry.relPath === changed.relPath ? changed : entry)
  const guarded = new Proxy(next, { get(target, property, receiver) {
    if (property === Symbol.iterator || property === 'entries') throw new Error('Delta reconciliation scanned the full snapshot')
    return Reflect.get(target, property, receiver)
  } })
  const validate = vi.spyOn(checks, 'checkNote')
  model.update(guarded, config, { previousRevision: 1, changed: [changed], deleted: [] })
  expect(validate).toHaveBeenCalledOnce()
  expect(model.getSnapshot().result).toEqual(checks.runChecks(next, config))
  const afterDelete = next.filter(entry => entry.relPath !== changed.relPath)
  model.update(afterDelete, config, { previousRevision: 2, changed: [], deleted: [changed.relPath] })
  expect(model.getSnapshot().result).toEqual(checks.runChecks(afterDelete, config))
})

it('does not construct hidden result rows in the footer and bounds an open result list', async () => {
  const mock = setup([template, ...Array.from({ length: 2000 }, (_, index) => note(`Notes/${index}.md`, { type: 'note', extra: true }))])
  mock.api.React = { ...React }
  const create = vi.spyOn(mock.api.React, 'createElement')
  const openPopover = vi.spyOn(mock.api.ui, 'openPopover')
  const off = register(mock.api)
  await mock.api.commands.execute('check:status')
  const Footer = vi.mocked(mock.api.registerView).mock.calls.find(([id]) => id === 'check.footer')![1] as React.ComponentType
  create.mockClear()
  const footer = render(<Footer />)
  expect(create.mock.calls.some(([, props]) => String((props as { className?: string } | null)?.className).includes('check-popover-row'))).toBe(false)
  fireEvent.click(footer.container.querySelector('.check-badge')!)
  const Popover = openPopover.mock.calls[0][0] as React.ComponentType
  const popover = render(<Popover />)
  await waitFor(() => expect(popover.container.querySelectorAll('.check-popover-row').length).toBeGreaterThan(0))
  expect(popover.container.querySelectorAll('.check-popover-row').length).toBeLessThan(40)
  const first = popover.container.querySelector('button.check-popover-row')!
  fireEvent.keyDown(first, { key: 'End' })
  await waitFor(() => expect(document.activeElement).toHaveAttribute('title', 'Notes/1999.md'))
  fireEvent.click(document.activeElement!)
  expect(mock.api.workspace.openFile).toHaveBeenCalledWith('Notes/1999.md', undefined, { newTab: false })
  footer.unmount(); popover.unmount(); await off()
})
