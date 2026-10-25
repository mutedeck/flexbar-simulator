// Flexbar Simulator browser UI. Talks to the simulator over ws://<host>/ui.

const $ = (id) => document.getElementById(id)
const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v
    else if (k === 'style') Object.assign(node.style, v)
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v)
    else node.setAttribute(k, v)
  }
  for (const child of children.flat()) {
    if (child != null) node.append(child)
  }
  return node
}

/** Snackbar icon names from the SDK, mapped to MDI. */
const SNACK_ICONS = {
  audio: 'volume-high', video: 'video', list: 'format-list-bulleted', ok: 'check', close: 'close', power: 'power',
  settings: 'cog', home: 'home', download: 'download', refresh: 'refresh', mute: 'volume-off', volume_mid: 'volume-medium',
  volume_max: 'volume-high', image: 'image', play: 'play', pause: 'pause', stop: 'stop', next: 'skip-next', prev: 'skip-previous',
  plus: 'plus', minus: 'minus', eye_open: 'eye', eye_close: 'eye-off', warning: 'alert', call: 'phone', bell: 'bell',
  keyboard: 'keyboard', wifi: 'wifi', bluetooth: 'bluetooth', trash: 'delete', edit: 'pencil', save: 'content-save',
  envelope: 'email', file: 'file', usb: 'usb', up: 'chevron-up', down: 'chevron-down', left: 'chevron-left', right: 'chevron-right',
}

let state = null
let socket = null
let selectedUid = null
let interacting = 0 // > 0 while a pointer gesture is active; strip re-render waits until it ends
let pendingRender = false
const canvases = new Map() // uid → persistent <canvas> for directDraw keys
const imageCache = new Map()
const queuedFrames = new Map() // uid → frames that arrived before the canvas existed

// ------------------------------------------------------------------ connection

function connect() {
  socket = new WebSocket(`ws://${location.host}/ui`)
  socket.onopen = () => setPill('pill-ui', true, 'UI')
  socket.onclose = () => {
    setPill('pill-ui', false, 'UI disconnected')
    setTimeout(connect, 1000)
  }
  socket.onmessage = (event) => receive(JSON.parse(event.data))
}

function send(op) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(op))
  }
}

function receive(message) {
  switch (message.t) {
    case 'state':
      state = message.state
      renderAll()
      break
    case 'log':
      appendLog(message)
      break
    case 'protocol':
      appendProtocol(message)
      break
    case 'toast':
      message.kind === 'device' ? deviceSnackbar(message) : designerToast(message)
      break
    case 'frame':
      drawFrame(message)
      break
    case 'haptic': {
      const frame = $('device-frame')
      frame.classList.remove('shake')
      void frame.offsetWidth
      frame.classList.add('shake')
      break
    }
    case 'chart':
      $('chart').textContent = JSON.stringify(message.data, null, 2)
      break
  }
}

// ------------------------------------------------------------------ rendering

function setPill(id, on, text) {
  const pill = $(id)
  pill.className = `pill ${on ? 'on' : 'off'}`
  pill.textContent = text
}

function renderAll() {
  $('plugin-name').textContent = `${state.plugin.name} · ${state.plugin.uuid}`
  setPill('pill-plugin', state.plugin.connected, state.plugin.connected ? 'plugin connected' : state.plugin.running ? 'plugin starting…' : 'plugin stopped')
  setPill('pill-device', state.device.connected, state.device.connected ? `${state.serialNumber}` : 'device unplugged')
  $('btn-device').querySelector('span').textContent = state.device.connected ? 'Unplug' : 'Plug in'
  renderPages()
  renderStripSoon()
  renderLibrary()
  renderInspector()
  renderTools()
}

function renderStripSoon() {
  if (interacting > 0) {
    pendingRender = true
    return
  }
  renderStrip()
}

