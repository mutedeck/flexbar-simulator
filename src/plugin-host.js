import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { WebSocketServer } from 'ws'

/**
 * The FlexDesigner side of the plugin wire protocol.
 *
 * FlexDesigner starts the backend as `node <entry> --port=<p> --uid=<uuid> --dir=<pluginDir>`.
 * The plugin connects to ws://localhost:<p> and sends `startup`. Every message is
 * `{pluginID, type, payload, timestamp, uuid}`. A call is answered with
 * `{type: "response", uuid, status: "success" | "error", payload, error?}`, in both directions.
 *
 * Events:
 * - `command` (type, payload, reply): a call from the plugin; `reply(result)` or `reply.error(message)`.
 * - `ready`: the plugin connected and sent `startup`.
 * - `exit` (code, signal), `output` (stream, text), `protocol` (direction, message).
 */
export class PluginHost extends EventEmitter {
  constructor({ uuid, dir, entry, port = 0, nodePath = process.execPath, timeoutMs = 5000 }) {
    super()
    this.uuid = uuid
    this.dir = dir
    this.entry = entry
    this.port = port
    this.nodePath = nodePath
    this.timeoutMs = timeoutMs
    this.pending = new Map()
    this.socket = null
    this.child = null
    this.ready = false
  }

  async listen() {
    this.wss = new WebSocketServer({ host: '127.0.0.1', port: this.port })
    await new Promise((resolve, reject) => {
      this.wss.once('listening', resolve)
      this.wss.once('error', reject)
    })
    this.port = this.wss.address().port
    this.wss.on('connection', (socket) => this.attach(socket))
  }

  /** Spawns the plugin backend. */
  launch() {
    const args = [this.entry, `--port=${this.port}`, `--uid=${this.uuid}`, `--dir=${this.dir}`]
    this.child = spawn(this.nodePath, args, { cwd: this.dir, stdio: ['ignore', 'pipe', 'pipe'] })
    this.child.stdout.on('data', (chunk) => this.emit('output', 'stdout', chunk.toString()))
    this.child.stderr.on('data', (chunk) => this.emit('output', 'stderr', chunk.toString()))
    this.child.on('exit', (code, signal) => {
      this.child = null
      this.ready = false
      this.emit('exit', code, signal)
    })
  }

  get running() {
    return this.child !== null
  }

  async stop() {
    this.ready = false
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer)
      reject(new Error('plugin stopped'))
    }
    this.pending.clear()
    const child = this.child
    if (child) {
      const exited = new Promise((resolve) => child.once('exit', resolve))
      child.kill()
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2000))])
      if (this.child) {
        this.child.kill('SIGKILL')
      }
    }
    this.socket?.terminate()
    this.socket = null
  }

  async close() {
    await this.stop()
    await new Promise((resolve) => this.wss?.close(resolve))
  }

  /** Sends an event to the plugin and resolves with its handler's return value. */
  send(type, payload) {
    if (!this.socket || !this.ready) {
      return Promise.reject(new Error(`plugin not connected, dropped '${type}'`))
    }
    const uuid = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(uuid)
        reject(new Error(`plugin did not answer '${type}' within ${this.timeoutMs} ms`))
      }, this.timeoutMs)
      this.pending.set(uuid, { resolve, reject, timer })
      this.write({ pluginID: this.uuid, type, payload, timestamp: Date.now(), uuid })
    })
  }

  attach(socket) {
    if (this.socket) {
      // FlexDesigner runs one backend per plugin; a second connection is a stale process.
      this.emit('output', 'sim', 'A second plugin connection was refused (is an old plugin process still running?)')
      socket.close()
      return
    }
    this.socket = socket
    socket.on('message', (raw) => this.receive(raw.toString()))
    socket.on('close', () => {
      if (this.socket === socket) {
        this.socket = null
        this.ready = false
      }
    })
  }

  receive(raw) {
    let message
    try {
      message = JSON.parse(raw)
    } catch {
      this.emit('output', 'sim', `Invalid JSON from plugin: ${raw.slice(0, 200)}`)
      return
    }
    this.emit('protocol', 'in', message)

    if (message.type === 'response') {
      const call = this.pending.get(message.uuid)
      if (call) {
        clearTimeout(call.timer)
        this.pending.delete(message.uuid)
        if (message.status === 'success') {
          call.resolve(message.payload)
        } else {
          call.reject(new Error(message.error ?? 'plugin returned an error'))
        }
      }
      return
    }

    const reply = (payload) => this.respond(message.uuid, 'success', payload)
    reply.error = (error) => this.respond(message.uuid, 'error', null, error)

    if (message.type === 'startup') {
      reply(null)
      this.ready = true
      this.emit('ready')
      return
    }
    this.emit('command', message.type, message.payload ?? {}, reply)
  }

  respond(uuid, status, payload, error) {
    const message = { pluginID: this.uuid, type: 'response', payload, timestamp: Date.now(), uuid, status }
    if (error !== undefined) {
      message.error = error
    }
    this.write(message)
  }

  write(message) {
    if (message.type !== 'response') {
      this.emit('protocol', 'out', message)
    } else {
      this.emit('protocol', 'out-response', message)
    }
    this.socket?.send(JSON.stringify(message))
  }
}
