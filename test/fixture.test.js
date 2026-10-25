import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { Simulator } from '../src/simulator.js'

const FIXTURE = fileURLToPath(new URL('../fixtures/test-plugin/com.mutedeck.simtest.plugin', import.meta.url))

let sim
let stateDir
const toasts = []
const frames = []

async function waitFor(predicate, what, timeoutMs = 4000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const value = predicate()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.fail(`timed out waiting for ${what}`)
}

const keyByCid = (suffix) => [...sim.keys.values()].find((k) => k.cid.endsWith(suffix))

before(async () => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flexbar-sim-test-'))
  sim = new Simulator({ pluginDir: FIXTURE, stateDir })
  sim.on('toast', (t) => toasts.push(t))
  sim.on('frame', (f) => frames.push(f))
  await sim.start()
  await waitFor(() => keyByCid('.counter')?.render.title === '0', 'counter drawn on alive')
})

after(async () => {
  await sim?.shutdown()
  fs.rmSync(stateDir, { recursive: true, force: true })
})

test('first run lays out every library key; directDraw gets its own page', () => {
  assert.equal(sim.pages.length, 2)
  assert.equal(sim.pages[0].uids.length, 6)
  assert.equal(sim.keys.get(sim.pages[1].uids[0]).cid, 'com.mutedeck.simtest.directdraw')
  assert.equal(sim.alive.size, 6, 'only page 1 keys are alive')
})

test('alive handlers ran: setMultiState, setSlider, dynamic children', async () => {
  await waitFor(() => keyByCid('.dynamic').render.children?.length === 4, 'dynamic children')
  assert.equal(keyByCid('.toggle').render.state, 2)
  assert.equal(keyByCid('.slider').render.value, 42)
})

test('tap on a default key reaches plugin.data and persists through setConfig', async () => {
  await sim.tap(keyByCid('.counter').uid)
  await waitFor(() => keyByCid('.counter').render.title === '1', 'counter redraw')
  assert.equal(sim.config.counter, 1)
})

test('multiState tap advances locally and the return message is shown', async () => {
  await sim.tap(keyByCid('.toggle').uid)
  assert.equal(keyByCid('.toggle').render.state, 0)
  await waitFor(() => toasts.some((t) => t.msg === 'state 0'), 'toggle return message')
})

test('wheel rolling redraws with base64', async () => {
  const uid = keyByCid('.wheel').uid
  await sim.wheel(uid, 'start')
  await sim.wheel(uid, 'rolling', 3)
  await sim.wheel(uid, 'end')
  await waitFor(() => keyByCid('.wheel').render.image?.startsWith('data:image/png'), 'wheel image')
})

test('dynamic child tap carries index and userData', async () => {
  await sim.tapDynamicChild(keyByCid('.dynamic').uid, 1)
  await waitFor(() => toasts.some((t) => t.kind === 'device' && t.msg === 'child 1: child-1'), 'dynamic child snackbar')
})

test('page switch kills old keys, wakes new ones; touch drives direct draw', async () => {
  const ddUid = keyByCid('.directdraw').uid
  sim.switchPage(sim.pages[1].id)
  assert.deepEqual([...sim.alive], [ddUid])
  await waitFor(() => frames.some((f) => f.uid === ddUid), 'initial direct draw frame')
  const before = frames.length
  await sim.touch(500, 30, 'down')
  await waitFor(() => frames.length > before, 'frame after touch')
  sim.switchPage(sim.pages[0].id)
})

test('unknown serial numbers are rejected like a real host would', async () => {
  assert.throws(() => sim.handleCommand('draw', { serialNumber: 'nope', key: { uid: 0 }, type: 'draw' }), /unknown serialNumber/)
})

test('unplugging the device kills all keys; plugging back makes them alive', async () => {
  sim.setDeviceConnected(false)
  assert.equal(sim.alive.size, 0)
  sim.setDeviceConnected(true)
  assert.equal(sim.alive.size, 6)
})

test('ui.message round-trips and api-calls answer', async () => {
  const result = await sim.uiMessage({ data: 'test' })
  assert.equal(result.appInfo.platform, process.platform)
  assert.equal(result.devices[0].serialNumber, sim.serialNumber)
  assert.equal(result.config.counter, 1)
})

test('restart relaunches the plugin and re-sends alive', async () => {
  await sim.restartPlugin()
  await waitFor(() => sim.host.ready && keyByCid('.counter')?.render.title === '1', 'counter after restart')
})
