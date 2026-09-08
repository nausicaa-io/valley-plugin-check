/**
 * Pure, React-free check logic. Runs against the vault index entries the host
 * exposes via `api.getState().indexEntries` — every file with parsed,
 * order-preserving `frontmatter` — so Check needs no filesystem access.
 *
 * Two validations:
 *  - Strict filename: every file name (basename without extension) must be unique.
 *  - Strict template check: every non-excluded note must match the template for
 *    its `type` exactly (same keys, same order, compatible value types). The
 *    template schema for a `type` is derived from the template file's own `type`
 *    frontmatter inside the configured templates folder — no hardcoded mapping.
 */
import type { IndexEntry } from '@valley/plugin-sdk/types'
import type { CheckConfig, CheckResult, Deviation, FilenameConflict, TemplateSchema } from './types'
import { areTypesCompatible, detectType } from './typeDetect'

/** Split a comma/space/newline-separated setting string into trimmed entries. */
export function parseList(value: unknown): string[] {
  if (typeof value !== 'string') return []
  const out: string[] = []
  for (const raw of value.split(/[\s,]+/)) {
    const t = raw.trim()
    if (t && !out.includes(t)) out.push(t)
  }
  return out
}

/** `.json` and `.jsonl` are Notes data files, never user notes — always ignored. */
const ALWAYS_IGNORED_EXTENSIONS = ['.json', '.jsonl']

/** Normalize a list of extensions to lowercase, dot-prefixed, de-duplicated. */
export function parseExtList(value: unknown): string[] {
  const out: string[] = []
  for (const raw of parseList(value)) {
    const ext = (raw.startsWith('.') ? raw : `.${raw}`).toLowerCase()
    if (ext !== '.' && !out.includes(ext)) out.push(ext)
  }
  return out
}

/** Basename without directory or extension. */
function baseName(relPath: string): string {
  const last = relPath.split('/').pop() ?? relPath
  const dot = last.lastIndexOf('.')
  return dot > 0 ? last.slice(0, dot) : last
}

/** Lowercased extension including the dot (`""` when the file has none). */
function fileExt(relPath: string): string {
  const last = relPath.split('/').pop() ?? relPath
  const dot = last.lastIndexOf('.')
  return dot > 0 ? last.slice(dot).toLowerCase() : ''
}

/** Port of the reference `shouldExclude`: folder-prefix or substring match. */
export function isExcluded(relPath: string, excludedFolders: string[], excludedPatterns: string[]): boolean {
  const normalized = relPath.startsWith('/') ? relPath.slice(1) : relPath
  for (const folder of excludedFolders) {
    if (normalized === folder || normalized.startsWith(folder + '/')) return true
  }
  for (const pattern of excludedPatterns) {
    if (pattern && normalized.includes(pattern)) return true
  }
  return false
}

