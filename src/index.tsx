/**
 * Check — a footer-only plugin that validates the vault and surfaces
 * **two independent** warning chips, each shown only when its check is enabled
 * and something is wrong:
 *   - Strict filename (configured on Check's Settings page): every file name must be
 *     unique across the vault.
 *   - Strict template check (configured in Settings → Import Template): every
 *     note must match the template for its `type`.
 *
 * It runs entirely in the renderer off `api.getState().indexEntries` (parsed,
 * order-preserving frontmatter) and re-evaluates on vault and settings changes.
 * Like the Clock plugin it uses `api.React` and never imports `react`.
 */
import { PLUGIN_SURFACE_V1, type ValleyPluginApi, type ValleyPluginModule } from '@valley/plugin-sdk'
import type { CheckConfig, DeviationKind } from './types'
import { parseExtList, parseList, runChecks } from './check'
import { initLocalization } from './localization'
import { uiText } from './localization'

function readConfig(api: ValleyPluginApi): CheckConfig {
  const s = api.settings.get()
  return {
    strictFilename: s.strictFilename === true,
    templateCheck: s.templateCheck === true,
    templatesFolder: api.getState().templateFolder,
    excludedFolders: parseList(s.excludedFolders),
    excludedPatterns: parseList(s.excludedPatterns),
    ignoredKeys: parseList(s.ignoredKeys),
    ignoredExtensions: parseExtList(s.ignoredExtensions)
  }
}

const CATEGORY_LABELS: { kind: DeviationKind; labelKey: string }[] = [
  { kind: 'no_frontmatter', labelKey: 'auto.04571e759593' },
  { kind: 'no_type_field', labelKey: 'auto.08353eb6fdd4' },
  { kind: 'unknown_type', labelKey: 'auto.e6cb55c694b8' },
  { kind: 'missing_key', labelKey: 'auto.0788afd1d0e7' },
  { kind: 'extra_key', labelKey: 'auto.0e37a97118a4' },
  { kind: 'wrong_order', labelKey: 'auto.c7580f8e3d7c' },
  { kind: 'wrong_type', labelKey: 'auto.43b6abbe96be' }
]