function renderPages() {
  const pages = $('pages')
  pages.replaceChildren(
    ...state.pages.map((page) =>
      el('button', { class: page.id === state.currentPage ? 'active' : '', onclick: () => send({ op: 'switchPage', id: page.id }) },
        `${page.name} (${page.uids.length})`,
        state.pages.length > 1
          ? el('span', { class: 'page-remove', title: 'Remove page', onclick: (e) => { e.stopPropagation(); send({ op: 'removePage', id: page.id }) } }, '×')
          : null),
    ),
    el('button', { onclick: () => send({ op: 'addPage', name: `Page ${state.pages.length + 1}` }) }, '+ page'),
  )
}

function fitStrip() {
  const viewport = $('strip-viewport')
  const scale = viewport.clientWidth / state.strip.width
  viewport.style.height = `${state.strip.height * scale}px`
  $('strip').style.transform = `scale(${scale})`
  return scale
}

function renderStrip() {
  pendingRender = false
  const strip = $('strip')
  strip.className = `strip${state.device.sleeping ? ' sleeping' : ''}`
  strip.style.opacity = state.device.connected ? String(0.3 + 0.7 * (state.device.brightness / 100)) : '0.15'
  fitStrip()
  const page = state.pages.find((p) => p.id === state.currentPage)
  const nodes = []
  let x = 0
  let overflowAt = null
  for (const uid of page.uids) {
    const key = state.keys[uid]
    if (x + key.width > state.strip.width && overflowAt === null) overflowAt = x
    x += key.width
    nodes.push(renderKey(key))
  }
  if (overflowAt !== null) nodes.push(el('div', { class: 'overflow-mark', style: { left: `${overflowAt}px` }, title: 'Keys past this line do not fit on the device' }))
  strip.replaceChildren(...nodes)

  $('strip-meta').replaceChildren(
    el('span', {}, `${x}/${state.strip.width}px used`),
    ...page.uids.map((uid) => {
      const key = state.keys[uid]
      return el('span', {
        class: `chip${uid === selectedUid ? ' selected' : ''}${key.alive ? '' : ' dead'}`,
        title: key.alive ? 'alive' : 'not alive',
        onclick: () => { selectedUid = uid; renderAll() },
      }, `#${uid} ${key.title}`)
    }),
  )
}

/** Paints a FlexDesigner KeyStyle (+ title) into a node. */
function paintStyle(node, style, title) {
  node.style.background = style.bgColor || '#424242'
  if (style.borderStyle && style.borderStyle !== 'none') {
    node.style.border = `${style.borderWidth ?? 1}px ${style.borderStyle === '3d' ? 'outset' : style.borderStyle} ${style.borderColor}`
  }
  const shadow = style.foregroundOutline ? '0 0 3px #000, 0 0 2px #000' : 'none'
  if (style.showImage && style.image) {
    node.append(el('img', { class: 'full-image', src: style.image }))
  }
  if (style.showIcon !== false && style.icon) {
    const pos = { left: `${style.iconPos?.X ?? 50}%`, top: `${style.iconPos?.Y ?? 50}%` }
    const rotate = style.iconRotate ? ` rotate(${style.iconRotate}deg)` : ''
    if (style.icon.startsWith('data:')) {
      node.append(el('img', { class: 'icon', src: style.icon, style: { ...pos, height: `${style.iconSize ?? 42}px`, transform: `translate(-50%,-50%)${rotate}` } }))
    } else {
      node.append(el('i', { class: `icon ${style.icon}`, style: { ...pos, fontSize: `${style.iconSize ?? 42}px`, color: style.fgColor, textShadow: shadow, transform: `translate(-50%,-50%)${rotate}` } }))
    }
  }
  if (style.showEmoji && style.emoji) {
    node.append(el('span', { class: 'emoji', style: { left: `${style.iconPos?.X ?? 50}%`, top: `${style.iconPos?.Y ?? 50}%`, fontSize: `${style.iconSize ?? 42}px` } }, style.emoji))
  }
  if (style.showTitle && title) {
    node.append(el('span', {
      class: 'title',
      style: {
        left: `${style.titlePos?.X ?? 50}%`, top: `${style.titlePos?.Y ?? 50}%`, fontSize: `${style.fontSize ?? 24}px`,
        color: style.fgColor, fontFamily: style.font || 'inherit', textShadow: shadow,
        transform: `translate(-50%,-50%)${style.titleRotate ? ` rotate(${style.titleRotate}deg)` : ''}`,
      },
    }, title))
  }
}

