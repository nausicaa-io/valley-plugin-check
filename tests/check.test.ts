import { describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import { fireEvent, render } from '@testing-library/react'
import type { ComponentType } from 'react'
import type { IndexEntry } from '@valley/plugin-sdk/types'
import { createMockValleyApi } from '@valley/plugin-testkit'
import { register } from '../src/index'
import { buildRegistry, isExcluded, parseExtList, parseList, runChecks } from '../src/check'
import { initLocalization, uiText } from '../src/localization'
import type { CheckConfig } from '../src/types'
import { PLUGIN_SURFACE_V1 } from '@valley/plugin-sdk'

function note(relPath: string, frontmatter?: Record<string, unknown>): IndexEntry {
  return { relPath, title: relPath.split('/').pop() ?? relPath, kind: 'note', frontmatter, mtimeMs: 0 }
}

function asset(relPath: string): IndexEntry {
  return { relPath, title: relPath.split('/').pop() ?? relPath, kind: 'asset', mtimeMs: 0 }
}

const baseConfig: CheckConfig = {
  strictFilename: true,
  templateCheck: true,
  templatesFolder: 'templates',
  excludedFolders: [],
  excludedPatterns: [],
  ignoredKeys: [],
  ignoredExtensions: []
}

const TEMPLATE = note('templates/NOTE.md', {
  type: 'note',
  title: 'placeholder',
  tags: ['x'],
  created: '2024-01-01'
})

describe('parseList', () => {
  it('splits on commas, spaces and newlines and dedupes', () => {
    expect(parseList('a, b  c\nd,a')).toEqual(['a', 'b', 'c', 'd'])
    expect(parseList(undefined)).toEqual([])
  })
})

describe('Check automation and bookmarks', () => {
  it('paginates filtered diagnostics and rejects a resolved bookmark', async () => {
    const { api } = createMockValleyApi({ manifest: { id: 'check' }, settings: { strictFilename: true }, indexEntries: [note('Forest/Oak.md'), note('Wetland/Oak.md')] })
    const off = register(api)
    try {
      expect(await api.commands.execute('check:results', { category: 'files', limit: 1 })).toMatchObject({ ok: true, value: { total: 2, nextOffset: 1, rows: [{ path: 'Forest/Oak.md' }] } })
      const surface = api.interop.extensions.providers(PLUGIN_SURFACE_V1)[0].extension
      await expect(surface.restore({ category: 'files', path: 'Removed.md' })).rejects.toThrow('no longer exists')
    } finally { off() }
  })

  it('restores an earlier setting if a later field cannot be saved', async () => {
    const { api } = createMockValleyApi({ manifest: { id: 'check' }, settings: { strictFilename: false, excludedFolders: '' } })
    const off = register(api)
    const set = api.settings.set.bind(api.settings)
    api.settings.set = vi.fn((key, value) => key === 'excludedFolders' ? Promise.resolve({ ok: false, error: 'Disk full' }) : set(key, value))
    try {
      expect(await api.commands.execute('check:settings-update', { values: { strictFilename: true, excludedFolders: 'Archive' } })).toMatchObject({ ok: false, error: { message: expect.stringContaining('Could not save') } })
      expect(api.settings.get()).toMatchObject({ strictFilename: false, excludedFolders: '' })
      expect(await api.commands.execute('check:settings-update', { values: { repair: true } })).toMatchObject({ ok: false, error: { kind: 'invalid-input' } })
    } finally { off() }
  })
})

describe('isExcluded', () => {
  it('matches folder prefixes and substring patterns', () => {
    expect(isExcluded('archive/x.md', ['archive'], [])).toBe(true)
    expect(isExcluded('archives/x.md', ['archive'], [])).toBe(false)
    expect(isExcluded('notes/Untitled 1.md', [], ['Untitled'])).toBe(true)
    expect(isExcluded('notes/keep.md', ['archive'], ['Untitled'])).toBe(false)
  })
})

describe('strict filename', () => {
  it('flags duplicate base names ignoring extension', () => {
    const { conflicts } = runChecks([note('a/foo.md'), note('b/foo.md'), asset('c/foo.png')], {
      ...baseConfig,
      templateCheck: false
    })
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].name).toBe('foo')
    expect(conflicts[0].paths).toEqual(['a/foo.md', 'b/foo.md', 'c/foo.png'])
  })

  it('does not flag unique names, and honours excludes', () => {
    expect(runChecks([note('a/foo.md'), note('b/bar.md')], { ...baseConfig, templateCheck: false }).conflicts).toEqual(
      []
    )
    const excluded = runChecks([note('a/foo.md'), note('archive/foo.md')], {
      ...baseConfig,
      templateCheck: false,
      excludedFolders: ['archive']
    })
    expect(excluded.conflicts).toEqual([])
  })

  it('is off when strictFilename is false', () => {
    expect(runChecks([note('a/foo.md'), note('b/foo.md')], { ...baseConfig, strictFilename: false }).conflicts).toEqual(
      []
    )
  })

  it('always ignores .json/.jsonl and honours custom ignored extensions', () => {
    // foo.md vs foo.json/foo.jsonl → the data files are skipped, so no conflict.
    expect(
      runChecks([note('a/foo.md'), asset('b/foo.json'), asset('c/foo.jsonl')], {
        ...baseConfig,
        templateCheck: false
      }).conflicts
    ).toEqual([])
    // A user-added extension is skipped too.
    expect(
      runChecks([note('a/bar.md'), asset('b/bar.png')], {
        ...baseConfig,
        templateCheck: false,
        ignoredExtensions: ['.png']
      }).conflicts
    ).toEqual([])
  })
})