export function register(api: ValleyPluginApi): () => void {
  initLocalization(api)
  const React = api.React
  const h = React.createElement
  let view = { category: 'files' as 'files' | 'validation', path: '' }
  const listeners = new Set<() => void>()
  const subscribe = (listener: () => void): (() => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
  const setView = (next: typeof view): void => { view = next; for (const listener of listeners) listener() }
  let settingsError = ''
  const settingDrafts: Record<string, unknown> = {}
  let savingSettings = Promise.resolve()
  const changeSettings = async (values: Record<string, unknown>): Promise<void> => {
    const previous = Object.fromEntries(Object.keys(values).map((key) => [key, api.settings.get()[key]]))
    const completed: string[] = []
    try {
      for (const [key, value] of Object.entries(values)) {
        if (!(await api.settings.set(key, value)).ok) throw new Error(`Could not save ${key}`)
        completed.push(key)
      }
    } catch (error) {
      let restored = true
      for (const key of completed.reverse()) {
        if (api.settings.get()[key] !== values[key] || !(await api.settings.set(key, previous[key])).ok) restored = false
      }
      if (!restored) throw new Error('Some Check settings were saved and could not be restored. Refresh settings before trying again.')
      throw error
    }
  }
  const saveSetting = (key: string, value: unknown): void => {
    settingDrafts[key] = value
    for (const listener of listeners) listener()
    savingSettings = savingSettings.then(() => changeSettings({ [key]: value })).then(() => {
      if (settingDrafts[key] === value) delete settingDrafts[key]
      settingsError = Object.keys(settingDrafts).length ? settingsError : ''
    }).catch(() => { settingsError = uiText('check.properties.saveError') }).finally(() => { for (const listener of listeners) listener() })
  }
  let anchor: HTMLElement | null = null
  const openResults = (): void => {
    void api.ui.openPopover(() => h<{ popover?: boolean }>(Check, { popover: true }), anchor ? { anchor } : { x: window.innerWidth - 360, y: window.innerHeight - 32 }, { className: 'check-results-popover', ariaLabel: 'Check' })
  }

  const useCheckRefresh = (): void => {
    const [, force] = React.useReducer((n: number) => n + 1, 0)
    React.useEffect(() => {
      const offState = api.subscribe(() => force())
      const onSettings = (): void => force()
      const offSettings = api.settings.subscribe(onSettings)
      const offLocal = subscribe(force)
      return () => {
        offState()
        offSettings()
        offLocal()
      }
    }, [])
  }

  const WarnChip = (props: { count: number; summary: string; category: 'files' | 'validation'; quiet?: boolean }): ReturnType<typeof h> | null => {
    if (!props.quiet && props.count === 0) return null
    return h('button', {
      className: `status-item check-badge${props.quiet ? ' check-badge-quiet' : ''}`,
      title: props.summary, 'aria-label': props.summary,
      ref: (element: HTMLButtonElement | null) => { if (element) anchor = element },
      onClick: () => { setView({ category: props.category, path: '' }); openResults() }
    }, h('svg', { width: '1em', height: '1em', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, 'aria-hidden': true }, h('path', { d: props.quiet ? 'm5 12 4 4L19 6' : 'M12 3 2 21h20L12 3zm0 6v5m0 3v1' })), props.quiet ? 'Check' : String(props.count))
  }

  const Check = ({ popover = false }: { popover?: boolean } = {}): ReturnType<typeof h> | null => {
    useCheckRefresh()
    const selected = React.useSyncExternalStore(subscribe, () => view)

    const config = readConfig(api)
    const entries = api.getState().indexEntries
    // runChecks is expensive over the index, so re-run only when entries or the
    // config VALUE changes. readConfig returns a fresh object each render, so key
    // on its serialization rather than its (always-new) identity.
    const configKey = JSON.stringify(config)
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const result = React.useMemo(() => runChecks(entries, config), [entries, configKey])

    const jump = (relPath: string, e?: { metaKey: boolean; ctrlKey: boolean }): void =>
      api.workspace.openFile(relPath, undefined, { newTab: e ? api.ui.hasModKey(e) : false })

    // Chip 1 — duplicate file names.
    const fileRows: ReturnType<typeof h>[] = []
    for (const conflict of result.conflicts) {
      for (const path of conflict.paths) {
        fileRows.push(
          h(
            'button',
            { key: `dup-${path}`, className: `check-popover-row${selected.path === path ? ' selected' : ''}`, onFocus: () => setView({ category: 'files', path }), onClick: (e: React.MouseEvent) => { setView({ category: 'files', path }); jump(path, e) }, title: path },
            h('span', { className: 'check-popover-path' }, path),
            h('span', { className: 'check-popover-detail' }, conflict.name)
          )
        )
      }
    }
    const fileCount = result.conflicts.length

    // Chip 2 — notes that deviate from their template, grouped by category.
    const tplRows: ReturnType<typeof h>[] = []
    for (const cat of CATEGORY_LABELS) {
      const items = result.deviations.filter((d) => d.kind === cat.kind)
      if (items.length === 0) continue
      tplRows.push(h('div', { key: `h-${cat.kind}`, className: 'check-popover-group' }, `${uiText(cat.labelKey)} (${items.length})`))
      for (let i = 0; i < items.length; i++) {
        const item = items[i]
        tplRows.push(
          h(
            'button',
            {
              key: `${cat.kind}-${i}-${item.filePath}`,
              className: `check-popover-row${selected.path === item.filePath ? ' selected' : ''}`,
              onFocus: () => setView({ category: 'validation', path: item.filePath }),
              onClick: (e: React.MouseEvent) => { setView({ category: 'validation', path: item.filePath }); jump(item.filePath, e) },
              title: item.filePath
            },
            h('span', { className: 'check-popover-path' }, item.filePath),
            item.detail ? h('span', { className: 'check-popover-detail' }, item.detail) : null
          )
        )
      }
    }
    const tplCount = result.deviations.length
    if (popover) return h('div', { className: 'check-results' },
      h(api.ui.SurfaceHeader, { surface: 'footer' }),
      h('div', { className: 'check-popover-list' }, ...(selected.category === 'files' ? fileRows : tplRows)),
      !(selected.category === 'files' ? fileRows : tplRows).length ? h('p', null, uiText('auto.768f9220e68b')) : null
    )

    return h(
      React.Fragment,
      null,
      h(WarnChip, {
        key: 'check-files',
        count: fileCount,
        summary: uiText('auto.9456190df480', { p0: fileCount, p1: fileCount === 1 ? '' : 's' }),
        category: 'files', quiet: fileCount === 0 && tplCount === 0
      }),
      h(WarnChip, {
        key: 'check-template',
        count: tplCount,
        summary: uiText('auto.8497c0f895ff', { p0: tplCount, p1: tplCount === 1 ? '' : 's' }),
        category: 'validation'
      })
    )
  }

  const CheckSettings = (): ReturnType<typeof h> => {
    useCheckRefresh()
    const kit = api.ui.settings
    const settings = api.settings.get()
    const set = (key: string, value: unknown): void => {
      saveSetting(key, value)
    }
    // Defaults arrive merged from `config.json`; the pane restates none of them.
    const list = (key: string): string[] =>
      parseList(typeof settings[key] === 'string' ? settings[key] : '')
    const templateFolder = api.getState().templateFolder

    return h(
      kit.Section,
      null,
      settingsError ? h('p', { role: 'alert' }, settingsError) : null,
      renderPropertyField('strictFilename'),
      renderPropertyField('ignoredExtensions'),
      h(
        kit.Row,
        {
          title: uiText('auto.572f2ac4595f'),
          description: uiText('auto.3f9755e92b12')
        },
        h(kit.Toggle, {
          checked: settings.templateCheck === true,
          onChange: (value: boolean) => set('templateCheck', value),
          label: uiText('auto.572f2ac4595f')
        })
      ),
      h(
        kit.Row,
        {
          title: uiText('auto.5387a0df285c'),
          description: uiText('auto.e0a836ec9bdd')
        },
        h(
          'div',
          { className: 'settings-row-control' },
          h(kit.ReadOnlyValue, {
            value: templateFolder,
            ariaLabel: uiText('auto.5387a0df285c'),
            monospace: true
          }),
          h(
            kit.Button,
            { variant: 'secondary', onClick: () => api.workspace.openSettings('import-template') },
            uiText('auto.c69679958c57')
          )
        )
      ),
      renderPropertyField('excludedFolders'),
      renderPropertyField('excludedPatterns'),
      h(
        kit.Row,
        { title: uiText('auto.d1767c91c535'), description: uiText('auto.a0432d9e1d11') },
        h(kit.ChipsField, {
          items: list('ignoredKeys'),
          onChange: (items: string[]) => set('ignoredKeys', items.join(', ')),
          ariaLabel: uiText('auto.d1767c91c535')
        })
      )
    )
  }

  const disposeStyles = injectStyles()
  api.registerView('check.footer', Check)
  api.registerView('check.settings', CheckSettings)

  // `check status` — the footer chips' numbers, queryable from CLI/agent.
  const offStatus = api.commands.register({
    id: 'status',
    label: 'Check: Show status', labelKey: 'auto.122d3c2cf197',
    paletteSafe: true,
    sideEffect: 'read',
    usage: 'check status',
    run: () => {
      const result = runChecks(api.getState().indexEntries, readConfig(api))
      const byKind: Record<string, number> = {}
      for (const d of result.deviations) byKind[d.kind] = (byKind[d.kind] ?? 0) + 1
      return {
        filenameConflicts: result.conflicts.length,
        templateDeviations: result.deviations.length,
        byKind,
        sample: result.deviations
          .slice(0, 20)
          .map((d) => ({ file: d.filePath, kind: d.kind, detail: d.detail }))
      }
    },
    formatCli: (value) => {
      const s = value as {
        filenameConflicts: number
        templateDeviations: number
        byKind: Record<string, number>
      }
      if (!s.filenameConflicts && !s.templateDeviations) return uiText('auto.768f9220e68b')
      const kinds = Object.entries(s.byKind)
        .map(([kind, count]) => `${kind}: ${count}`)
        .join(', ')
      return `${s.filenameConflicts} filename conflict${s.filenameConflicts === 1 ? '' : 's'}, ${s.templateDeviations} template deviation${s.templateDeviations === 1 ? '' : 's'}${kinds ? ` (${kinds})` : ''}.`
    }
  })
  const offChanges = api.subscribe(() => { for (const listener of listeners) listener() })
  const offSurface = api.interop.extensions.provide(PLUGIN_SURFACE_V1, {
    id: 'check.results', surface: 'footer', subscribe,
    getSnapshot: () => ({ title: 'Check', view: { ...view }, ...(view.path ? { item: { id: `${view.category}:${view.path}`, title: view.path, state: { ...view } } } : {}) }),
    restore: (state, _instanceId, options) => {
      const category = state.category === 'validation' ? 'validation' : 'files'
      const path = typeof state.path === 'string' ? state.path : ''
      if (path) {
        const result = runChecks(api.getState().indexEntries, readConfig(api))
        const exists = category === 'files' ? result.conflicts.some((item) => item.paths.includes(path)) : result.deviations.some((item) => item.filePath === path)
        if (!exists) throw new Error('This diagnostic no longer exists; the issue may have been resolved')
      }
      setView({ category, path })
      if (!options?.background) openResults()
    }
  })
  const fields = [
    { id: 'strictFilename', label: 'Strict filenames', labelKey: 'auto.3f9714e381b4' },
    { id: 'ignoredExtensions', label: 'Ignored extensions', labelKey: 'auto.dcb9d121fdf0' },
    { id: 'excludedFolders', label: 'Excluded folders', labelKey: 'auto.956d3039f8ba' },
    { id: 'excludedPatterns', label: 'Excluded patterns', labelKey: 'auto.89e396116977' }
  ]
  const renderPropertyField = (id: string): ReturnType<typeof h> => {
    const field = fields.find((entry) => entry.id === id)!
    const settings = { ...api.settings.get(), ...settingDrafts }, kit = api.ui.settings
    return h(kit.Row, { key: field.id, title: uiText(field.labelKey) }, field.id === 'strictFilename'
      ? h(kit.Toggle, { checked: settings[field.id] === true, label: uiText(field.labelKey), onChange: (value: boolean) => saveSetting(field.id, value) })
      : h(kit.ChipsField, { items: field.id === 'ignoredExtensions' ? parseExtList(settings[field.id]) : parseList(settings[field.id]), ariaLabel: uiText(field.labelKey), normalize: field.id === 'ignoredExtensions' ? (value: string) => { const extension = value.trim().toLowerCase(); return extension && !extension.startsWith('.') ? `.${extension}` : extension } : undefined, onChange: (value: string[]) => saveSetting(field.id, value.join(', ')) }))
  }
  const offResults = api.commands.register({
    id: 'results', label: 'List check results', labelKey: 'check.surface.results', paletteSafe: false, sideEffect: 'read',
    input: {
      schema: { type: 'object', properties: { category: { enum: ['files', 'validation', 'all'] }, path: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 500 }, offset: { type: 'integer', minimum: 0 } }, additionalProperties: false },
      parse: (raw) => {
        const input = (raw ?? {}) as Record<string, unknown>, limit = Number(input.limit ?? 100), offset = Number(input.offset ?? 0)
        const category = input.category ?? 'all'
        if (!['files', 'validation', 'all'].includes(String(category)) || !Number.isInteger(limit) || limit < 1 || limit > 500 || !Number.isInteger(offset) || offset < 0 || (input.path !== undefined && typeof input.path !== 'string')) throw new Error('Invalid check query')
        return { category, path: String(input.path ?? ''), limit, offset }
      }
    },
    run: ({ category, path, limit, offset }) => {
      const result = runChecks(api.getState().indexEntries, readConfig(api))
      const rows = [
        ...(category !== 'validation' ? result.conflicts.flatMap((item) => item.paths.map((file) => ({ category: 'files', path: file, kind: 'filename-conflict', detail: item.name }))) : []),
        ...(category !== 'files' ? result.deviations.map((item) => ({ category: 'validation', path: item.filePath, kind: item.kind, detail: item.detail })) : [])
      ].filter((item) => !path || item.path.includes(path))
      return { total: rows.length, rows: rows.slice(offset, offset + limit), nextOffset: offset + limit < rows.length ? offset + limit : null }
    }
  })
  const offEdit = api.commands.register({
    id: 'settings-update', label: 'Update check settings', labelKey: 'check.command.settings-update', paletteSafe: false, sideEffect: 'write',
    input: {
      schema: { type: 'object', properties: { subject: { type: 'object' }, values: { type: 'object', properties: { strictFilename: { type: 'boolean' }, ignoredExtensions: { type: 'string' }, excludedFolders: { type: 'string' }, excludedPatterns: { type: 'string' } }, additionalProperties: false } }, required: ['values'] },
      parse: (raw) => {
        const values = (raw as { values?: unknown })?.values
        if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('Settings values are required')
        for (const [key, value] of Object.entries(values)) if (!fields.some((field) => field.id === key) || typeof value !== (key === 'strictFilename' ? 'boolean' : 'string')) throw new Error(`Invalid check setting: ${key}`)
        return values as Record<string, string | boolean>
      }
    },
    preview: (values) => ({ settings: values }),
    revision: () => api.settings.get(),
    run: async (values) => {
      if (Object.keys(settingDrafts).length) throw new Error('Finish saving Check settings before changing them through automation')
      const previous = Object.fromEntries(Object.keys(values).map((key) => [key, api.settings.get()[key]]))
      await changeSettings(values)
      return { value: values, revert: { label: 'Update check settings', run: async () => {
        if (Object.keys(values).some((key) => api.settings.get()[key] !== values[key])) throw new Error('Check settings changed after this operation')
        await changeSettings(previous)
      } } }
    }
  })
  return () => {
    offStatus()
    offResults()
    offEdit()
    offSurface()
    offChanges()
    listeners.clear()
    disposeStyles()
  }
}