function renderKey(key) {
  const node = el('div', {
    class: `key ${key.keyType.toLowerCase()}${key.alive ? '' : ' dead'}${key.uid === selectedUid ? ' selected' : ''}`,
    style: { width: `${key.width}px` },
    'data-uid': key.uid,
  })
  const r = key.render ?? {}
  switch (key.keyType) {
    case 'default':
      if (r.image) node.append(el('img', { class: 'full-image', src: r.image }))
      else paintStyle(node, r.style ?? key.defaultStyle, r.title ?? '')
      node.classList.add('clickable')
      node.addEventListener('click', () => send({ op: 'tap', uid: key.uid }))
      break
    case 'multiState': {
      const index = r.state ?? 0
      const states = key.defaultStyle.multiStyle ?? []
      paintStyle(node, { ...key.defaultStyle, ...(r.style ?? {}), ...(states[index] ?? {}) }, r.title ?? '')
      node.append(el('span', { class: 'state-msg' }, `state ${index}/${Math.max(states.length - 1, 0)}`))
      node.classList.add('clickable')
      node.addEventListener('click', () => send({ op: 'tap', uid: key.uid }))
      break
    }
    case 'slider':
      renderSlider(node, key, r)
      break
    case 'wheel':
      paintStyle(node, r.style ?? key.defaultStyle, r.title ?? '')
      if (r.image) node.append(el('img', { class: 'full-image', src: r.image }))
      bindWheel(node, key)
      break
    case 'dynamic':
      renderDynamic(node, key, r)
      break
    case 'directDraw':
      node.append(directDrawCanvas(key))
      break
    default:
      paintStyle(node, key.defaultStyle, key.title)
  }
  node.append(el('span', { class: 'badge' }, `#${key.uid}`))
  node.addEventListener('contextmenu', (e) => { e.preventDefault(); selectedUid = key.uid; renderAll() })
  return node
}

/** Tiny C-style formatter for slider.format ("%0.1f %%", "%d"). */
function formatValue(format, value, decimals = 0) {
  if (!format) return value.toFixed(decimals)
  return format.replace(/%(-?\d*)(?:\.(\d+))?([dfi%])/g, (_, _w, precision, type) => {
    if (type === '%') return '%'
    if (type === 'd' || type === 'i') return String(Math.round(value))
    return value.toFixed(precision !== undefined ? Number(precision) : decimals)
  })
}

function renderSlider(node, key, r) {
  const cfg = key.slider ?? {}
  const min = cfg.min ?? 0
  const max = cfg.max ?? 100
  const value = r.value ?? min
  paintStyle(node, { ...key.defaultStyle, showIcon: false }, '')
  const track = el('div', { class: 'track', style: { width: `${Math.min(cfg.width ?? key.width - 40, key.width - 10)}px` } })
  const fill = el('div', { class: 'fill', style: { background: cfg.color ?? '#fff', width: `${((value - min) / (max - min || 1)) * 100}%` } })
  const label = el('span', { class: 'value' }, formatValue(cfg.format, value, cfg.decimals ?? 0))
  track.append(fill)
  node.append(track, label)

  let last = 0
  const update = (event, final) => {
    const rect = track.getBoundingClientRect()
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width))
    const decimals = cfg.decimals ?? 0
    const v = Number((min + ratio * (max - min)).toFixed(decimals))
    fill.style.width = `${ratio * 100}%`
    label.textContent = formatValue(cfg.format, v, decimals)
    const now = performance.now()
    if (final || now - last > 33) {
      last = now
      send({ op: 'slide', uid: key.uid, value: v })
    }
  }
  track.addEventListener('pointerdown', (e) => {
    track.setPointerCapture(e.pointerId)
    interacting++
    update(e)
    const move = (ev) => update(ev)
    const up = (ev) => {
      update(ev, true)
      track.removeEventListener('pointermove', move)
      track.removeEventListener('pointerup', up)
      endInteraction()
    }
    track.addEventListener('pointermove', move)
    track.addEventListener('pointerup', up)
  })
}

