import { createIndexObserver, type PluginIndexEntry, type PluginIndexSnapshot, type PluginIndexVersion, type ValleyPluginApi } from '@valley/plugin-sdk'
import { ALWAYS_IGNORED_EXTENSIONS, baseName, checkableNote, checkNote, fileExt, isExcluded, noteType, parseExtList, parseList, templateSchema } from './check'
import type { CheckConfig, CheckResult, Deviation, FilenameConflict, TemplateSchema } from './types'

interface IndexedEntry {
  entry: PluginIndexEntry
  signature: string
  order: number
  type: string
  checked: boolean
  filename: string | null
  template: TemplateSchema | null
}

export class CheckProjection {
  private entries: readonly PluginIndexEntry[] | null = null
  private configKey = ''
  private nextOrder = 0
  private records = new Map<string, IndexedEntry>()
  private templates = new Map<string, Map<string, TemplateSchema>>()
  private registry = new Map<string, TemplateSchema>()
  private notes = new Map<string, Set<string>>()
  private filenames = new Map<string, Set<string>>()
  private conflicts = new Map<string, FilenameConflict>()
  private deviations = new Map<string, Deviation[]>()
  private snapshot = { revision: 0, result: { conflicts: [], deviations: [] } as CheckResult }

  getSnapshot = () => this.snapshot

  update(entries: readonly PluginIndexEntry[], config: CheckConfig, change?: PluginIndexSnapshot['change']): boolean {
    const configKey = JSON.stringify(config)
    const reset = configKey !== this.configKey
    const delta = reset ? undefined : change
    if (!reset && entries === this.entries) return false
    if (reset) {
      this.records.clear(); this.templates.clear(); this.registry.clear(); this.notes.clear()
      this.filenames.clear(); this.conflicts.clear(); this.deviations.clear()
      this.nextOrder = 0
    }
    this.configKey = configKey
    this.entries = entries
    const ignored = new Set(config.ignoredKeys)
    const ignoredExtensions = new Set([...ALWAYS_IGNORED_EXTENSIONS, ...config.ignoredExtensions])
    const seen = new Set<string>()
    const dirty = new Set<string>()
    const templateTypes = new Set<string>()
    const filenameKeys = new Set<string>()
    let reordered = false
    const remove = (path: string, record: IndexedEntry): void => {
      if (record.checked) { this.notes.get(record.type)?.delete(path); dirty.add(path) }
      if (record.template) { this.templates.get(record.type)?.delete(path); templateTypes.add(record.type) }
      if (record.filename) { this.filenames.get(record.filename)?.delete(path); filenameKeys.add(record.filename) }
      this.records.delete(path)
    }
    for (const [position, entry] of (delta?.changed ?? entries).entries()) {
      const path = entry.relPath
      seen.add(path)
      const previous = this.records.get(path)
      const order = delta ? previous?.order ?? this.nextOrder++ : position
      const signature = previous?.entry === entry ? previous.signature : JSON.stringify([entry.kind, entry.frontmatter ?? null])
      if (previous?.signature === signature) {
        if (previous.order !== order) {
          if (this.deviations.has(path)) reordered = true
          if (previous.template) templateTypes.add(previous.type)
          if (previous.filename) filenameKeys.add(previous.filename)
          previous.order = order
        }
        previous.entry = entry
        continue
      }
      if (previous) remove(path, previous)
      const type = noteType(entry)
      const checked = checkableNote(entry, config)
      const template = config.templateCheck ? templateSchema(entry, config.templatesFolder)?.schema ?? null : null
      const filename = config.strictFilename && !isExcluded(path, config.excludedFolders, config.excludedPatterns)
        && !ignoredExtensions.has(fileExt(path)) ? baseName(path).toLowerCase() || null : null
      this.records.set(path, { entry, signature, order, type, checked, template, filename })
      if (checked) {
        const paths = this.notes.get(type) ?? new Set<string>()
        paths.add(path); this.notes.set(type, paths); dirty.add(path)
      }
      if (template) {
        const candidates = this.templates.get(type) ?? new Map<string, TemplateSchema>()
        candidates.set(path, template); this.templates.set(type, candidates); templateTypes.add(type)
      }
      if (filename) {
        const paths = this.filenames.get(filename) ?? new Set<string>()
        paths.add(path); this.filenames.set(filename, paths); filenameKeys.add(filename)
      }
    }
    if (delta) {
      for (const path of delta.deleted) {
        const record = this.records.get(path)
        if (record) remove(path, record)
      }
    } else {
      for (const [path, record] of this.records) if (!seen.has(path)) remove(path, record)
      this.nextOrder = entries.length
    }
    for (const type of templateTypes) {
      let last = -1
      let selected: TemplateSchema | undefined
      const candidates = this.templates.get(type)
      for (const [path, schema] of candidates ?? []) {
        const order = this.records.get(path)!.order
        if (order > last) { last = order; selected = schema }
      }
      if (!candidates?.size) this.templates.delete(type)
      if (JSON.stringify(this.registry.get(type)?.values) === JSON.stringify(selected?.values)) continue
      if (selected) this.registry.set(type, selected)
      else this.registry.delete(type)
      for (const path of this.notes.get(type) ?? []) dirty.add(path)
    }
    for (const path of dirty) {
      const record = this.records.get(path)
      if (!record?.checked) { this.deviations.delete(path); continue }
      const errors: Deviation[] = []
      checkNote(record.entry, this.registry, ignored, errors)
      if (errors.length) this.deviations.set(path, errors)
      else this.deviations.delete(path)
    }
    let filenamesChanged = false
    for (const key of filenameKeys) {
      const paths = [...this.filenames.get(key) ?? []]
      if (!paths.length) this.filenames.delete(key)
      let next: FilenameConflict | undefined
      if (paths.length > 1) {
        const first = paths.reduce((a, b) => this.records.get(a)!.order < this.records.get(b)!.order ? a : b)
        next = { name: baseName(first), paths: paths.sort() }
      }
      if (JSON.stringify(this.conflicts.get(key)) === JSON.stringify(next)) continue
      if (next) this.conflicts.set(key, next)
      else this.conflicts.delete(key)
      filenamesChanged = true
    }
    for (const [type, paths] of this.notes) if (!paths.size) this.notes.delete(type)
    if (!reset && !dirty.size && !filenamesChanged && !reordered) return false
    this.snapshot = {
      revision: this.snapshot.revision + 1,
      result: {
        conflicts: [...this.conflicts.values()].sort((a, b) => a.name.localeCompare(b.name)),
        deviations: [...this.deviations].sort(([a], [b]) => this.records.get(a)!.order - this.records.get(b)!.order).flatMap(([, errors]) => errors)
      }
    }
    return true
  }
}

