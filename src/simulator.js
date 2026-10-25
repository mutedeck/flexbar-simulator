import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { loadPlugin } from './manifest.js'
import { PluginHost } from './plugin-host.js'

/** Flexbar screen size in pixels (offsetX range 0–2170, height fixed at 60). */
export const STRIP_WIDTH = 2170
export const STRIP_HEIGHT = 60

/** Version the simulator reports from getAppInfo (the FlexDesigner release it was modelled on). */
const APP_VERSION = 'v2.2.3'

const DEFAULT_STYLE = {
  icon: '',
  emoji: '',
  width: 240,
  bgColor: '#424242',
  fgColor: '#ffffff',
  borderStyle: 'none',
  borderWidth: 1,
  borderColor: '#ffffff',
  font: '',
  fontSize: 24,
  iconSize: 42,
  iconPos: { X: 50, Y: 49 },
  titlePos: { X: 50, Y: 50 },
  titleRotate: 0,
  iconRotate: 0,
  foregroundOutline: true,
  showIcon: true,
  showEmoji: false,
  showTitle: false,
  showImage: false,
}

/** Host behaviour the docs don't pin down. Shown in the UI so nobody mistakes them for facts. */
export const ASSUMPTIONS = [
  'plugin.alive/plugin.dead fire per page: switching pages kills the old page keys and makes the new page keys alive.',
  'A multiState key advances its own state on tap; plugin.data carries the NEW state index.',
  'Keys in events are the key as placed (not the copy the plugin last drew with).',
  'A dynamic child key tap sends plugin.data {evt: "click", key, index, userData}.',
  'A directDraw key takes a whole page (2170×60); device.touch x/y are strip coordinates, states down → pressing… → up → end.',
  'setConfig does not echo plugin.config.updated (that event is for config-page edits).',
]

const clone = (value) => (value === undefined ? undefined : structuredClone(value))

/**
 * One simulated FlexDesigner with one Flexbar and one plugin.
 * Emits `change` (whole-state snapshot is cheap; the UI re-renders), `log`, `toast`, `frame`.
 */
export class Simulator extends EventEmitter {
  constructor({ pluginDir, stateDir, serialNumber = 'SIM0000000001', pluginPort = 0 }) {
    super()
    this.plugin = loadPlugin(pluginDir)
    this.serialNumber = serialNumber
    this.statePath = path.join(stateDir, `${this.plugin.uuid}.json`)
    this.device = { connected: true, sleeping: false, brightness: 100, config: {} }
    this.shortcuts = new Set(this.plugin.manifest.shortcuts ?? [])
    this.chart = []
    this.alive = new Set()
    this.logBacklog = []
    this.frames = new Map() // uid → Map(offsetX → data URL), latest direct-draw frames
    this.load()
    this.host = new PluginHost({
      uuid: this.plugin.uuid,
      dir: this.plugin.dir,
      entry: this.plugin.entry,
      port: pluginPort,
    })
    this.wireHost()
  }

  // ---------------------------------------------------------------- persistence

