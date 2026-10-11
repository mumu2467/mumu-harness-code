'use strict'

/**
 * Development utility: render the splash screen in a hidden window and save a
 * PNG so the layout can be reviewed without hand-driving the app.
 *
 * Run with Electron, for example:
 *   electron scripts/preview-splash.js busy  out.png
 *   electron scripts/preview-splash.js error out.png
 *   electron scripts/preview-splash.js auth  out.png
 *   electron scripts/preview-splash.js ready out.png
 *
 * This file is excluded from packaged builds.
 */

const fs = require('node:fs')
const path = require('node:path')

const { app, BrowserWindow, ipcMain } = require('electron')

const { DICTIONARIES } = require('../src/main/i18n')

const mode = process.argv[2] ?? 'busy'
const output = path.resolve(process.argv[3] ?? path.join(__dirname, '..', 'build', `splash-${mode}.png`))
const dict = DICTIONARIES.zh

/** Representative log tail for the failure states. */
const PROBLEMS = [
  '2026-09-13T15:47:29.124Z [info] probe 127.0.0.1:3080 -> free (ECONNREFUSED)',
  '2026-09-13T15:47:29.185Z [info] launching via npx on PATH: npx -y @deepseek-ai/dsh web --port 3080 --no-open',
  '2026-09-13T15:47:31.402Z [info] dsh | npm warn exec The following package was not found and will be installed',
  '2026-09-13T15:47:52.881Z [warn] dsh | network request to registry.npmjs.org timed out after 30000ms',
  '2026-09-13T15:48:04.010Z [error] The dsh process exited before it became ready (code 1).'
]

/** States the preview can render. */
const STATES = {
  busy: {
    phase: 'starting',
    message: dict.stageStarting,
    port: 3080,
    version: '1.0.0'
  },
  ready: {
    phase: 'ready',
    message: dict.stageReady,
    port: 3080,
    owned: true,
    mode: 'started',
    version: '1.0.0'
  },
  error: {
    phase: 'error',
    message: dict.errorStartTimeout,
    port: 3080,
    version: '1.0.0',
    error: {
      code: 'start-timeout',
      title: dict.errorStartTimeout,
      detail: 'The dsh service did not become ready within 240s.',
      hint: dict.errorStartTimeoutHint.replace('{seconds}', '240'),
      problems: PROBLEMS
    }
  },
  auth: {
    phase: 'auth-required',
    message: dict.errorAuthRequired,
    port: 3080,
    owned: false,
    mode: 'reused',
    url: 'http://127.0.0.1:3080/',
    version: '1.0.0',
    error: {
      code: 'auth-required',
      title: dict.errorAuthRequired,
      detail: '',
      hint: dict.errorAuthRequiredHint,
      problems: []
    }
  }
}

const state = { ...(STATES[mode] ?? STATES.busy), dict, locale: 'zh' }

ipcMain.handle('launcher:get-state', () => state)
ipcMain.handle('launcher:action', () => ({ ok: true }))

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 860,
    height: mode === 'auth' || mode === 'error' ? 760 : 520,
    show: false,
    backgroundColor: '#0f1319',
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'preload', 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false
    }
  })
  window.webContents.on('preload-error', (_event, preloadPath, error) => {
    process.stdout.write(`[preload-error] ${preloadPath}: ${String(error)}\n`)
  })
  window.webContents.on('console-message', (...args) => {
    const detail = typeof args[0] === 'object' && args[0] !== null && 'message' in args[0]
      ? args[0]
      : { level: args[1], message: args[2], lineNumber: args[3], sourceId: args[4] }
    process.stdout.write(`[renderer:${String(detail.level)}] ${String(detail.message)} (${String(detail.sourceId)}:${String(detail.lineNumber)})\n`)
  })
  await window.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'splash.html'))
  // Surface renderer-side failures so a blank preview is never a mystery.
  const bridge = await window.webContents.executeJavaScript(
    '({ hasBridge: typeof window.launcher, readyState: document.readyState, '
    + 'phase: document.getElementById("phase")?.textContent, '
    + 'retryLabel: document.getElementById("retryBtn")?.textContent })'
  )
  process.stdout.write(`bridge probe: ${JSON.stringify(bridge)}\n`)
  // A window that was never shown does not repaint, and capturePage would
  // return the pre-script frame. Showing it is what makes the capture real.
  window.showInactive()
  // Give fonts and the first paint a moment to settle.
  await new Promise((resolve) => { setTimeout(resolve, 900) })
  const image = await window.webContents.capturePage()
  fs.mkdirSync(path.dirname(output), { recursive: true })
  fs.writeFileSync(output, image.toPNG())
  process.stdout.write(`wrote ${output}\n`)
  app.exit(0)
}).catch((error) => {
  process.stderr.write(`preview failed: ${String(error?.stack ?? error)}\n`)
  app.exit(1)
})
