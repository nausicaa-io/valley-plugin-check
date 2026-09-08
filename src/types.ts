/**
 * Shared types for the Check plugin. The deviation model is adapted for
 * parsed-frontmatter input.
 */

export type YamlValueType = 'string' | 'number' | 'boolean' | 'array' | 'object' | 'null'

export type DeviationKind =
  | 'no_frontmatter'
  | 'no_type_field'
  | 'unknown_type'
  | 'missing_key'
  | 'extra_key'
  | 'wrong_order'
  | 'wrong_type'

export interface Deviation {
  filePath: string
  kind: DeviationKind
  detail?: string
}

/** A set of files sharing one name (basename without extension, lowercased). */
export interface FilenameConflict {
  name: string
  paths: string[]
}

export interface CheckResult {
  conflicts: FilenameConflict[]
  deviations: Deviation[]
}

/** A template's frontmatter shape, keyed by its `type`. */
export interface TemplateSchema {
  keyOrder: string[]
  keySet: Set<string>
  /** Parsed value per key, for value-type comparison. */
  values: Record<string, unknown>
}

export interface CheckConfig {
  strictFilename: boolean
  templateCheck: boolean
  templatesFolder: string
  excludedFolders: string[]
  excludedPatterns: string[]
  ignoredKeys: string[]
  /** Lowercased, dot-prefixed extensions skipped by the filename check. */
  ignoredExtensions: string[]
}