  load() {
    let saved = {}
    try {
      saved = JSON.parse(fs.readFileSync(this.statePath, 'utf8'))
    } catch {
      // first run
    }
    this.config = saved.config ?? {}
    this.pages = saved.pages ?? [{ id: 1, name: 'Page 1', uids: [] }]
    this.keys = new Map()
    for (const placed of saved.keys ?? []) {
      if (this.plugin.keys.some((def) => def.cid === placed.cid)) {
        this.keys.set(placed.uid, { ...placed, render: {} })
      }
    }
    for (const page of this.pages) {
      page.uids = page.uids.filter((uid) => this.keys.has(uid))
    }
    this.currentPage = this.pages.some((p) => p.id === saved.currentPage) ? saved.currentPage : this.pages[0].id
    this.nextUid = Math.max(-1, ...this.keys.keys()) + 1
    this.nextPageId = Math.max(0, ...this.pages.map((p) => p.id)) + 1
    if (this.keys.size === 0) {
      this.autoLayout()
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true })
    const keys = [...this.keys.values()].map(({ render: _render, ...placed }) => placed)
    const state = { config: this.config, pages: this.pages, currentPage: this.currentPage, keys }
    fs.writeFileSync(this.statePath, JSON.stringify(state, null, 2))
  }

  /** First run: every library key on page 1 (directDraw keys get their own page). */
  autoLayout() {
    for (const def of this.plugin.keys) {
      if (def.config.keyType === 'directDraw') {
        this.addPage(`${def.title}`, false)
      }
      this.placeKey(def.cid, { notify: false, pageId: def.config.keyType === 'directDraw' ? this.pages.at(-1).id : this.pages[0].id })
    }
    this.currentPage = this.pages[0].id
    this.save()
  }

  // ---------------------------------------------------------------- key model

  definition(cid) {
    return this.plugin.keys.find((def) => def.cid === cid)
  }

  /** The KeyData object FlexDesigner sends for a placed key (shape from the SDK types + example payloads). */
  keyData(uid) {
    const placed = this.keys.get(uid)
    const def = this.definition(placed.cid)
    const keyType = def.config.keyType ?? 'default'
    const width = placed.width
    const key = {
      pluginID: this.plugin.uuid,
      cid: placed.cid,
      uid,
      width,
      bg: 0,
      typeOverride: 'plugin',
      title: def.title,
      data: clone(placed.data),
      style: { ...DEFAULT_STYLE, ...clone(def.style), width },
      cfg: { keyType, sendKey: true },
    }
    if (keyType === 'default') {
      key.cfg.clickable = def.config.clickable ?? true
    }
    if (keyType === 'multiState') {
      key.cfg.multiState = { defaultState: 0 }
    }
    if (keyType === 'wheel') {
      key.wheel = { step: def.style.wheel?.step ?? 1 }
    }
    if (keyType === 'slider') {
      key.slider = clone(def.style.slider ?? {})
    }
    return key
  }

  page(id = this.currentPage) {
    return this.pages.find((p) => p.id === id)
  }

  placeKey(cid, { notify = true, pageId = this.currentPage } = {}) {
    const def = this.definition(cid)
    if (!def) {
      throw new Error(`Unknown cid ${cid}`)
    }
    const uid = this.nextUid++
    const width = def.config.keyType === 'directDraw' ? STRIP_WIDTH : def.style.width ?? DEFAULT_STYLE.width
    this.keys.set(uid, { uid, cid, width, data: clone(def.data) ?? {}, render: {} })
    this.page(pageId).uids.push(uid)
    if (notify) {
      this.save()
      if (pageId === this.currentPage) {
        this.makeAlive([uid])
      }
      this.changed()
    }
    return uid
  }

  removeKey(uid) {
    if (!this.keys.has(uid)) {
      return
    }
    this.makeDead([uid])
    for (const page of this.pages) {
      page.uids = page.uids.filter((u) => u !== uid)
    }
    this.keys.delete(uid)
    this.save()
    this.changed()
  }

  moveKey(uid, offset) {
    const page = this.pages.find((p) => p.uids.includes(uid))
    const from = page.uids.indexOf(uid)
    const to = Math.max(0, Math.min(page.uids.length - 1, from + offset))
    page.uids.splice(to, 0, ...page.uids.splice(from, 1))
    this.save()
    this.changed()
  }

  setKeyWidth(uid, width) {
    const placed = this.keys.get(uid)
    placed.width = Math.max(60, Math.min(STRIP_WIDTH, Math.round(width)))
    this.save()
    this.changed()
  }

  /** Stand-in for the per-key config UI: replace the key's `data` object. */
  setKeyData(uid, data) {
    const placed = this.keys.get(uid)
    placed.data = data
    this.save()
    // FlexDesigner reloads a key after its config changes; model that as dead + alive.
    if (this.alive.has(uid)) {
      this.makeDead([uid])
      this.makeAlive([uid])
    }
    this.changed()
  }

  addPage(name, switchTo = true) {
    const page = { id: this.nextPageId++, name: name || `Page ${this.nextPageId - 1}`, uids: [] }
    this.pages.push(page)
    if (switchTo) {
      this.switchPage(page.id)
    }
    return page
  }

  removePage(id) {
    if (this.pages.length === 1) {
      return
    }
    const page = this.page(id)
    if (id === this.currentPage) {
      this.switchPage(this.pages.find((p) => p.id !== id).id)
    }
    for (const uid of page.uids) {
      this.keys.delete(uid)
    }
    this.pages = this.pages.filter((p) => p.id !== id)
    this.save()
    this.changed()
  }

  switchPage(id) {
    if (!this.page(id) || id === this.currentPage) {
      return
    }
    this.makeDead([...this.alive])
    this.currentPage = id
    this.save()
    this.makeAlive(this.page().uids)
    this.changed()
  }

  // ---------------------------------------------------------------- lifecycle events to the plugin

  makeAlive(uids) {
    if (!this.device.connected || !this.host.ready || uids.length === 0) {
      return
    }
    uids.forEach((uid) => this.alive.add(uid))
    this.notify('plugin.alive', { serialNumber: this.serialNumber, keys: uids.map((uid) => this.keyData(uid)) })
  }

  makeDead(uids) {
    const dead = uids.filter((uid) => this.alive.has(uid))
    dead.forEach((uid) => this.alive.delete(uid))
    if (dead.length && this.host.ready) {
      this.notify('plugin.dead', { serialNumber: this.serialNumber, keys: dead.map((uid) => this.keyData(uid)) })
    }
  }

  deviceStatus() {
    return [
      {
        serialNumber: this.serialNumber,
        status: this.device.connected ? 'connected' : 'disconnected',
        deviceData: {
          platform: process.platform,
          profileVersion: '1.0.0',
          firmwareVersion: 'sim',
          deviceName: this.device.config.deviceName ?? 'Flexbar Simulator',
          displayName: 'Flexbar Simulator',
        },
      },
    ]
  }

  setDeviceConnected(connected) {
    if (connected === this.device.connected) {
      return
    }
    if (!connected) {
      this.makeDead([...this.alive])
      this.device.connected = false
      this.notify('device.status', this.deviceStatus())
    } else {
      this.device.connected = true
      this.notify('device.status', this.deviceStatus())
      this.makeAlive(this.page().uids)
    }
    this.changed()
  }

  /** Sends an event; logs failures; resolves with the plugin's return value (or undefined). */
  async notify(type, payload) {
    if (!this.host.ready) {
      return undefined
    }
    try {
      return await this.host.send(type, payload)
    } catch (error) {
      this.log('sim', `⚠ ${error.message}`)
      return undefined
    }
  }

  // ---------------------------------------------------------------- user input (from the UI)

  async tap(uid) {
    const placed = this.keys.get(uid)
    if (!placed || !this.alive.has(uid) || this.device.sleeping) {
      return
    }
    const key = this.keyData(uid)
    switch (key.cfg.keyType) {
      case 'default': {
        if (!key.cfg.clickable) {
          return
        }
        this.reportResult(await this.notify('plugin.data', { serialNumber: this.serialNumber, data: { evt: 'click', key } }))
        break
      }
      case 'multiState': {
        const states = Math.max(1, key.style.multiStyle?.length ?? 1)
        const current = placed.render.state ?? 0
        const state = (current + 1) % states
        placed.render.state = state
        this.changed()
        this.reportResult(await this.notify('plugin.data', { serialNumber: this.serialNumber, data: { state, key } }))
        break
      }
      default:
        break
    }
  }

  async slide(uid, value) {
    if (!this.alive.has(uid)) {
      return
    }
    this.keys.get(uid).render.value = value
    this.changed()
    await this.notify('plugin.data', { serialNumber: this.serialNumber, data: { value, key: this.keyData(uid) } })
  }

  async wheel(uid, state, delta) {
    if (!this.alive.has(uid)) {
      return
    }
    const data = state === 'rolling' ? { state, delta, key: this.keyData(uid) } : { state, key: this.keyData(uid) }
    await this.notify('plugin.data', { serialNumber: this.serialNumber, data })
  }

  async tapDynamicChild(uid, index) {
    const child = this.keys.get(uid)?.render.children?.[index]
    if (!child || !this.alive.has(uid)) {
      return
    }
    const data = { evt: 'click', key: this.keyData(uid), index, userData: clone(child.userData) }
    this.reportResult(await this.notify('plugin.data', { serialNumber: this.serialNumber, data }))
  }

  async touch(x, y, state) {
    await this.notify('device.touch', { serialNumber: this.serialNumber, x: Math.round(x), y: Math.round(y), state })
  }

  async uiMessage(payload) {
    const result = await this.notify('ui.message', payload)
    this.log('sim', `ui.message returned: ${JSON.stringify(result)}`)
    return result
  }

  async pressShortcut(shortcut) {
    await this.notify('system.shortcut', { shortcut })
  }

  async editConfig(config) {
    this.config = config
    this.save()
    await this.notify('plugin.config.updated', { config })
    this.changed()
  }

  reportResult(result) {
    if (result && typeof result === 'object' && result.message) {
      this.toast({ kind: 'designer', level: result.status === 'success' ? 'success' : 'info', msg: String(result.message) })
    } else if (typeof result === 'string' && result) {
      this.toast({ kind: 'designer', level: 'info', msg: result })
    }
  }

  // ---------------------------------------------------------------- plugin commands

  wireHost() {
    this.host.on('ready', () => {
      this.log('sim', `Plugin ${this.plugin.uuid} connected`)
      this.alive.clear()
      this.notify('device.status', this.deviceStatus())
      this.makeAlive(this.page().uids)
      this.changed()
    })
    this.host.on('exit', (code, signal) => {
      this.alive.clear()
      this.log('sim', `Plugin process exited (code ${code}${signal ? `, ${signal}` : ''})`)
      this.changed()
    })
    this.host.on('output', (stream, text) => this.log(stream, text.replace(/\n$/, '')))
    this.host.on('protocol', (direction, message) => this.emit('protocol', direction, message))
    this.host.on('command', (type, payload, reply) => {
      try {
        const result = this.handleCommand(type, payload)
        Promise.resolve(result).then(
          (value) => reply(value ?? null),
          (error) => reply.error(error.message),
        )
      } catch (error) {
        this.log('sim', `⚠ ${type}: ${error.message}`)
        reply.error(error.message)
      }
    })
  }

  /** Resolves the placed key a command refers to, with the checks a real host would trip over. */
  targetKey(payload, command) {
    if (payload.serialNumber !== this.serialNumber) {
      throw new Error(`unknown serialNumber '${payload.serialNumber}'`)
    }
    const uid = payload.key?.uid
    const placed = this.keys.get(uid)
    if (!placed) {
      throw new Error(`no key with uid ${uid}`)
    }
    if (!this.alive.has(uid)) {
      this.log('sim', `⚠ ${command} for key ${uid} (${placed.cid}) which is not alive. Real device behaviour unknown.`)
    }
    return placed
  }

  handleCommand(type, payload) {
    switch (type) {
      case 'draw': {
        const placed = this.targetKey(payload, type)
        if (payload.type === 'base64') {
          placed.render.image = payload.base64
        } else {
          placed.render.image = null
          placed.render.style = clone(payload.key.style)
          placed.render.title = payload.key.title
        }
        this.changed()
        return true
      }
      case 'set': {
        const placed = this.targetKey(payload, type)
        const data = payload.data ?? {}
        if ('state' in data) {
          placed.render.state = data.state
          if (data.message) {
            this.toast({ kind: 'device', level: 'info', msg: data.message })
          }
        }
        if ('value' in data) {
          placed.render.value = data.value
        }
        this.changed()
        return true
      }
      case 'direct-draw': {
        const placed = this.targetKey(payload, type)
        const offsetX = payload.offsetX ?? 0
        placed.render.frameCount = (placed.render.frameCount ?? 0) + 1
        if (!this.frames.has(placed.uid) || offsetX === 0) {
          this.frames.set(placed.uid, new Map())
        }
        this.frames.get(placed.uid).set(offsetX, payload.data)
        this.emit('frame', { uid: placed.uid, data: payload.data, offsetX, diffUpdate: !!payload.diffUpdate })
        return true
      }
      case 'dynamic-plugin':
        return this.dynamicKey(payload)
      case 'show-snackbar-message':
        if (payload.serialNumber !== this.serialNumber) {
          throw new Error(`unknown serialNumber '${payload.serialNumber}'`)
        }
        this.toast({ kind: 'device', level: payload.level, msg: payload.msg, icon: payload.icon, timeout: payload.timeout })
        return true
      case 'control-command':
        return this.controlCommand(payload)
      case 'device-config':
        Object.assign(this.device.config, payload.config)
        if (typeof payload.config?.brightness === 'number') {
          this.device.brightness = payload.config.brightness
        }
        this.log('sim', `device-config: ${JSON.stringify(payload.config)}`)
        this.changed()
        return true
      case 'update-shortcuts':
        for (const { shortcut, action } of payload.shortcuts ?? []) {
          action === 'unregister' ? this.shortcuts.delete(shortcut) : this.shortcuts.add(shortcut)
        }
        this.changed()
        return true
      case 'ui-operation':
        if (payload.type === 'showSnackbarMessage') {
          this.toast({ kind: 'designer', level: payload.data?.color, msg: payload.data?.message })
        }
        return true
      case 'custom-chart-data':
        this.chart = payload.data ?? []
        this.emit('chart', this.chart)
        return true
      case 'api-call':
        return this.apiCall(payload)
      default:
        throw new Error(`unknown command '${type}'`)
    }
  }

  dynamicKey(payload) {
    const placed = this.targetKey(payload, `dynamic-plugin ${payload.cmd}`)
    const children = (placed.render.children ??= [])
    const MAX_CHILDREN = 16
    switch (payload.cmd) {
      case 'clear':
        children.length = 0
        break
      case 'add': {
        if (children.length >= MAX_CHILDREN) {
          throw new Error(`a dynamic key holds at most ${MAX_CHILDREN} child keys`)
        }
        const width = payload.width
        if (width < 60 || width > 1000) {
          this.log('sim', `⚠ dynamic child width ${width} is outside 60–1000`)
        }
        const index = Math.max(0, Math.min(children.length, payload.index ?? children.length))
        children.splice(index, 0, {
          type: payload.backgroundType,
          content: clone(payload.backgroundData),
          width,
          userData: clone(payload.userData),
        })
        break
      }
      case 'remove':
        children.splice(payload.index, 1)
        break
      case 'move': {
        const [child] = children.splice(payload.srcIndex, 1)
        if (child) {
          children.splice(payload.dstIndex, 0, child)
        }
        break
      }
      case 'draw': {
        const child = children[payload.index]
        if (!child) {
          throw new Error(`no dynamic child at index ${payload.index}`)
        }
        Object.assign(child, { type: payload.backgroundType, content: clone(payload.backgroundData) })
        if (payload.width) {
          child.width = payload.width
        }
        break
      }
      case 'update': {
        const child = children[payload.index]
        if (!child) {
          throw new Error(`no dynamic child at index ${payload.index}`)
        }
        child.userData = clone(payload.userData)
        break
      }
      case 'set':
        if (payload.data?.width) {
          placed.width = payload.data.width
          this.save()
        }
        break
      case 'refresh':
        break
      default:
        throw new Error(`unknown dynamic-plugin cmd '${payload.cmd}'`)
    }
    this.changed()
    return true
  }

  controlCommand({ serialNumber, command }) {
    if (serialNumber !== this.serialNumber) {
      throw new Error(`unknown serialNumber '${serialNumber}'`)
    }
    switch (command) {
      case 'sys.sleep':
        this.device.sleeping = true
        break
      case 'sys.wake':
        this.device.sleeping = false
        break
      case 'hapic.click':
      case 'haptic.click':
        this.emit('haptic')
        break
      default:
        throw new Error(`unknown control command '${command}'`)
    }
    this.changed()
    return true
  }

  apiCall(payload) {
    const args = payload.args ?? {}
    switch (payload.api) {
      case 'getAppInfo':
        return { version: APP_VERSION, platform: process.platform }
      case 'getPluginConfig':
        return clone(this.config)
      case 'setPluginConfig':
        this.config = clone(payload.config) ?? {}
        this.save()
        this.changed()
        return true
      case 'getDeviceStatus':
        return this.deviceStatus()
      case 'getOpenedWindows':
        return []
      case 'openFile':
        return fs.readFileSync(args.path, 'utf8')
      case 'pluginSaveFile':
        fs.writeFileSync(args.path, args.data)
        return true
      case 'callElectronAPI':
        return this.electronApi(args.api, args.args ?? [])
      default:
        throw new Error(`unknown api '${payload.api}'`)
    }
  }

  electronApi(api, args) {
    const display = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 2 }
    switch (api) {
      case 'app.getAppPath':
        return process.cwd()
      case 'app.getPath': {
        const paths = { home: os.homedir(), temp: os.tmpdir(), desktop: path.join(os.homedir(), 'Desktop'), downloads: path.join(os.homedir(), 'Downloads') }
        return paths[args[0]] ?? os.tmpdir()
      }
      case 'screen.getCursorScreenPoint':
        return { x: 0, y: 0 }
      case 'screen.getPrimaryDisplay':
        return display
      case 'screen.getAllDisplays':
        return [display]
      default:
        throw new Error(`electron API '${api}' is not available in the simulator`)
    }
  }

  // ---------------------------------------------------------------- plugin process

  async start() {
    await this.host.listen()
    this.log('sim', `Plugin socket on ws://127.0.0.1:${this.host.port}`)
    this.host.launch()
  }

  async restartPlugin() {
    this.alive.clear()
    await this.host.stop()
    for (const placed of this.keys.values()) {
      placed.render = {}
    }
    this.frames.clear()
    this.host.launch()
    this.changed()
  }

  async shutdown() {
    await this.host.close()
  }

  // ---------------------------------------------------------------- output to the UI

  /** Latest direct-draw frames, oldest patch first, for a UI that just connected. */
  storedFrames() {
    return [...this.frames].flatMap(([uid, patches]) => [...patches].map(([offsetX, data]) => ({ uid, offsetX, data })))
  }

  log(stream, text) {
    const entry = { stream, text, ts: Date.now() }
    this.logBacklog.push(entry)
    if (this.logBacklog.length > 500) {
      this.logBacklog.shift()
    }
    this.emit('log', entry)
  }

  toast(toast) {
    this.emit('toast', toast)
  }

  changed() {
    this.emit('change')
  }

  snapshot() {
    return {
      plugin: {
        uuid: this.plugin.uuid,
        name: this.plugin.name,
        dir: this.plugin.dir,
        running: this.host.running,
        connected: this.host.ready,
      },
      strip: { width: STRIP_WIDTH, height: STRIP_HEIGHT },
      serialNumber: this.serialNumber,
      device: this.device,
      library: this.plugin.keys.map(({ cid, title, tip, group, config }) => ({ cid, title, tip, group, keyType: config.keyType ?? 'default' })),
      pages: this.pages,
      currentPage: this.currentPage,
      keys: Object.fromEntries(
        [...this.keys.values()].map((placed) => {
          const def = this.definition(placed.cid)
          return [
            placed.uid,
            {
              uid: placed.uid,
              cid: placed.cid,
              title: def.title,
              keyType: def.config.keyType ?? 'default',
              width: placed.width,
              data: placed.data,
              alive: this.alive.has(placed.uid),
              defaultStyle: { ...DEFAULT_STYLE, ...def.style, width: placed.width },
              slider: def.style.slider,
              render: placed.render,
            },
          ]
        }),
      ),
      config: this.config,
      shortcuts: [...this.shortcuts],
      assumptions: ASSUMPTIONS,
    }
  }
}