/** Wheel keys: drag sideways (like a finger on the strip) or use the mouse wheel. */
function bindWheel(node, key) {
  const step = 12 // px of drag per "rolling" tick
  node.addEventListener('pointerdown', (e) => {
    node.setPointerCapture(e.pointerId)
    interacting++
    send({ op: 'wheel', uid: key.uid, state: 'start' })
    let anchor = e.clientX
    const move = (ev) => {
      const ticks = Math.trunc((ev.clientX - anchor) / step)
      if (ticks !== 0) {
        anchor += ticks * step
        send({ op: 'wheel', uid: key.uid, state: 'rolling', delta: ticks })
      }
    }
    const up = () => {
      send({ op: 'wheel', uid: key.uid, state: 'end' })
      node.removeEventListener('pointermove', move)
      node.removeEventListener('pointerup', up)
      endInteraction()
    }
    node.addEventListener('pointermove', move)
    node.addEventListener('pointerup', up)
  })
  let wheelTimer = null
  node.addEventListener('wheel', (e) => {
    e.preventDefault()
    if (!wheelTimer) send({ op: 'wheel', uid: key.uid, state: 'start' })
    clearTimeout(wheelTimer)
    send({ op: 'wheel', uid: key.uid, state: 'rolling', delta: Math.sign(e.deltaY || e.deltaX) })
    wheelTimer = setTimeout(() => { wheelTimer = null; send({ op: 'wheel', uid: key.uid, state: 'end' }) }, 300)
  }, { passive: false })
}

function renderDynamic(node, key, r) {
  const children = r.children ?? []
  if (children.length === 0) {
    node.style.background = '#1b1b1b'
    node.append(el('span', { class: 'empty-dyn' }, 'dynamic key (no children)'))
    return
  }
  children.forEach((child, index) => {
    const childNode = el('div', { class: 'child', style: { width: `${child.width}px` }, title: JSON.stringify(child.userData), onclick: () => send({ op: 'dynTap', uid: key.uid, index }) })
    if (child.type === 'base64') {
      childNode.append(el('img', { src: child.content }))
    } else {
      // 'draw': an object describing the key (style + title), like plugin.draw
      const content = child.content ?? {}
      paintStyle(childNode, { ...key.defaultStyle, ...(content.style ?? content), width: child.width }, content.title ?? '')
    }
    node.append(childNode)
  })
}

function directDrawCanvas(key) {
  let canvas = canvases.get(key.uid)
  if (!canvas) {
    canvas = el('canvas', { width: String(key.width), height: '60' })
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.fillStyle = '#555'
    ctx.font = '16px system-ui'
    ctx.fillText('Direct Draw: waiting for frames…', 12, 36)
    bindTouch(canvas)
    canvases.set(key.uid, canvas)
    for (const frame of queuedFrames.get(key.uid) ?? []) drawFrame(frame)
    queuedFrames.delete(key.uid)
  }
  return canvas
}

function bindTouch(canvas) {
  const point = (e) => {
    const rect = canvas.getBoundingClientRect()
    return { x: ((e.clientX - rect.left) / rect.width) * canvas.width, y: ((e.clientY - rect.top) / rect.height) * 60 }
  }
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId)
    interacting++
    send({ op: 'touch', ...point(e), state: 'down' })
    let last = 0
    const move = (ev) => {
      const now = performance.now()
      if (now - last > 30) {
        last = now
        send({ op: 'touch', ...point(ev), state: 'pressing' })
      }
    }
    const up = (ev) => {
      const p = point(ev)
      send({ op: 'touch', ...p, state: 'up' })
      send({ op: 'touch', ...p, state: 'end' })
      canvas.removeEventListener('pointermove', move)
      canvas.removeEventListener('pointerup', up)
      endInteraction()
    }
    canvas.addEventListener('pointermove', move)
    canvas.addEventListener('pointerup', up)
  })
}

