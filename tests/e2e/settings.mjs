import fs from 'node:fs'
import path from 'node:path'

export async function verify(context) {
  const { evaluate, waitFor, selectSettingsPage, readJson, vault, scratch } = context
  const scratchRoot = fs.realpathSync(scratch)
  const lexicalRelative = path.relative(path.resolve(scratch), path.resolve(vault))
  if (!lexicalRelative || lexicalRelative.startsWith('..') || path.isAbsolute(lexicalRelative)) throw new Error('The vault must be inside the disposable scratch directory')
  const sentinel = JSON.parse(fs.readFileSync(path.join(scratchRoot, '.valley-test-run.json'), 'utf8'))
  const vaultRoot = fs.realpathSync(vault)
  const relative = path.relative(scratchRoot, vaultRoot)
  if (sentinel.version !== 1 || !/^[a-z0-9][a-z0-9-]*$/.test(sentinel.kind ?? '') || !relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('This workflow requires a disposable vault inside a sentinel-protected scratch run')
  }
  const liveVault = await evaluate(`(async () => (await window.valley.getVault())?.path ?? null)()`, true)
  if (typeof liveVault !== 'string' || (path.resolve(liveVault) !== path.resolve(vault) && path.resolve(liveVault) !== vaultRoot)) throw new Error('This workflow refuses to drive a different live vault')
  await selectSettingsPage(evaluate, 'Check', '[role="switch"][aria-label="Strict filenames"]')
  const templateValue = await evaluate(`document.querySelector('output[aria-label="Templates folder"]')?.textContent ?? ''`)
  if (!templateValue.includes('Templates')) {
    throw new Error(`Check did not read the core template folder: ${templateValue}`)
  }
  await evaluate(`(() => {
    const control = document.querySelector('[role="switch"][aria-label="Strict filenames"]')
    if (control?.getAttribute('aria-checked') !== 'true') control?.click()
  })()`)
  const checkSettingsFile = path.join(vault, '.valley', 'plugins', 'data', 'check', 'config.json')
  await waitFor(
    async () => fs.existsSync(checkSettingsFile) && readJson(checkSettingsFile).strictFilename === true,
    'Check strict-filename persistence'
  )
}
