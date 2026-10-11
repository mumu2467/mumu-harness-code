'use strict'

/**
 * Splash renderer.
 *
 * The main process owns every string, including localized ones, and pushes a
 * complete state object. This script only maps that state onto the document,
 * so no localization or lifecycle policy lives in the renderer.
 */

const api = window.launcher

/** Phases that mean work is still in flight. */
const BUSY_PHASES = new Set([
  'checking', 'found', 'starting', 'waiting',
  'authenticating', 'loading', 'stopping', 'adopting'
])

/** Retained live log lines. */
const LOG_LIMIT = 400

/** @type {object|null} */
let state = null

/** @type {string[]} */
let logLines = []

/** True once the user has opened or closed the log by hand. */
let logTouched = false

/**
 * Look up an element by id.
 * @param {string} id - Element id.
 * @returns {HTMLElement} The element.
 */
const el = (id) => document.getElementById(id)

/** Static label bindings from element id to dictionary key. */
const LABELS = {
  appTitle: 'appTitle',
  logSummary: 'actionShowLog',
  tokenLabel: 'labelToken',
  portLabel: 'labelPort',
  submitTokenBtn: 'actionSubmitToken',
  retryBtn: 'actionRetry',
  restartBtn: 'actionRestart',
  changePortBtn: 'actionChangePort',
  externalBtn: 'actionOpenExternal',
  diagBtn: 'actionCopyDiagnostics'
}

/**
 * Apply the dictionary to every static label.
 * @param {object} dict - Localized strings.
 */
function applyDict (dict) {
  for (const [id, key] of Object.entries(LABELS)) {
    const node = el(id)
    if (node !== null && typeof dict[key] === 'string') node.textContent = dict[key]
  }
  const quit = el('quitBtn')
  if (typeof dict.actionQuit === 'string') quit.title = dict.actionQuit
  el('tokenInput').placeholder = dict.tokenPlaceholder ?? ''
  document.documentElement.lang = state?.locale === 'zh' ? 'zh-CN' : 'en'
}

/**
 * Repaint the log panel from the retained lines.
 */
function paintLog () {
  const pre = el('log')
  pre.textContent = logLines.join('\n')
  el('logWrap').hidden = logLines.length === 0
  if (!el('logWrap').hidden) pre.scrollTop = pre.scrollHeight
  el('logSummary').textContent = el('logWrap').open
    ? (state?.dict?.actionHideLog ?? 'Hide log')
    : (state?.dict?.actionShowLog ?? 'Show log')
}

/**
 * Append one live log line.
 * @param {string} line - Log line from the main process.
 */
function appendLog (line) {
  logLines.push(line)
  if (logLines.length > LOG_LIMIT) logLines.splice(0, logLines.length - LOG_LIMIT)
  if (!logTouched) el('logWrap').open = BUSY_PHASES.has(state?.phase ?? '')
  paintLog()
}

/**
 * Render a state object.
 * @param {object} next - Launcher state from the main process.
 */
function render (next) {
  state = { ...state, ...next }
  const dict = state.dict ?? {}
  applyDict(dict)

  const busy = BUSY_PHASES.has(state.phase)
  el('spinner').hidden = !busy
  el('phase').textContent = state.message ?? ''

  const port = state.port ?? 3080
  if (document.activeElement !== el('portInput')) el('portInput').value = String(port)
  el('subtitle').textContent = `dsh web · 127.0.0.1:${port}`

  const hasError = state.phase === 'error' || state.phase === 'auth-required'
  el('errorPanel').hidden = !hasError
  if (hasError && state.error !== undefined && state.error !== null) {
    el('errorTitle').textContent = state.error.title ?? ''
    el('errorDetail').textContent = state.error.detail ?? ''
    el('errorHint').textContent = state.error.hint ?? ''
    const problems = Array.isArray(state.error.problems) ? state.error.problems : []
    el('errorProblems').textContent = ''
    for (const line of problems) {
      const item = document.createElement('li')
      item.textContent = line
      el('errorProblems').appendChild(item)
    }
    // Seed the log from the captured tail so the panel is populated if the
    // user opens it, without duplicating the list on screen by default.
    if (problems.length > 0 && logLines.length === 0) logLines = [...problems]
  }

  el('tokenPanel').hidden = state.phase !== 'auth-required'
  el('tokenError').hidden = true

  // Ownership note: a borrowed service must survive this window closing.
  const note = el('note')
  if (busy === false && hasError === false && state.owned === true) {
    note.textContent = dict.noteOwned ?? ''
    note.hidden = false
  } else if (state.owned === false && (state.mode === 'reused' || hasError)) {
    note.textContent = dict.noteReused ?? ''
    note.hidden = false
  } else {
    note.hidden = true
  }

  for (const id of ['retryBtn', 'restartBtn', 'changePortBtn', 'submitTokenBtn']) el(id).disabled = busy
  paintLog()
}

/**
 * Run an action, surfacing a failure in the token field when relevant.
 * @param {() => Promise<object>} call - Action call.
 * @param {boolean} [reportInline] - Show the message beside the token input.
 */
async function run (call, reportInline = false) {
  try {
    const result = await call()
    if (reportInline && result !== undefined && result.ok === false) {
      el('tokenError').textContent = result.message ?? ''
      el('tokenError').hidden = false
    }
  } catch (error) {
    el('tokenError').textContent = String(error?.message ?? error)
    el('tokenError').hidden = false
  }
}

/**
 * Copy diagnostics, falling back to the log panel when the clipboard is
 * unavailable.
 */
async function copyDiagnostics () {
  const result = await api.diagnostics()
  const text = result?.value ?? ''
  try {
    await navigator.clipboard.writeText(text)
    const button = el('diagBtn')
    const original = button.textContent
    button.textContent = state?.dict?.actionCopied ?? 'Copied'
    setTimeout(() => { button.textContent = original }, 1400)
  } catch {
    logLines = text.split('\n')
    el('logWrap').open = true
    logTouched = true
    paintLog()
  }
}

/**
 * Wire the controls once the document is ready.
 */
function wire () {
  el('retryBtn').addEventListener('click', () => { void run(() => api.retry()) })
  el('restartBtn').addEventListener('click', () => { void run(() => api.restart()) })
  el('changePortBtn').addEventListener('click', () => { void run(() => api.changePort(el('portInput').value)) })
  el('submitTokenBtn').addEventListener('click', () => { void run(() => api.submitToken(el('tokenInput').value), true) })
  el('tokenInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void run(() => api.submitToken(el('tokenInput').value), true)
  })
  el('externalBtn').addEventListener('click', () => {
    void run(() => api.openExternal(state?.url ?? `http://127.0.0.1:${String(state?.port ?? 3080)}/`))
  })
  el('diagBtn').addEventListener('click', () => { void copyDiagnostics() })
  el('quitBtn').addEventListener('click', () => { void api.quit() })
  el('logWrap').addEventListener('toggle', () => {
    logTouched = true
    paintLog()
  })

  api.onLog(appendLog)
  api.onState(render)
  void api.getState().then(render)
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', wire)
} else {
  wire()
}
