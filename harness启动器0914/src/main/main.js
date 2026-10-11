'use strict'

/**
 * Electron main process for the DeepSeek Harness Launcher.
 *
 * The window is a single BrowserWindow that starts on a local splash document
 * and then navigates to the Harness Web UI once the service is ready. The UI
 * runs in a persistent session partition on purpose: the Harness browser
 * cookie is signed with a secret stored in the Harness home and lives for 30
 * days, so keeping the jar across launches is what makes reusing an already
 * running service seamless on every launch after the first.
 */

const path = require('node:path')
const fs = require('node:fs')

const { app, BrowserWindow, ipcMain, session, shell } = require('electron')

const { Logger } = require('./logger')
const { OwnedServiceStore, SettingsStore } = require('./settings')
const { LauncherError, ServerManager } = require('./server-manager')
const { selectDictionary } = require('./i18n')

/** Persistent partition that keeps the Harness session cookie. */
const PARTITION = 'persist:dsh-ui'

const SPLASH_FILE = path.join(__dirname, '..', 'renderer', 'splash.html')
const PRELOAD_FILE = path.join(__dirname, '..', 'preload', 'preload.js')
const ICON_FILE = path.join(__dirname, '..', '..', 'build', 'icon.png')

const IS_SMOKE_TEST = process.argv.includes('--smoke-test')
const IS_DEVELOPMENT = process.argv.includes('--dev')

/** @type {BrowserWindow|null} */
let mainWindow = null
/** @type {ServerManager|null} */
let manager = null
/** @type {Logger|null} */
let logger = null
/** @type {SettingsStore|null} */
let settingsStore = null
/** @type {import('electron').Session|null} */
let uiSession = null

/** Latest state pushed to the splash screen; replayed on every reload. */
let lastState = null
let shuttingDown = false
let locale = { code: 'en', strings: {} }

/**
 * Fill `{name}` placeholders in a dictionary string.
 * @param {string} template - Dictionary string.
 * @param {object} [values] - Replacement values.
 * @returns {string} Interpolated string.
 */
function format (template, values = {}) {
  return String(template).replace(/\{(\w+)\}/gu, (match, key) => (
    values[key] === undefined ? match : String(values[key])
  ))
}

/**
 * Resolve a dictionary string by key.
 * @param {string} key - Dictionary key.
 * @param {object} [values] - Interpolation values.
 * @returns {string} Localized string, falling back to the key itself.
 */
function t (key, values) {
  return format(locale.strings[key] ?? key, values)
}

/**
 * Publish a state update to the splash screen.
 * @param {object} patch - State fields to merge.
 * @returns {void}
 */
function publishState (patch) {
  lastState = { ...lastState, ...patch, dict: locale.strings, locale: locale.code }
  if (mainWindow !== null && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('launcher:state', lastState)
  }
}

/**
 * Report a phase with localized copy.
 * @param {string} phase - Machine-readable phase.
 * @param {string} messageKey - Dictionary key for the message.
 * @param {object} [detail] - Extra state fields.
 * @returns {void}
 */
function phase (phaseName, messageKey, detail = {}) {
  logger?.info(`phase=${phaseName} ${messageKey}`)
  publishState({ phase: phaseName, message: t(messageKey, detail), error: null, ...detail })
}

/**
 * Show the splash screen, replaying the latest state once it has loaded.
 * @param {object} [patch] - State fields to merge before loading.
 * @returns {Promise<void>} Resolves once the document is loading.
 */
async function showSplash (patch) {
  if (patch !== undefined) lastState = { ...lastState, ...patch }
  if (mainWindow === null || mainWindow.isDestroyed()) return
  await mainWindow.loadFile(SPLASH_FILE)
}

/**
 * Present a failure on the splash screen.
 * @param {unknown} error - Thrown error.
 * @param {string} [fallbackCode] - Code used for unrecognized errors.
 * @returns {void}
 */
