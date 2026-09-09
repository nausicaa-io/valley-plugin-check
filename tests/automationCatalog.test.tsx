import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { METADATA_PANEL_SEGMENT_V1, PLUGIN_SURFACE_V1 } from '@valley/plugin-sdk'
import type { ValleyPluginManifest } from '@valley/plugin-sdk/types'
import { createMockValleyApi } from '@valley/plugin-testkit'

const packages = [['check', () => import('../src/index'), () => import('../manifest.json'), () => import('../config.json')]] as const

describe('plugin automation source catalog', () => {
  const createObjectURL = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
  beforeAll(() => { Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: () => 'blob:catalog-test' }) })
  afterAll(() => {
    if (createObjectURL) Object.defineProperty(URL, 'createObjectURL', createObjectURL)
    else Reflect.deleteProperty(URL, 'createObjectURL')
  })
  it.each(packages)('%s declares input schemas and main-content-only Properties', async (id, module, manifest, config) => {
    const [plugin, metadata, configuration] = await Promise.all([module(), manifest(), config()])
    const declared = { ...metadata.default, ...configuration.default } as unknown as ValleyPluginManifest
    const mock = createMockValleyApi({ manifest: declared })
    const dispose = plugin.register(mock.api)
    try {
      await Promise.resolve()
      const commands = mock.api.commands.list()
      expect(commands.length, `${id} did not register its commands`).toBeGreaterThan(0)
      expect(commands.filter((command) => command.acceptsInput && !command.inputSchema).map((command) => command.id)).toEqual([])
      expect(commands.every((command) => command.pluginId === id && command.id.startsWith(`${id}:`))).toBe(true)
      const properties = mock.api.interop.extensions.providers(METADATA_PANEL_SEGMENT_V1)
      const declaredExtensions = (declared.provides ?? []).filter((contract) => contract.kind === 'extension').map((contract) => contract.id)
      expect(declaredExtensions).not.toContain(METADATA_PANEL_SEGMENT_V1.id)
      expect(properties).toEqual([])
      expect(declaredExtensions).toContain(PLUGIN_SURFACE_V1.id)
      for (const { extension } of properties) {
        expect(extension.pluginSurfaces === undefined || extension.pluginSurfaces.every((surface) => surface === 'main_workspace')).toBe(true)
        expect(extension.inspect, `${id}:${extension.id} is missing machine-readable Properties`).toBeTypeOf('function')
        if (extension.editCommand) {
          expect(extension.editCommand).not.toContain(':')
          expect(commands.find((command) => command.id === `${id}:${extension.editCommand}`), extension.editCommand).toMatchObject({ pluginId: id, sideEffect: 'write' })
        }
      }
      const surfaces = mock.api.interop.extensions.providers(PLUGIN_SURFACE_V1).map(({ extension }) => extension.surface)
      for (const surface of Object.keys(declared.uiSlots ?? {})) expect(surfaces, `${id}:${surface}`).toContain(surface)
      if (Object.keys(declared.fileViews ?? {}).length) expect(surfaces).toContain('main_workspace')
      if (properties.some(({ extension }) => extension.pluginSurfaces?.includes('main_workspace'))) expect(surfaces).toContain('main_workspace')
      expect(new Set(commands.map((command) => command.id)).size).toBe(commands.length)
    } finally { dispose() }
  })
})
