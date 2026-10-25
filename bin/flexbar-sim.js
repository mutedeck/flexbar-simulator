#!/usr/bin/env node
import { execFile } from 'node:child_process'
import path from 'node:path'
import { parseArgs } from 'node:util'

import { startUiServer } from '../src/server.js'
import { Simulator } from '../src/simulator.js'

const USAGE = `Usage: flexbar-sim <plugin-dir> [options]

  <plugin-dir>          The plugin folder that holds manifest.json (com.<author>.<name>.plugin)

Options:
  --ui-port <port>      Port for the browser UI (default 4790)
  --plugin-port <port>  Port the plugin connects to (default: random free port)
  --serial <sn>         Simulated device serial number (default SIM0000000001)
  --state-dir <dir>     Where layout and plugin config are kept (default ./.flexbar-sim)
  --no-open             Don't open the browser
  -h, --help            Show this help
`

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'ui-port': { type: 'string', default: '4790' },
    'plugin-port': { type: 'string', default: '0' },
    serial: { type: 'string', default: 'SIM0000000001' },
    'state-dir': { type: 'string', default: '.flexbar-sim' },
    'no-open': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
})

if (values.help || positionals.length !== 1) {
  process.stdout.write(USAGE)
  process.exit(values.help ? 0 : 1)
}

let sim
try {
  sim = new Simulator({
    pluginDir: positionals[0],
    stateDir: path.resolve(values['state-dir']),
    serialNumber: values.serial,
    pluginPort: Number(values['plugin-port']),
  })
} catch (error) {
  console.error(`flexbar-sim: ${error.message}`)
  process.exit(1)
}

// Plugin output and simulator notes also go to the terminal.
sim.on('log', ({ stream, text }) => {
  const prefix = stream === 'sim' ? '[sim]' : `[plugin:${stream}]`
  for (const line of text.split('\n')) {
    console.log(`${prefix} ${line}`)
  }
})

let ui
try {
  ui = await startUiServer(sim, { port: Number(values['ui-port']) })
} catch (error) {
  console.error(`flexbar-sim: ${error.message}`)
  process.exit(1)
}
console.log(`[sim] ${sim.plugin.name} (${sim.plugin.uuid}) → ${ui.url}`)
await sim.start()

if (!values['no-open']) {
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open'
  execFile(opener, [ui.url], () => {})
}

let stopping = false
const stop = async () => {
  if (stopping) {
    return
  }
  stopping = true
  await sim.shutdown()
  await ui.close()
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
