import type { ValleyPluginApi } from '@valley/plugin-sdk'
import { generatedCatalogs } from './generatedCatalogs'

const surfaceCatalogs = {
  "en": {
    "check.properties.retry": "Retry",
    "check.surface.results": "List check results",
    "check.command.settings-update": "Update check settings",
    "check.properties.saveError": "Could not save your changes. Your edits are kept; try again."
  },
  "de": {
    "check.properties.retry": "Erneut versuchen",
    "check.surface.results": "Prüfergebnisse auflisten",
    "check.command.settings-update": "Prüfeinstellungen bearbeiten",
    "check.properties.saveError": "Deine Änderungen konnten nicht gespeichert werden. Sie bleiben erhalten; versuche es erneut."
  },
  "es": {
    "check.properties.retry": "Reintentar",
    "check.surface.results": "Listar resultados",
    "check.command.settings-update": "Editar ajustes de comprobación",
    "check.properties.saveError": "No se pudieron guardar los cambios. Se conservan; inténtalo de nuevo."
  },
  "fr": {
    "check.properties.retry": "Réessayer",
    "check.surface.results": "Lister les résultats",
    "check.command.settings-update": "Modifier les paramètres de vérification",
    "check.properties.saveError": "Impossible d’enregistrer vos modifications. Elles sont conservées ; réessayez."
  },
  "zh-CN": {
    "check.properties.retry": "重试",
    "check.surface.results": "列出检查结果",
    "check.command.settings-update": "编辑检查设置",
    "check.properties.saveError": "无法保存更改。编辑内容已保留；请重试。"
  }
}

function english(key: string, params?: Parameters<ValleyPluginApi['ui']['t']>[1]): string {
  const fallback = (surfaceCatalogs.en as Record<string, string>)[key] ?? (generatedCatalogs.en as Record<string, string>)[key] ?? key
  return fallback.replace(/\{\{([^}]+)\}\}/g, (_match: string, name: string) => String(params?.[name] ?? ''))
}

let translate: ValleyPluginApi['ui']['t'] = english

export function initLocalization(api: ValleyPluginApi): void {
  translate = (key, params) => {
    const value = api.ui.t(key, params)
    return value === key ? english(key, params) : value
  }
  api.ui.registerCatalogs(generatedCatalogs)
  api.ui.registerCatalogs(surfaceCatalogs)
}

export function uiText(key: string, params?: Parameters<ValleyPluginApi['ui']['t']>[1]): string {
  return translate(key, params)
}