function presentError (error, fallbackCode = 'unexpected') {
  const isLauncher = error instanceof LauncherError
  const code = isLauncher ? error.code : fallbackCode
  const settings = settingsStore?.get() ?? {}

  // Codes with shipped copy get a fully localized failure. Anything else is
  // unrecognized, so the raw message is the only real information available.
  const titleKeys = {
    'port-taken': 'errorPortTaken',
    'start-timeout': 'errorStartTimeout',
    exited: 'errorExited',
    'dsh-missing': 'errorNoDsh'
  }
  const hintKeys = {
    'port-taken': 'errorPortTakenHint',
    'start-timeout': 'errorStartTimeoutHint',
    exited: 'errorExitedHint',
    'dsh-missing': 'errorNoDshHint'
  }
  const titleKey = titleKeys[code]
  const recognized = titleKey !== undefined

  const values = {
    port: settings.port,
    seconds: Math.round((settings.startupTimeoutMs ?? 0) / 1000),
    ...(isLauncher ? error.values : {})
  }
  const hintKey = hintKeys[code]
  const localizedHint = hintKey === undefined ? '' : t(hintKey, values)
  // Shipped copy wins; the rawer English hint is only a fallback for a code
  // that has no translation, so a localized screen never mixes languages.
  const rawHint = isLauncher && error.hint !== '' ? error.hint : ''
  const hint = localizedHint !== '' ? localizedHint : rawHint

  logger?.error(`startup failed [${code}]: ${isLauncher ? error.message : String(error)}`)
  publishState({
    phase: 'error',
    message: t(titleKey ?? 'errorTitle', values),
    error: {
      code,
      title: t(titleKey ?? 'errorTitle', values),
      detail: recognized ? '' : (isLauncher ? error.message : String(error?.message ?? error)),
      hint,
      problems: isLauncher ? error.problems : []
    }
  })
  void showSplash()
}

/**
 * Create the single application window.
 * @returns {BrowserWindow} The created window.
 */
function createWindow () {
  const settings = settingsStore.get()
  const bounds = settings.windowBounds ?? {}
  const icon = fs.existsSync(ICON_FILE) ? ICON_FILE : undefined

  mainWindow = new BrowserWindow({
    width: Number.isInteger(bounds.width) ? bounds.width : 1280,
    height: Number.isInteger(bounds.height) ? bounds.height : 860,
    x: Number.isInteger(bounds.x) ? bounds.x : undefined,
    y: Number.isInteger(bounds.y) ? bounds.y : undefined,
    minWidth: 900,
    minHeight: 620,
    show: false,
    backgroundColor: '#0f1319',
    title: 'DeepSeek Harness',
    icon,
    autoHideMenuBar: true,
    webPreferences: {
      preload: PRELOAD_FILE,
      partition: PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: false
    }
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
    if (IS_DEVELOPMENT) mainWindow?.webContents.openDevTools({ mode: 'detach' })
  })

  // External links belong in the user's browser, never in the app window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/u.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.on('close', () => {
    const current = mainWindow?.getNormalBounds()
    if (current !== undefined && settingsStore !== null) {
      try {
        settingsStore.saveWindowBounds(current)
      } catch { /* geometry is a convenience, never a failure */ }
    }
  })

  mainWindow.on('closed', () => { mainWindow = null })

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
    if (!isMainFrame) return
    if (errorCode === -3) return // aborted by a newer navigation
    // A failure loading the splash itself must not trigger another splash load.
    if (validatedUrl.startsWith('file://')) return
    logger?.warn(`load failed for ${validatedUrl}: ${errorDescription} (${String(errorCode)})`)
    publishState({
      phase: 'error',
      message: t('errorTitle'),
      error: {
        code: 'load-failed',
        title: t('errorTitle'),
        detail: `${errorDescription} (${String(errorCode)})`,
        hint: '',
        problems: []
      }
    })
    void showSplash()
  })

  void mainWindow.loadFile(SPLASH_FILE)
  return mainWindow
}

/**
 * Run the startup sequence: reuse, adopt, or start a service, then load it.
 * @returns {Promise<object>} Startup outcome.
 */
async function runStartup () {
  phase('checking', 'stageChecking', {})
  const outcome = await manager.start()
  logger?.info(`startup outcome: mode=${outcome.mode} port=${String(outcome.port)} owned=${String(outcome.owned)} authenticated=${String(outcome.authenticated)}`)

  if (!outcome.authenticated) {
    // The service belongs to someone else and its per-process launch token is
    // unrecoverable, so the only way in is a token the user supplies.
    publishState({
      phase: 'auth-required',
      message: t('errorAuthRequired'),
      port: outcome.port,
      url: outcome.url,
      owned: outcome.owned,
      mode: outcome.mode,
      error: {
        code: 'auth-required',
        title: t('errorAuthRequired'),
        detail: '',
        hint: t('errorAuthRequiredHint'),
        problems: []
      }
    })
    await showSplash()
    return outcome
  }

  phase('loading', 'stageLoading', { port: outcome.port, owned: outcome.owned, mode: outcome.mode })
  await mainWindow?.loadURL(outcome.url)
  return outcome
}