function drawFrame({ uid, data, offsetX }) {
  const canvas = canvases.get(uid)
  if (!data) return
  if (!canvas) {
    const queue = queuedFrames.get(uid) ?? []
    if (offsetX === 0) queue.length = 0
    queue.push({ uid, data, offsetX })
    queuedFrames.set(uid, queue)
    return
  }
  let image = imageCache.get(data)
  const paint = () => canvas.getContext('2d').drawImage(image, offsetX, 0)
  if (image?.complete) return paint()
  image = new Image()
  image.onload = paint
  image.src = data
  if (imageCache.size > 50) imageCache.clear()
  imageCache.set(data, image)
}

function endInteraction() {
  interacting = Math.max(0, interacting - 1)
  if (interacting === 0 && pendingRender) renderStrip()
}

function renderLibrary() {
  const nodes = []
  let group = null
  for (const item of state.library) {
    if (item.group !== group) {
      group = item.group
      if (group) nodes.push(el('div', { class: 'lib-group' }, group))
    }
    nodes.push(el('button', { class: 'lib-item', title: `${item.cid}\n${item.tip}`, onclick: () => send({ op: 'addKey', cid: item.cid }) },
      el('i', { class: 'mdi mdi-plus' }), item.title, el('span', { class: 'type' }, item.keyType)))
  }
  $('library').replaceChildren(...nodes)
}

function renderInspector() {
  const key = state.keys[selectedUid]
  const box = $('inspector')
  if (!key) {
    selectedUid = null
    box.className = 'inspector empty'
    box.textContent = 'Click a chip under the strip (or right-click a key) to inspect it.'
    $('inspector-sub').textContent = 'select a key'
    return
  }
  // Don't clobber the data editor while the user is typing in it.
  if (box.contains(document.activeElement) && document.activeElement.tagName === 'TEXTAREA') return
  box.className = 'inspector'
  $('inspector-sub').textContent = `#${key.uid}`
  const dataArea = el('textarea', { spellcheck: 'false' })
  dataArea.value = JSON.stringify(key.data, null, 2)
  const width = el('input', { type: 'number', value: String(key.width), min: '60', max: '2170', step: '10' })
  box.replaceChildren(
    el('dl', {},
      el('dt', {}, 'cid'), el('dd', {}, key.cid),
      el('dt', {}, 'type'), el('dd', {}, key.keyType),
      el('dt', {}, 'alive'), el('dd', {}, String(key.alive)),
      el('dt', {}, 'render'), el('dd', {}, summarizeRender(key.render))),
    el('div', { class: 'row' },
      el('button', { onclick: () => send({ op: 'moveKey', uid: key.uid, offset: -1 }) }, '◀'),
      el('button', { onclick: () => send({ op: 'moveKey', uid: key.uid, offset: 1 }) }, '▶'),
      'width', width,
      el('button', { onclick: () => send({ op: 'setWidth', uid: key.uid, width: Number(width.value) }) }, 'Set'),
      el('button', { onclick: () => { send({ op: 'removeKey', uid: key.uid }); selectedUid = null } }, el('i', { class: 'mdi mdi-delete' }), ' Remove')),
    el('h3', {}, 'key.data ', el('small', {}, 'what the per-key config page edits; Apply reloads the key')),
    dataArea,
    el('div', { class: 'row' }, el('button', {
      onclick: () => {
        try {
          send({ op: 'setKeyData', uid: key.uid, data: JSON.parse(dataArea.value) })
          dataArea.blur()
        } catch (error) {
          designerToast({ level: 'error', msg: `Invalid JSON: ${error.message}` })
        }
      },
    }, 'Apply')),
  )
}

function summarizeRender(render = {}) {
  const parts = []
  if (render.image) parts.push('base64 image')
  if (render.style) parts.push('style draw')
  if (render.title) parts.push(`title "${render.title}"`)
  if (render.state !== undefined) parts.push(`state ${render.state}`)
  if (render.value !== undefined) parts.push(`value ${render.value}`)
  if (render.children) parts.push(`${render.children.length} children`)
  if (render.frameCount) parts.push(`${render.frameCount} frames`)
  return parts.join(', ') || '(default)'
}

