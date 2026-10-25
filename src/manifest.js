import fs from 'node:fs'
import path from 'node:path'

/** Navigation subpage cid; it groups keys in the Key Library and is not a key itself. */
const SUBPAGE_CID = 'com.eniac.navigation.page'

/**
 * Loads a FlexDesigner v1 plugin directory (the `com.<author>.<name>.plugin` folder).
 * Returns the manifest plus a flat list of key definitions with `$` strings resolved.
 */
export function loadPlugin(pluginDir, language = 'en') {
  const dir = path.resolve(pluginDir)
  const manifestPath = path.join(dir, 'manifest.json')
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`No manifest.json in ${dir}. Point the simulator at the plugin folder (com.<author>.<name>.plugin).`)
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  for (const field of ['uuid', 'entry']) {
    if (!manifest[field]) {
      throw new Error(`manifest.json is missing "${field}"`)
    }
  }
  const entry = path.join(dir, manifest.entry)
  if (!fs.existsSync(entry)) {
    throw new Error(`Backend entry ${manifest.entry} does not exist yet. Build the plugin first.`)
  }

  const strings = { ...(manifest.local?.en ?? {}), ...(manifest.local?.[language] ?? {}) }
  const translate = (text) => {
    if (typeof text !== 'string' || !text.startsWith('$')) {
      return text
    }
    const lookup = text.slice(1).split('.').reduce((node, part) => node?.[part], strings)
    return typeof lookup === 'string' ? lookup : text
  }

  const keys = []
  const walk = (children, group) => {
    for (const child of children ?? []) {
      if (child.cid === SUBPAGE_CID) {
        walk(child.children, [...group, translate(child.title)])
        continue
      }
      keys.push({
        cid: child.cid,
        title: translate(child.title) ?? child.cid,
        tip: translate(child.tip) ?? '',
        group: group.join(' / '),
        config: child.config ?? { keyType: 'default' },
        style: child.style ?? {},
        data: child.data ?? {},
      })
    }
  }
  walk(manifest.keyLibrary?.children, [])

  return {
    dir,
    entry,
    manifest,
    uuid: manifest.uuid,
    name: translate(manifest.name) ?? manifest.uuid,
    keys,
  }
}