/**
 * Open a token URL supplied by the user after validating it.
 * @param {string} rawValue - Pasted URL or bare token.
 * @returns {Promise<{ok: boolean, message?: string}>} Result for the renderer.
 */
async function openWithToken (rawValue) {
  const value = String(rawValue ?? '').trim()
  if (value === '') return { ok: false, message: t('tokenPlaceholder') }

  let candidate = value
  if (!/^https?:\/\//iu.test(candidate)) {
    // Prefer the port the running service actually uses, which may differ
    // from the configured one after a fallback.
    const port = lastState?.port ?? settingsStore.get().port
    candidate = `http://127.0.0.1:${String(port)}/?token=${encodeURIComponent(value)}`
  }

  let parsed
  try {
    parsed = new URL(candidate)
  } catch {
    return { ok: false, message: t('errorAuthRequiredHint') }
  }

  // Only loopback targets are accepted: a token is a bearer credential and
  // must never be sent to a host the user merely pasted.
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(parsed.hostname)) {
    logger?.warn(`refused a token URL for non-loopback host ${parsed.hostname}`)
    return { ok: false, message: t('errorAuthRequiredHint') }
  }

  phase('authenticating', 'stageAuthenticating', {})
  const exchanged = await manager.exchangeToken(parsed.href)
  if (!exchanged.ok) {
    logger?.warn(`token exchange failed with status ${String(exchanged.status)}`)
    publishState({
      phase: 'auth-required',
      message: t('errorAuthRequired'),
      error: {
        code: 'auth-required',
        title: t('errorAuthRequired'),
        detail: `HTTP ${String(exchanged.status ?? '')}`.trim(),
        hint: t('errorAuthRequiredHint'),
        problems: []
      }
    })
    await showSplash()
    return { ok: false, message: t('errorAuthRequiredHint') }
  }

  const rootUrl = `${parsed.protocol}//${parsed.host}/`
  phase('loading', 'stageLoading', {})
  await mainWindow?.loadURL(rootUrl)
  return { ok: true }
}

/**
 * Stop the owned service and exit.
 * @param {string} reason - Why shutdown started, for the log.
 * @returns {Promise<void>} Resolves once the app is exiting.
 */
async function shutdownAndExit (reason) {
  if (shuttingDown) return
  shuttingDown = true
  logger?.info(`shutting down (${reason})`)

  if (settingsStore?.get().stopServiceOnExit === false) {
    logger?.warn('stopServiceOnExit is false; the owned service is left running')
    app.exit(0)
    return
  }

  try {
    const result = await manager?.stop()
    if (result?.portStillHeld === true) {
      logger?.warn('a Harness service still answers on the port after teardown')
    }
  } catch (error) {
    logger?.error(`teardown failed: ${String(error?.message ?? error)}`)
  }
  app.exit(0)
}

/**
 * Build the diagnostics block offered on the error screen.
 * @returns {string} Multi-line diagnostics text.
 */
function diagnostics () {
  const settings = settingsStore?.get() ?? {}
  const status = manager?.status() ?? {}
  return [
    `launcher ${app.getVersion()}  electron ${process.versions.electron}  node ${process.versions.node}`,
    `platform ${process.platform} ${process.arch}`,
    `locale ${locale.code}`,
    `settings ${JSON.stringify({ ...settings, windowBounds: undefined })}`,
    `status ${JSON.stringify(status)}`,
    `log file ${logger?.file ?? ''}`,
    '--- log tail ---',
    ...(logger?.tail(40) ?? [])
  ].join('\n')
}

/**
 * Register IPC handlers, restricted to the local splash document.
 * @returns {void}
 */