function renderTools() {
  const config = $('config')
  if (document.activeElement !== config) config.value = JSON.stringify(state.config, null, 2)
  $('shortcuts').replaceChildren(...(state.shortcuts.length
    ? state.shortcuts.map((s) => el('button', { onclick: () => send({ op: 'shortcut', shortcut: s }) }, s))
    : [el('span', { class: 'muted' }, 'none')]))
  $('assumptions').replaceChildren(...state.assumptions.map((a) => el('li', {}, a)))
}

// ------------------------------------------------------------------ log, protocol, toasts

function appendLog({ stream, text, ts }) {
  const log = $('log')
  const time = new Date(ts).toLocaleTimeString()
  log.append(el('span', { class: stream }, el('span', { class: 'ts' }, `${time} `), `[${stream}] ${text}\n`))
  while (log.childNodes.length > 2000) log.firstChild.remove()
  if ($('log-autoscroll').checked) log.scrollTop = log.scrollHeight
}

function appendProtocol({ direction, message, ts }) {
  if (direction === 'out-response' && !$('proto-responses').checked) return
  if (direction === 'in' && message.type === 'response' && !$('proto-responses').checked) return
  if (message.type === 'direct-draw' && !$('proto-frames').checked) return
  const filter = $('proto-filter').value.trim()
  if (filter && !String(message.type).includes(filter)) return
  const arrow = direction === 'in' ? 'plugin → host' : 'host → plugin'
  const box = $('protocol')
  const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 4
  box.append(el('details', {},
    el('summary', { class: `dir-${direction}` }, `${new Date(ts).toLocaleTimeString()}  ${arrow}  ${message.type}${message.status ? ` (${message.status})` : ''}`),
    el('pre', {}, JSON.stringify(message.payload ?? message, null, 2))))
  while (box.childNodes.length > 1000) box.firstChild.remove()
  if (atBottom) box.scrollTop = box.scrollHeight
}

let snackTimer = null
function deviceSnackbar({ level = 'info', msg, icon, timeout = 2000 }) {
  const bar = $('device-snackbar')
  bar.className = `snackbar ${level}`
  bar.replaceChildren(el('i', { class: `mdi mdi-${SNACK_ICONS[icon] ?? 'information'}` }), msg)
  bar.hidden = false
  clearTimeout(snackTimer)
  snackTimer = setTimeout(() => { bar.hidden = true }, timeout)
}

function designerToast({ level = 'info', msg }) {
  const toast = el('div', { class: `toast ${level}` }, el('small', {}, 'FlexDesigner'), msg)
  $('toasts').append(toast)
  setTimeout(() => toast.remove(), 3500)
}

// ------------------------------------------------------------------ wiring

$('btn-restart').addEventListener('click', () => {
  canvases.clear()
  send({ op: 'restart' })
})
$('btn-device').addEventListener('click', () => send({ op: 'device', connected: !state.device.connected }))
$('log-clear').addEventListener('click', () => $('log').replaceChildren())
$('proto-clear').addEventListener('click', () => $('protocol').replaceChildren())
$('ui-message-send').addEventListener('click', () => {
  try {
    send({ op: 'uiMessage', payload: JSON.parse($('ui-message').value) })
    $('ui-message-result').textContent = 'sent (result in Log)'
  } catch (error) {
    $('ui-message-result').textContent = `invalid JSON: ${error.message}`
  }
})
$('config-save').addEventListener('click', () => {
  try {
    send({ op: 'editConfig', config: JSON.parse($('config').value) })
    $('config').blur()
  } catch (error) {
    designerToast({ level: 'error', msg: `Invalid JSON: ${error.message}` })
  }
})
for (const button of $('tabs').querySelectorAll('button')) {
  button.addEventListener('click', () => {
    for (const b of $('tabs').querySelectorAll('button')) b.classList.toggle('active', b === button)
    for (const tab of document.querySelectorAll('.tab')) tab.hidden = tab.dataset.tab !== button.dataset.tab
  })
}
window.addEventListener('resize', () => state && fitStrip())

connect()
