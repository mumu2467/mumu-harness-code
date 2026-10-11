'use strict'

/**
 * Launcher settings and the persisted record of a service this launcher owns.
 *
 * Both files live in the Electron user-data directory so a packaged app never
 * writes beside its own program files. Writes are atomic: a half-written
 * settings file would otherwise make the next launch fall back to defaults
 * and silently move the service to a different port.
 */

const fs = require('node:fs')
const path = require('node:path')

/** Defaults chosen to match the Harness CLI's own defaults. */
const DEFAULT_SETTINGS = Object.freeze({
  host: '127.0.0.1',
  port: 3080,
  locale: '',
  startupTimeoutMs: 240000,
  dshPath: '',
  dshCommand: '',
  nodePath: '',
  workingDirectory: '',
  extraArgs: [],
  reuseRunningService: true,
  stopServiceOnExit: true,
  killOrphanedService: true,
  fallbackToFreePort: false,
  windowBounds: null
})

/**
 * Read and validate a JSON file.
 * @param {string} file - Absolute path.
 * @returns {object|undefined} Parsed object, or undefined when unusable.
 */
function readJson (file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * Write JSON atomically through a temporary file in the same directory.
 * @param {string} file - Destination path.
 * @param {object} value - Serializable value.
 * @returns {void}
 */
function writeJsonAtomic (file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${String(process.pid)}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  fs.renameSync(temporary, file)
}

/**
 * Coerce a value into a valid TCP port.
 * @param {unknown} value - Candidate value.
 * @param {number} fallback - Port to use when invalid.
 * @returns {number} A usable port.
 */
function normalizePort (value, fallback = DEFAULT_SETTINGS.port) {
  const port = typeof value === 'string' ? Number.parseInt(value, 10) : value
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) return fallback
  return port
}

/**
 * Apply environment overrides over stored settings.
 *
 * Environment wins so a shortcut can pin a port or a checkout without
 * rewriting the settings file.
 * @param {object} settings - Base settings.
 * @param {NodeJS.ProcessEnv} [env] - Environment to read.
 * @returns {object} Settings with overrides applied.
 */
function applyEnvironment (settings, env = process.env) {
  const result = { ...settings }
  if (env.DSH_LAUNCHER_PORT !== undefined && env.DSH_LAUNCHER_PORT !== '') {
    result.port = normalizePort(env.DSH_LAUNCHER_PORT, settings.port)
  }
  if (env.DSH_LAUNCHER_HOST !== undefined && env.DSH_LAUNCHER_HOST !== '') {
    result.host = env.DSH_LAUNCHER_HOST
  }
  if (env.DSH_LAUNCHER_DSH_PATH !== undefined && env.DSH_LAUNCHER_DSH_PATH !== '') {
    result.dshPath = env.DSH_LAUNCHER_DSH_PATH
  }
  if (env.DSH_LAUNCHER_NODE_PATH !== undefined && env.DSH_LAUNCHER_NODE_PATH !== '') {
    result.nodePath = env.DSH_LAUNCHER_NODE_PATH
  }
  return result
}

/**
 * Merge stored values over the defaults, keeping only known keys.
 * @param {object} stored - Raw stored object.
 * @returns {object} Complete settings object.
 */
function withDefaults (stored) {
  const merged = { ...DEFAULT_SETTINGS, ...stored }
  merged.port = normalizePort(merged.port)
  merged.extraArgs = Array.isArray(merged.extraArgs) ? merged.extraArgs.filter((v) => typeof v === 'string') : []
  merged.startupTimeoutMs = Number.isFinite(merged.startupTimeoutMs) && merged.startupTimeoutMs > 1000
    ? merged.startupTimeoutMs
    : DEFAULT_SETTINGS.startupTimeoutMs
  return merged
}

/**
 * Settings store backed by one JSON file.
 */
class SettingsStore {
  /**
   * @param {string} directory - Directory that holds the settings file.
   * @param {NodeJS.ProcessEnv} [env] - Environment for overrides.
   */
  constructor (directory, env = process.env) {
    this.file = path.join(directory, 'settings.json')
    this.env = env
    this.stored = withDefaults(readJson(this.file) ?? {})
  }

  /**
   * Effective settings for this launch.
   * @returns {object} Settings with environment overrides applied.
   */
  get () {
    return applyEnvironment(this.stored, this.env)
  }

  /**
   * Persist a partial update.
   * @param {object} patch - Keys to change.
   * @returns {object} The updated stored settings.
   */
  update (patch) {
    this.stored = withDefaults({ ...this.stored, ...patch })
    writeJsonAtomic(this.file, this.stored)
    return this.stored
  }

  /**
   * Remember the last window geometry.
   * @param {object} bounds - Electron window bounds.
   * @returns {void}
   */
  saveWindowBounds (bounds) {
    this.update({ windowBounds: bounds })
  }
}

/**
 * Record of the service this launcher started.
 *
 * The record carries the launch token on purpose. `dsh web` mints that token
 * per process and never persists it, so it doubles as proof of ownership: an
 * adopted pid whose token still completes the auth exchange is this
 * launcher's own orphan, while a token that is refused belongs to somebody
 * else's service and must be left alone.
 */
class OwnedServiceStore {
  /**
   * @param {string} directory - Directory that holds the state file.
   */
  constructor (directory) {
    this.file = path.join(directory, 'launcher-state.json')
    this.state = readJson(this.file) ?? {}
  }

  /**
   * The recorded service, when one is present.
   * @returns {{pid: number, port: number, url: string, token: string, startedAt: number, label: string}|undefined} Record.
   */
  get () {
    const record = this.state.ownedService
    if (typeof record !== 'object' || record === null) return undefined
    if (!Number.isInteger(record.pid) || record.pid <= 0) return undefined
    return record
  }

  /**
   * Persist a newly started service.
   * @param {object} record - Service record.
   * @returns {void}
   */
  set (record) {
    this.state.ownedService = record
    writeJsonAtomic(this.file, this.state)
  }

  /**
   * Forget the recorded service.
   * @returns {void}
   */
  clear () {
    delete this.state.ownedService
    writeJsonAtomic(this.file, this.state)
  }
}

module.exports = {
  DEFAULT_SETTINGS,
  OwnedServiceStore,
  SettingsStore,
  applyEnvironment,
  normalizePort,
  readJson,
  withDefaults,
  writeJsonAtomic
}