function registerIpc () {
  const assertSplash = (event) => {
    const url = event.senderFrame?.url ?? ''
    if (!url.startsWith('file://')) {
      throw new Error('launcher: rejected an IPC call from a non-launcher document')
    }
  }

  ipcMain.handle('launcher:get-state', (event) => {
    assertSplash(event)
    return lastState ?? { phase: 'checking', message: t('stageChecking'), dict: locale.strings }
  })

  ipcMain.handle('launcher:action', async (event, payload) => {
    assertSplash(event)
    const action = payload?.action
    logger?.info(`renderer action: ${String(action)}`)
    switch (action) {
      case 'retry':
        void runStartup().catch((error) => { presentError(error) })
        return { ok: true }
      case 'restart':
        await manager.stop()
        void runStartup().catch((error) => { presentError(error) })
        return { ok: true }
      case 'change-port': {
        const port = Number.parseInt(String(payload?.value ?? ''), 10)
        if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false }
        settingsStore.update({ port })
        await manager.stop()
        void runStartup().catch((error) => { presentError(error) })
        return { ok: true }
      }
      case 'submit-token':
        return openWithToken(payload?.value)
      case 'open-external': {
        const target = String(payload?.value ?? '')
        if (/^https?:\/\//u.test(target)) {
          await shell.openExternal(target)
          return { ok: true }
        }
        return { ok: false }
      }
      case 'diagnostics':
        return { ok: true, value: diagnostics() }
      case 'quit':
        void shutdownAndExit('renderer quit')
        return { ok: true }
      default:
        return { ok: false }
    }
  })
}

/**
 * Prepare the persistent UI session.
 * @returns {import('electron').Session} Configured session.
 */
function prepareSession () {
  const ui = session.fromPartition(PARTITION)
  // The Harness UI needs no camera, microphone, or notification access.
  ui.setPermissionRequestHandler((_contents, _permission, callback) => { callback(false) })
  return ui
}

/**
 * Smoke test: exercise the real startup path headlessly and report JSON.
 * @returns {Promise<void>} Resolves after the report is printed.
 */
async function smokeTest () {
  let outcome
  let failure
  try {
    outcome = await manager.start()
  } catch (error) {
    failure = { code: error.code ?? 'unexpected', message: error.message, problems: error.problems ?? [] }
  }
  let stopResult
  if (outcome?.owned === true) stopResult = await manager.stop()
  process.stdout.write(`\nSMOKE_RESULT ${JSON.stringify({
    outcome: outcome === undefined ? null : { ...outcome, url: outcome.url.replace(/token=[^&]+/u, 'token=<redacted>') },
    failure: failure ?? null,
    stop: stopResult ?? null
  })}\n`)
  app.exit(failure === undefined && outcome !== undefined ? 0 : 1)
}

// Only one launcher may own the port and the service record at a time.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow !== null) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.on('window-all-closed', () => { void shutdownAndExit('window-all-closed') })
  app.on('before-quit', (event) => {
    if (!shuttingDown) {
      event.preventDefault()
      void shutdownAndExit('before-quit')
    }
  })
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => { void shutdownAndExit(signal) })
  }

  app.whenReady().then(async () => {
    locale = selectDictionary(settingsStore === null ? app.getLocale() : (settingsStore.get().locale || app.getLocale()))
    uiSession = prepareSession()
    registerIpc()

    if (IS_SMOKE_TEST) {
      await smokeTest()
      return
    }

    createWindow()
    publishState({ phase: 'checking', message: t('stageChecking') })
    try {
      await runStartup()
    } catch (error) {
      presentError(error)
    }
  }).catch((error) => {
    process.stderr.write(`launcher failed to initialize: ${String(error?.stack ?? error)}\n`)
    app.exit(1)
  })
}

// Stores are created before `whenReady` so the window can read saved geometry.
const userData = app.getPath('userData')
logger = new Logger({ directory: path.join(userData, 'logs'), echo: IS_SMOKE_TEST || IS_DEVELOPMENT })
settingsStore = new SettingsStore(userData)
locale = selectDictionary(settingsStore.get().locale || app.getLocale())
manager = new ServerManager({
  settingsStore,
  stateStore: new OwnedServiceStore(userData),
  logger,
  fetchImpl: (url, init) => session.fromPartition(PARTITION).fetch(url, init),
  isPackaged: app.isPackaged
})
lastState = {
  phase: 'checking',
  message: t('stageChecking'),
  dict: locale.strings,
  locale: locale.code,
  version: app.getVersion()
}

// Stream the log to the splash screen so a slow first-run download is
// visibly progressing rather than looking like a hang.
logger.on('line', (line) => {
  if (mainWindow !== null && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('launcher:log', line)
  }
})