function readConfig(api: ValleyPluginApi, templatesFolder: string): CheckConfig {
  const settings = api.settings.get()
  return {
    strictFilename: settings.strictFilename === true,
    templateCheck: settings.templateCheck === true,
    templatesFolder,
    excludedFolders: parseList(settings.excludedFolders),
    excludedPatterns: parseList(settings.excludedPatterns),
    ignoredKeys: parseList(settings.ignoredKeys),
    ignoredExtensions: parseExtList(settings.ignoredExtensions)
  }
}

function createOwner(api: ValleyPluginApi, retired?: Promise<void>) {
  const projection = new CheckProjection()
  const index = createIndexObserver(api, { fields: ['kind', 'frontmatter'] })
  const listeners = new Set<() => void>()
  let disposed = false
  let version: PluginIndexVersion | null = null
  let disposal: Promise<void> | undefined
  let readiness: { promise: Promise<void>; resolve(): void; reject(error: Error): void } | undefined
  const refresh = (): void => {
    if (disposed) return
    const snapshot = index.getSnapshot()
    if (snapshot.status === 'error') {
      readiness?.reject(new Error(snapshot.error ?? 'Check index is unavailable'))
      readiness = undefined
      return
    }
    if (snapshot.status !== 'ready') return
    const delta = snapshot.change && version && snapshot.version
      && version.vaultGeneration === snapshot.version.vaultGeneration
      && version.scopeGeneration === snapshot.version.scopeGeneration
      && version.revision === snapshot.change.previousRevision
      && snapshot.version.revision === version.revision + 1 ? snapshot.change : undefined
    const changed = projection.update(snapshot.entries, readConfig(api, api.getState().templateFolder), delta)
    version = snapshot.version
    readiness?.resolve()
    readiness = undefined
    if (changed) for (const listener of listeners) listener()
  }
  const offIndex = index.subscribe(refresh)
  const offState = api.subscribeState(['templateFolder'], refresh)
  const offSettings = api.settings.subscribe(refresh)
  return {
    getSnapshot: projection.getSnapshot,
    ready: (): Promise<void> => {
      if (disposed) return Promise.reject(new Error('Check index was disposed'))
      const snapshot = index.getSnapshot()
      if (snapshot.status === 'error') return Promise.reject(new Error(snapshot.error ?? 'Check index is unavailable'))
      if (snapshot.status === 'ready') return Promise.resolve()
      if (!readiness) {
        let resolve!: () => void
        let reject!: (error: Error) => void
        const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
        readiness = { promise, resolve, reject }
      }
      return readiness.promise
    },
    subscribe: (listener: () => void) => { if (!disposed) listeners.add(listener); return () => { listeners.delete(listener) } },
    dispose: (): Promise<void> => {
      if (disposal) return disposal
      disposed = true
      offIndex(); offState(); offSettings(); listeners.clear()
      readiness?.reject(new Error('Check index was disposed'))
      readiness = undefined
      disposal = (async () => {
        const results = await Promise.allSettled([index.dispose(), retired])
        const failed = results.find(result => result.status === 'rejected')
        if (failed?.status === 'rejected') throw failed.reason
      })()
      return disposal
    }
  }
}

export function acquireCheckProjection(api: ValleyPluginApi) {
  type Session = { api: ValleyPluginApi; owner: ReturnType<typeof createOwner>; leases: number }
  const holder = api.runtime.getOrCreate<{ current: Session | null }>('check.projection', () => ({ current: null }))
  if (holder.current?.api !== api) {
    const retired = holder.current?.owner.dispose()
    void retired?.catch(() => {})
    holder.current = { api, owner: createOwner(api, retired), leases: 0 }
  }
  const session = holder.current
  const { owner } = session
  session.leases++
  let disposal: Promise<void> | undefined
  return {
    ...owner,
    dispose: (): Promise<void> => {
      if (disposal) return disposal
      if (--session.leases === 0) {
        disposal = owner.dispose()
        if (holder.current === session) holder.current = null
      } else disposal = Promise.resolve()
      return disposal
    }
  }
}
