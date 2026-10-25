// Fixture plugin: touches every key type and SDK call so the simulator can be checked end to end.
// It imports the real SDK (@eniac/flexdesigner) straight from the simulator's node_modules.
import zlib from 'node:zlib'
import { plugin, logger } from '@eniac/flexdesigner'

/** Solid-colour PNG as a data URL (no canvas dependency). Optional bar: {from, to, color}. */
function png(width, height, [r, g, b], bar) {
  const raw = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1)
    for (let x = 0; x < width; x++) {
      const inBar = bar && x >= bar.from && x < bar.to
      const [pr, pg, pb] = inBar ? bar.color : [r, g, b]
      raw[row + 1 + x * 3] = pr
      raw[row + 2 + x * 3] = pg
      raw[row + 3 + x * 3] = pb
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (buf) => {
    let c = 0xffffffff
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type), data])
    const sum = Buffer.alloc(4)
    sum.writeUInt32BE(crc(body))
    return Buffer.concat([len, body, sum])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const file = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
  return `data:image/png;base64,${file.toString('base64')}`
}

const alive = new Map() // uid → { serialNumber, key }
let counter = 0
let wheelTotal = 0

const byCid = (suffix) => [...alive.values()].filter(({ key }) => key.cid.endsWith(suffix))

async function drawCounter(serialNumber, key) {
  key.style.showIcon = false
  key.style.showTitle = true
  key.title = `${counter}`
  await plugin.draw(serialNumber, key, 'draw')
}

async function fillDynamic(serialNumber, key) {
  await plugin.dynamickey.clear(serialNumber, key)
  const colors = [[198, 40, 40], [46, 125, 50], [21, 101, 192], [249, 168, 37]]
  for (const [i, color] of colors.entries()) {
    await plugin.dynamickey.add(serialNumber, key, i, 'base64', png(110, 60, color), 110, { action: `child-${i}` })
  }
  await plugin.dynamickey.refresh(serialNumber, key)
}

function pttFrame(talking, x = 0) {
  return talking ? png(2170, 60, [180, 30, 30], { from: Math.max(0, x - 40), to: x + 40, color: [255, 255, 255] }) : png(2170, 60, [40, 40, 40])
}

// Handlers must not return the logger: `(x) => logger.info(x)` returns the winston instance, the SDK
// can't JSON-encode it as the reply, and the host never gets an answer.
plugin.on('device.status', (devices) => {
  logger.info('device.status', JSON.stringify(devices))
})

plugin.on('plugin.alive', async ({ serialNumber, keys }) => {
  logger.info(`plugin.alive: ${keys.map((k) => `${k.cid}#${k.uid}`).join(', ')}`)
  const config = (await plugin.getConfig()) ?? {}
  counter = config.counter ?? 0
  for (const key of keys) {
    alive.set(key.uid, { serialNumber, key })
    if (key.cid.endsWith('.counter')) await drawCounter(serialNumber, key)
    if (key.cid.endsWith('.toggle')) await plugin.setMultiState(serialNumber, key, 2, 'unknown')
    if (key.cid.endsWith('.slider')) await plugin.setSlider(serialNumber, key, 42)
    if (key.cid.endsWith('.dynamic')) await fillDynamic(serialNumber, key)
    if (key.cid.endsWith('.directdraw')) await plugin.directDraw(serialNumber, key, pttFrame(false))
  }
})

plugin.on('plugin.dead', ({ keys }) => {
  logger.info(`plugin.dead: ${keys.map((k) => `${k.cid}#${k.uid}`).join(', ')}`)
  keys.forEach((key) => alive.delete(key.uid))
})

plugin.on('plugin.data', async ({ serialNumber, data }) => {
  const key = data.key
  logger.info(`plugin.data ${key.cid}#${key.uid}: ${JSON.stringify({ ...data, key: undefined })}`)
  if (key.cid.endsWith('.counter')) {
    counter += Number(key.data.step ?? 1)
    await plugin.setConfig({ ...(await plugin.getConfig()), counter })
    for (const { serialNumber: sn, key: k } of byCid('.counter')) await drawCounter(sn, k)
  } else if (key.cid.endsWith('.toggle')) {
    return { status: 'success', message: `state ${data.state}` }
  } else if (key.cid.endsWith('.slider')) {
    logger.info(`slider → ${data.value}`)
  } else if (key.cid.endsWith('.wheel')) {
    if (data.state === 'rolling') wheelTotal += data.delta
    const shade = Math.max(0, Math.min(255, 128 + wheelTotal * 8))
    await plugin.draw(serialNumber, key, 'base64', png(key.width, 60, [shade, 60, 255 - shade]))
  } else if (key.cid.endsWith('.snackbar')) {
    await plugin.showFlexbarSnackbarMessage(serialNumber, 'Hello from the simulator test', 'success', 'ok', 2000)
    await plugin.sendControlCommand(serialNumber, 'hapic.click')
  } else if (key.cid.endsWith('.dynamic')) {
    await plugin.showFlexbarSnackbarMessage(serialNumber, `child ${data.index}: ${data.userData?.action}`, 'info', 'bell', 1500)
  }
})

plugin.on('device.touch', async ({ serialNumber, x, state }) => {
  logger.info(`device.touch ${state} x=${x}`)
  for (const { key } of byCid('.directdraw')) {
    await plugin.directDraw(serialNumber, key, pttFrame(state === 'down' || state === 'pressing', x))
  }
})

plugin.on('ui.message', async (payload) => {
  logger.info('ui.message', JSON.stringify(payload))
  if (payload?.data === 'test') {
    return { appInfo: await plugin.getAppInfo(), devices: await plugin.getDeviceStatus(), config: await plugin.getConfig() }
  }
  return 'pong'
})

plugin.on('system.shortcut', ({ shortcut }) => {
  logger.info(`shortcut ${shortcut}`)
})
plugin.on('plugin.config.updated', (payload) => {
  logger.info('config updated', JSON.stringify(payload))
})

plugin.start()
logger.info('Simulator test plugin started')