function inFolder(relPath: string, folder: string): boolean {
  if (!folder) return false
  return relPath === folder || relPath.startsWith(folder + '/')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Build the template registry keyed by `type`, from every note inside the
 * templates folder whose frontmatter declares a `type`. Key order is the
 * frontmatter key insertion order (preserved by the index's YAML parser).
 */
export function buildRegistry(entries: IndexEntry[], templatesFolder: string): Map<string, TemplateSchema> {
  const registry = new Map<string, TemplateSchema>()
  if (!templatesFolder) return registry
  for (const entry of entries) {
    if (entry.kind !== 'note') continue
    if (!inFolder(entry.relPath, templatesFolder)) continue
    const fm = entry.frontmatter
    if (!isRecord(fm)) continue
    const typeRaw = fm.type
    if (typeof typeRaw !== 'string' || !typeRaw.trim()) continue
    const type = typeRaw.toLowerCase().trim()
    const keyOrder = Object.keys(fm)
    registry.set(type, { keyOrder, keySet: new Set(keyOrder), values: fm })
  }
  return registry
}

/** Detect duplicate file names (basename without extension, case-insensitive). */
function findFilenameConflicts(entries: IndexEntry[], config: CheckConfig): FilenameConflict[] {
  const ignoredExt = new Set([...config.ignoredExtensions, ...ALWAYS_IGNORED_EXTENSIONS])
  const groups = new Map<string, { display: string; paths: string[] }>()
  for (const entry of entries) {
    if (isExcluded(entry.relPath, config.excludedFolders, config.excludedPatterns)) continue
    if (ignoredExt.has(fileExt(entry.relPath))) continue
    const display = baseName(entry.relPath)
    const key = display.toLowerCase()
    if (!key) continue
    const group = groups.get(key)
    if (group) group.paths.push(entry.relPath)
    else groups.set(key, { display, paths: [entry.relPath] })
  }
  const conflicts: FilenameConflict[] = []
  for (const { display, paths } of groups.values()) {
    if (paths.length > 1) conflicts.push({ name: display, paths: paths.slice().sort() })
  }
  return conflicts.sort((a, b) => a.name.localeCompare(b.name))
}

/** Compare one note against its template schema, emitting deviations. */
function checkNote(
  entry: IndexEntry,
  registry: Map<string, TemplateSchema>,
  ignored: Set<string>,
  out: Deviation[]
): void {
  const fm = entry.frontmatter
  if (!isRecord(fm) || Object.keys(fm).length === 0) {
    out.push({ filePath: entry.relPath, kind: 'no_frontmatter' })
    return
  }

  const typeRaw = fm.type
  if (typeof typeRaw !== 'string' || !typeRaw.trim()) {
    out.push({ filePath: entry.relPath, kind: 'no_type_field' })
    return
  }
  const type = typeRaw.toLowerCase().trim()

  const schema = registry.get(type)
  if (!schema) {
    out.push({ filePath: entry.relPath, kind: 'unknown_type', detail: type })
    return
  }

  const noteKeyOrder = Object.keys(fm)
  const noteKeySet = new Set(noteKeyOrder)

  // Missing keys
  for (const tKey of schema.keyOrder) {
    if (ignored.has(tKey)) continue
    if (!noteKeySet.has(tKey)) out.push({ filePath: entry.relPath, kind: 'missing_key', detail: tKey })
  }

  // Extra keys
  for (const nKey of noteKeyOrder) {
    if (ignored.has(nKey)) continue
    if (!schema.keySet.has(nKey)) out.push({ filePath: entry.relPath, kind: 'extra_key', detail: nKey })
  }

  // Wrong order (strict): compare the shared keys in each side's order.
  const commonTemplate = schema.keyOrder.filter((k) => noteKeySet.has(k) && !ignored.has(k))
  const commonNote = noteKeyOrder.filter((k) => schema.keySet.has(k) && !ignored.has(k))
  if (commonTemplate.length === commonNote.length) {
    for (let i = 0; i < commonTemplate.length; i++) {
      if (commonTemplate[i] !== commonNote[i]) {
        out.push({
          filePath: entry.relPath,
          kind: 'wrong_order',
          detail: `expected "${commonTemplate[i]}" at position ${i}, found "${commonNote[i]}"`
        })
        break
      }
    }
  }

  // Wrong value type
  for (const tKey of schema.keyOrder) {
    if (ignored.has(tKey)) continue
    if (!noteKeySet.has(tKey)) continue
    const tType = detectType(schema.values[tKey])
    const nType = detectType(fm[tKey])
    if (!areTypesCompatible(tType, nType)) {
      out.push({
        filePath: entry.relPath,
        kind: 'wrong_type',
        detail: `"${tKey}": expected ${tType}, got ${nType}`
      })
    }
  }
}

export function runChecks(entries: IndexEntry[], config: CheckConfig): CheckResult {
  const conflicts = config.strictFilename ? findFilenameConflicts(entries, config) : []

  const deviations: Deviation[] = []
  if (config.templateCheck) {
    const registry = buildRegistry(entries, config.templatesFolder)
    const ignored = new Set(config.ignoredKeys)
    for (const entry of entries) {
      if (entry.kind !== 'note') continue
      if (inFolder(entry.relPath, config.templatesFolder)) continue
      if (isExcluded(entry.relPath, config.excludedFolders, config.excludedPatterns)) continue
      checkNote(entry, registry, ignored, deviations)
    }
  }

  return { conflicts, deviations }
}