/** One-time injection of the plugin's styles (plugin bundles can't ship CSS). */
function injectStyles(): () => void {
  const id = 'check-plugin-styles'
  document.getElementById(id)?.remove()
  const style = document.createElement('style')
  style.id = id
  style.textContent = CSS
  document.head.appendChild(style)
  return () => style.remove()
}

const CSS = `
.check-badge-quiet { color: var(--text-muted); }
.check-results-popover { width: 360px; max-height: 50vh; }
.check-results { display: flex; flex-direction: column; min-height: 80px; }
.check-popover-row.selected { background: var(--hover-bg); }

.check-badge {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  background: transparent;
  border: none;
  color: var(--negative-color);
  font: inherit;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
  padding: 0 4px;
  border-radius: var(--radius-sm);
}
.check-badge:hover,
.check-badge.open {
  background: var(--hover-bg);
}
.check-popover-list {
  overflow-y: auto;
  padding: 4px 0;
}
.check-popover-group {
  padding: 6px 10px 2px;
  font-size: var(--smaller-font-size);
  font-weight: var(--font-semi-bold);
  color: var(--text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.03em;
}
.check-popover-row {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 1px;
  width: 100%;
  text-align: left;
  background: transparent;
  border: none;
  cursor: pointer;
  padding: 4px 10px;
  font: inherit;
  color: var(--text-color);
}
.check-popover-row:hover {
  background: var(--hover-bg);
}
.check-popover-path {
  font-family: var(--mono-font);
  font-size: var(--small-font-size);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
}
.check-popover-detail {
  font-size: var(--smaller-font-size);
  color: var(--text-tertiary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
}
`

const plugin: ValleyPluginModule = { register }
export default plugin
