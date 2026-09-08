/**
 * Value-type detection + compatibility. Unlike the reference port (which detects
 * types from raw YAML text), Check works on values already parsed by the vault
 * index's YAML parser, so detection is a direct JS-type mapping. The leniency
 * rules in `areTypesCompatible` are ported verbatim from the reference
 * `type-detector.ts`.
 */
import type { YamlValueType } from './types'

export function detectType(value: unknown): YamlValueType {
  if (value === null || value === undefined || value === '') return 'null'
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'number') return 'number'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'object') return 'object'
  return 'string'
}

export function areTypesCompatible(templateType: YamlValueType, noteType: YamlValueType): boolean {
  if (templateType === noteType) return true
  // A missing/empty value never counts as a type mismatch.
  if (templateType === 'null' || noteType === 'null') return true
  if (
    (templateType === 'string' && noteType === 'number') ||
    (templateType === 'number' && noteType === 'string')
  )
    return true
  if (
    (templateType === 'string' && noteType === 'array') ||
    (templateType === 'array' && noteType === 'string')
  )
    return true
  return false
}
