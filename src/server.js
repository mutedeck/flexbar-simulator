import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'

const UI_DIR = fileURLToPath(new URL('../ui/', import.meta.url))
const MDI_DIR = path.join(path.dirname(createRequire(import.meta.url).resolve('@mdi/font/package.json')))

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.svg': 'image/svg+xml',
}

/** Shortens data URLs and long strings so the protocol log stays readable. */
function summarize(value, depth = 0) {
  if (typeof value === 'string') {
    if (value.startsWith('data:')) {
      return `${value.slice(0, 32)}… (${value.length} chars)`
    }
    return value.length > 300 ? `${value.slice(0, 300)}… (${value.length} chars)` : value
  }
  if (Array.isArray(value)) {
    return value.map((item) => summarize(item, depth + 1))
  }
  if (value && typeof value === 'object') {
    if (depth > 6) {
      return '…'
    }
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, summarize(v, depth + 1)]))
  }
  return value
}

function serveFile(res, root, relative) {
  const file = path.normalize(path.join(root, relative))
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end('not found')
    return
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' })
  fs.createReadStream(file).pipe(res)
}

/** HTTP + WebSocket server for the browser UI. Binds to localhost only. */
export async function startUiServer(sim, { port = 4790 } = {}) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    if (url.pathname.startsWith('/mdi/')) {
      serveFile(res, MDI_DIR, url.pathname.slice('/mdi/'.length))
    } else {
      serveFile(res, UI_DIR, url.pathname === '/' ? 'index.html' : url.pathname.slice(1))
    }
  })
  const wss = new WebSocketServer({ server, path: '/ui' })
  const broadcast = (message) => {
    const text = JSON.stringify(message)
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) {
        client.send(text)
      }
    }
  }

  let pending = null
  sim.on('change', () => {
    pending ??= setTimeout(() => {
      pending = null
      broadcast({ t: 'state', state: sim.snapshot() })
    }, 16)
  })
  // eslint-disable-next-line no-control-regex
  const ANSI = /\x1b\[[0-9;]*m/g
  sim.on('log', (entry) => broadcast({ t: 'log', ...entry, text: entry.text.replace(ANSI, '') }))
  sim.on('toast', (toast) => broadcast({ t: 'toast', ...toast }))
  sim.on('frame', (frame) => broadcast({ t: 'frame', ...frame }))
  sim.on('haptic', () => broadcast({ t: 'haptic' }))
  sim.on('chart', (data) => broadcast({ t: 'chart', data }))
  sim.on('protocol', (direction, message) => broadcast({ t: 'protocol', direction, message: summarize(message), ts: Date.now() }))

  wss.on('connection', (socket) => {
    socket.send(JSON.stringify({ t: 'state', state: sim.snapshot() }))
    for (const entry of sim.logBacklog) {
      socket.send(JSON.stringify({ t: 'log', ...entry, text: entry.text.replace(ANSI, '') }))
    }
    for (const frame of sim.storedFrames()) {
      socket.send(JSON.stringify({ t: 'frame', ...frame }))
    }
    socket.on('message', async (raw) => {
      let op
      try {
        op = JSON.parse(raw.toString())
        await handle(sim, op)
      } catch (error) {
        sim.log('sim', `⚠ UI action ${op?.op ?? '?'} failed: ${error.message}`)
      }
    })
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  return { url: `http://localhost:${server.address().port}`, close: () => new Promise((resolve) => { wss.close(); server.close(resolve) }) }
}

async function handle(sim, op) {
  switch (op.op) {
    case 'tap':
      return sim.tap(op.uid)
    case 'slide':
      return sim.slide(op.uid, op.value)
    case 'wheel':
      return sim.wheel(op.uid, op.state, op.delta)
    case 'dynTap':
      return sim.tapDynamicChild(op.uid, op.index)
    case 'touch':
      return sim.touch(op.x, op.y, op.state)
    case 'addKey':
      return sim.placeKey(op.cid)
    case 'removeKey':
      return sim.removeKey(op.uid)
    case 'moveKey':
      return sim.moveKey(op.uid, op.offset)
    case 'setWidth':
      return sim.setKeyWidth(op.uid, op.width)
    case 'setKeyData':
      return sim.setKeyData(op.uid, op.data)
    case 'addPage':
      return sim.addPage(op.name)
    case 'removePage':
      return sim.removePage(op.id)
    case 'switchPage':
      return sim.switchPage(op.id)
    case 'device':
      return sim.setDeviceConnected(op.connected)
    case 'uiMessage':
      return sim.uiMessage(op.payload)
    case 'shortcut':
      return sim.pressShortcut(op.shortcut)
    case 'editConfig':
      return sim.editConfig(op.config)
    case 'restart':
      return sim.restartPlugin()
    default:
      throw new Error(`unknown op '${op.op}'`)
  }
}
