'use strict'

/**
 * Launcher logging.
 *
 * Two audiences share one stream: a bounded in-memory tail that the splash
 * screen can render when startup fails, and an append-only file that survives
 * the process so a crash after the window closed is still diagnosable.
 */

const fs = require('node:fs')
const path = require('node:path')
const { EventEmitter } = require('node:events')

/** Lines retained in memory for the splash screen. */
const RING_SIZE = 400

/** Rotate the log once it exceeds this size. */
const MAX_LOG_BYTES = 2 * 1024 * 1024

/**
 * Timestamped logger with a shared ring buffer.
 */
class Logger extends EventEmitter {
  /**
   * @param {object} options - Logger options.
   * @param {string} options.directory - Directory for the log file.
   * @param {string} [options.fileName] - Log file name.
   * @param {boolean} [options.echo] - Also write to the parent stdout.
   */
  constructor ({ directory, fileName = 'launcher.log', echo = true }) {
    super()
    this.setMaxListeners(0)
    this.echo = echo
    this.file = path.join(directory, fileName)
    this.ring = []
    try {
      fs.mkdirSync(directory, { recursive: true })
      if (fs.existsSync(this.file) && fs.statSync(this.file).size > MAX_LOG_BYTES) {
        fs.renameSync(this.file, `${this.file}.1`)
      }
    } catch { /* logging must never break startup */ }
  }

  /**
   * Append one line.
   * @param {string} level - Severity label.
   * @param {string} message - Message text.
   * @returns {void}
   */
  write (level, message) {
    const text = String(message).replace(/\s+$/u, '')
    if (text === '') return
    const line = `${new Date().toISOString()} [${level}] ${text}`
    this.ring.push(line)
    if (this.ring.length > RING_SIZE) this.ring.splice(0, this.ring.length - RING_SIZE)
    try {
      fs.appendFileSync(this.file, `${line}\n`, 'utf8')
    } catch { /* a full disk must not stop the launcher */ }
    if (this.echo) process.stdout.write(`${line}\n`)
    this.emit('line', line)
  }

  /**
   * Log an informational line.
   * @param {string} message - Message text.
   * @returns {void}
   */
  info (message) { this.write('info', message) }

  /**
   * Log a warning.
   * @param {string} message - Message text.
   * @returns {void}
   */
  warn (message) { this.write('warn', message) }

  /**
   * Log an error.
   * @param {string} message - Message text.
   * @returns {void}
   */
  error (message) { this.write('error', message) }

  /**
   * Derive a logger that prefixes every line, for child-process output.
   * @param {string} prefix - Prefix such as `dsh`.
   * @returns {{info: Function, warn: Function, error: Function}} Prefixed logger.
   */
  child (prefix) {
    return {
      info: (message) => { this.write('info', `[${prefix}] ${message}`) },
      warn: (message) => { this.write('warn', `[${prefix}] ${message}`) },
      error: (message) => { this.write('error', `[${prefix}] ${message}`) }
    }
  }

  /**
   * The most recent lines, oldest first.
   * @param {number} [count] - How many lines to return.
   * @returns {string[]} Retained lines.
   */
  tail (count = 60) {
    return this.ring.slice(-count)
  }
}

module.exports = { Logger, RING_SIZE }
