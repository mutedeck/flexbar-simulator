import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import http from 'node:http'
import { after, before, test } from 'node:test'
import WebSocket from 'ws'

import { startUiServer } from '../src/server.js'

// The UI server only needs the simulator's events and these three methods.
const sim = Object.assign(new EventEmitter(), { snapshot: () => ({}), logBacklog: [], storedFrames: () => [] })
let ui
let port

before(async () => {
  ui = await startUiServer(sim, { port: 0 })
  port = new URL(ui.url).port
})

after(async () => {
  await ui?.close()
})

/** Resolves true when the UI WebSocket accepts the connection, false when it refuses it. */
function connects(headers) {
  return new Promise((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ui`, { headers })
    socket.once('open', () => {
      socket.close()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
  })
}

function get(host) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/', headers: { host } }, (res) => {
      res.resume()
      resolve(res.statusCode)
    }).on('error', reject)
  })
}

test('the UI WebSocket accepts the simulator page', async () => {
  assert.equal(await connects({ origin: `http://localhost:${port}`, host: `localhost:${port}` }), true)
  assert.equal(await connects({ origin: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}` }), true)
})

test('the UI WebSocket refuses other websites and DNS rebinding', async () => {
  assert.equal(await connects({ origin: 'https://evil.example', host: `localhost:${port}` }), false)
  assert.equal(await connects({ host: `localhost:${port}` }), false)
  assert.equal(await connects({ origin: `http://evil.example:${port}`, host: `evil.example:${port}` }), false)
})

test('HTTP requests for a foreign host name are refused', async () => {
  assert.equal(await get(`localhost:${port}`), 200)
  assert.equal(await get(`evil.example:${port}`), 403)
})
