# Flexbar Simulator

A fake FlexDesigner with a fake Flexbar, so you can develop and test Flexbar plugins without the hardware.

It targets the **FlexDesigner v1 plugin SDK** (`@eniac/flexdesigner`). ENIAC's upcoming FlexStudio uses a different plugin SDK (`@flexsdk/*`), and this simulator does not cover it.

The simulator works at the protocol level. It starts your plugin backend exactly as FlexDesigner does and speaks the same WebSocket protocol. A browser page shows a 2170×60 strip where you tap, slide, scroll and touch keys.

```
npm install
npm run fixture                          # run the bundled test plugin
node bin/flexbar-sim.js <plugin-dir>     # run your plugin (the folder with manifest.json)
npm test                                 # end-to-end tests against the fixture plugin
```

Options: `--ui-port 4790`, `--plugin-port <port>` (random by default), `--serial SIM0000000001`, `--state-dir .flexbar-sim`, `--no-open`.

The key layout and the plugin's `config.json` (`getConfig`/`setConfig`) are saved under `.flexbar-sim/<uuid>.json`.

## What it does

| Area | Simulated |
|---|---|
| Launch | `node <entry> --port=<p> --uid=<uuid> --dir=<pluginDir>`. The plugin connects and sends `startup`. Plugin output goes to the terminal and to the Log tab. |
| Lifecycle | `device.status`, then `plugin.alive` for the keys on the current page. Page switches, removing a key and unplugging the device send `plugin.dead`. Editing `key.data` reloads that key (dead + alive). |
| Input | Default keys send `plugin.data {evt:"click"}`. Multi-state keys advance their own state and send the new `state`. Sliders send `value`. Wheels send `start/rolling(delta)/end` (drag sideways or use the mouse wheel). Dynamic child keys send `index`/`userData`. Direct Draw sends `device.touch` down/pressing/up/end. Also `ui.message`, `system.shortcut` and `plugin.config.updated`. |
| Output | `draw` (style-based or base64), `set` (multiState/slider), `direct-draw` (including `offsetX` patches), `dynamic-plugin` (add/remove/move/draw/update/set/refresh/clear, max 16 children), `show-snackbar-message` (on the strip), `ui-operation` snackbar (as a toast), `control-command` (sleep/wake/haptic shake), `device-config`, `update-shortcuts`, `custom-chart-data`. |
| API calls | `getAppInfo`, `getPluginConfig`/`setPluginConfig`, `getDeviceStatus`, `getOpenedWindows` (empty), `openFile`/`pluginSaveFile` (real filesystem), and some Electron APIs (`app.getPath`, `app.getAppPath`, `screen.*`). Dialogs are rejected. |
| Checks | A wrong `serialNumber` is rejected. Unknown keys or commands return errors. Drawing to a key that isn't alive logs a warning. Width overflow past 2170px is marked on the strip. Unanswered events time out after 5s. |

The **Protocol** tab shows every message in both directions, with data URLs shortened.

The **Assumptions** tab lists the host behaviours the docs don't pin down. **They still need checking on a real Flexbar.** The short version:
- `plugin.alive` and `plugin.dead` fire per page.
- A multi-state tap reports the new state.
- A dynamic child tap sends `{evt, key, index, userData}`.
- A Direct Draw key takes a whole page.

## Not simulated (yet)

- **The Vue config pages** (`ui/<cid>.vue`, `configPage`). FlexDesigner compiles these at runtime with Vuetify and a `$fd` bridge. Until the simulator renders them, edit `key.data` in the Key inspector and send `ui.message` from the Tools tab. Test the real pages in FlexDesigner, which loads plugins without a device.
- Fonts, exact icon metrics and the device's own rendering. Style-based keys are an approximation using the MDI webfont.
- Multiple devices, `system.actwin`, and firmware quirks.

## Gotchas this has already caught

- **A handler must not return the logger.** In `plugin.on('x', (p) => logger.info(p))`, the arrow function returns the winston instance. The SDK can't JSON-encode it as the reply (`Converting circular structure to JSON`), so the host never gets an answer. Use a block body.
- The SDK's reconnect calls `setTimeout(this.start, 5000)` without binding `this`, so a plugin whose socket drops will crash on reconnect. FlexDesigner restarts plugins anyway, but don't rely on the SDK's reconnect.

## Layout

```
bin/flexbar-sim.js         CLI
src/plugin-host.js         WebSocket protocol + plugin process (the FlexDesigner side)
src/simulator.js           device, pages, keys, command handlers, assumptions
src/manifest.js            manifest + keyLibrary loading ($-string translation, subpages)
src/server.js              browser UI server (localhost only)
ui/                        the strip UI (plain JS, MDI font from @mdi/font)
fixtures/test-plugin/      plugin that exercises every key type and SDK call
test/                      node:test end-to-end tests
```