describe('parseExtList', () => {
  it('lowercases, dot-prefixes and dedupes', () => {
    expect(parseExtList('json, .JSONL  png')).toEqual(['.json', '.jsonl', '.png'])
    expect(parseExtList(undefined)).toEqual([])
  })
})

describe('buildRegistry', () => {
  it('keys schemas by the template type, preserving key order', () => {
    const reg = buildRegistry([TEMPLATE, note('notes/x.md', { type: 'note' })], 'templates')
    expect([...reg.keys()]).toEqual(['note'])
    expect(reg.get('note')?.keyOrder).toEqual(['type', 'title', 'tags', 'created'])
  })
})

describe('strict template check', () => {
  const run = (entry: IndexEntry): ReturnType<typeof runChecks> => runChecks([TEMPLATE, entry], baseConfig)

  it('passes a conformant note', () => {
    expect(run(note('notes/ok.md', { type: 'note', title: 'Hi', tags: ['a'], created: '2024' })).deviations).toEqual([])
  })

  it('reports no_frontmatter / no_type_field / unknown_type', () => {
    expect(run(note('notes/none.md')).deviations[0].kind).toBe('no_frontmatter')
    expect(run(note('notes/empty.md', {})).deviations[0].kind).toBe('no_frontmatter')
    expect(run(note('notes/notype.md', { title: 'x' })).deviations[0].kind).toBe('no_type_field')
    const unknown = run(note('notes/u.md', { type: 'widget' })).deviations
    expect(unknown[0].kind).toBe('unknown_type')
    expect(unknown[0].detail).toBe('widget')
  })

  it('reports missing and extra keys', () => {
    const kinds = run(note('notes/m.md', { type: 'note', title: 'x', extra: 1 })).deviations.map((d) => d.kind)
    expect(kinds).toContain('missing_key')
    expect(kinds).toContain('extra_key')
  })

  it('reports wrong key order', () => {
    const d = run(note('notes/o.md', { type: 'note', tags: [], title: 'x', created: '' })).deviations
    expect(d.some((x) => x.kind === 'wrong_order')).toBe(true)
  })

  it('reports wrong value type but tolerates lenient pairs', () => {
    // boolean where a string is expected → mismatch
    const bad = run(note('notes/t.md', { type: 'note', title: true, tags: [], created: '' })).deviations
    expect(bad.some((x) => x.kind === 'wrong_type')).toBe(true)
    // number where a string is expected → tolerated
    const ok = run(note('notes/t2.md', { type: 'note', title: 42, tags: [], created: '' })).deviations
    expect(ok.some((x) => x.kind === 'wrong_type')).toBe(false)
  })

  it('honours ignoredKeys', () => {
    const cfg = { ...baseConfig, ignoredKeys: ['extra', 'created'] }
    const d = runChecks([TEMPLATE, note('notes/i.md', { type: 'note', title: 'x', tags: [], extra: 1 })], cfg).deviations
    // `extra` ignored (no extra_key); `created` ignored (no missing_key)
    expect(d).toEqual([])
  })

  it('does not check template files themselves', () => {
    expect(runChecks([TEMPLATE], baseConfig).deviations).toEqual([])
  })
})

describe('register', () => {
  it('registers footer and Settings views and owns its style lifecycle', () => {
    const { api } = createMockValleyApi({ manifest: { id: 'check' } })
    const dispose = register(api)
    const keys = (api.registerView as unknown as { mock: { calls: [string][] } }).mock.calls.map((c) => c[0])
    expect(keys).toEqual(['check.footer', 'check.settings'])
    expect(document.querySelectorAll('#check-plugin-styles')).toHaveLength(1)
    dispose()
    expect(document.querySelectorAll('#check-plugin-styles')).toHaveLength(0)
    register(api)
    expect(document.querySelectorAll('#check-plugin-styles')).toHaveLength(1)
  })

  it('uses the core template folder read-only and links to Import Template', () => {
    const { api } = createMockValleyApi({
      manifest: { id: 'check' },
      templateFolder: 'Core/Templates',
      settings: { templatesFolder: 'stale/plugin/copy' }
    })
    const dispose = register(api)
    const calls = (api.registerView as unknown as {
      mock: { calls: [string, ComponentType][] }
    }).mock.calls
    const SettingsView = calls.find(([key]) => key === 'check.settings')?.[1]
    expect(SettingsView).toBeDefined()
    const view = render(React.createElement(SettingsView!))
    expect(view.getByText('Core/Templates')).toBeTruthy()
    expect(view.queryByText('stale/plugin/copy')).toBeNull()
    fireEvent.click(view.getByRole('button', { name: 'Template folder location' }))
    expect(api.workspace.openSettings).toHaveBeenCalledWith('import-template')
    dispose()
  })
})

describe('localization', () => {
  it('uses plugin translations first and preserves the canonical key fallback', () => {
    const { api } = createMockValleyApi({ manifest: { id: 'check' } })
    api.ui.t = (key) => key === 'auto.768f9220e68b' ? '仓库检查正常。' : key
    initLocalization(api)

    expect(uiText('auto.768f9220e68b')).toBe('仓库检查正常。')
    expect(uiText('check.missing')).toBe('check.missing')
  })
})
