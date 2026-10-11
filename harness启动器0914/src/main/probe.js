'use strict'

/**
 * Service fingerprinting for a locally running `dsh web` instance.
 *
 * `dsh web` answers every unauthenticated request with a fixed, recognizable
 * 401 body, and the authenticated frontend document carries the boot marker
 * that only the Harness Web runner injects. Between them the two signals
 * identify a Harness service positively, so a launcher never mistakes an
 * unrelated program that happens to hold the port for a reusable service.
 */

const http = require('node:http')

/** Status code family `dsh web` uses to refuse an unauthenticated request. */
const UNAUTHORIZED = 401

/** Exact body prefix of the Harness 401 response. */
const AUTH_FINGERPRINT = 'dsh web authentication required'

/** Marker present only in the Harness Web entry document. */
const BOOT_MARKER = '__DSH_BOOT__'

/** Redirect the Harness token exchange answers with. */
const TOKEN_EXCHANGE_REDIRECT = 303

/** Service states a probe can report. */
const FREE = 'free'
const DSH = 'dsh'
const FOREIGN = 'foreign'

/** Cap on how much of a response body is retained for fingerprinting. */
const MAX_BODY_BYTES = 64 * 1024

/**
 * Decide what a single HTTP response says about the process behind a port.
 * Pure so the fingerprint rules stay unit-testable without a socket.
 * @param {number} status - HTTP status code.
 * @param {string} body - Response body, possibly truncated.
 * @returns {typeof FREE | typeof DSH | typeof FOREIGN} Classification.
 */
function classifyResponse (status, body) {
  const text = typeof body === 'string' ? body : ''
  if (status === 200 && text.includes(BOOT_MARKER)) return DSH
  if (status === UNAUTHORIZED && text.includes(AUTH_FINGERPRINT)) return DSH
  if (status === TOKEN_EXCHANGE_REDIRECT) return DSH
  return FOREIGN
}

/**
 * Error codes that prove nothing is listening on the address.
 * A refused or unreachable socket is the only evidence of a free port.
 */
const FREE_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EADDRNOTAVAIL',
  'ENOTFOUND'
])

/**
 * Read the body of a response, bounded so a hostile or chatty peer cannot
 * exhaust memory.
 * @param {import('node:http').IncomingMessage} res - Response stream.
 * @returns {Promise<string>} Decoded body.
 */
function readBounded (res) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    res.on('data', (chunk) => {
      if (size >= MAX_BODY_BYTES) return
      chunks.push(chunk)
      size += chunk.length
    })
    res.on('end', () => { resolve(Buffer.concat(chunks).toString('utf8')) })
    res.on('error', reject)
  })
}

/**
 * Perform one bounded GET request.
 * @param {string} url - Absolute request URL.
 * @param {number} timeoutMs - Socket and overall inactivity budget.
 * @returns {Promise<{status: number, headers: object, body: string}>} Response.
 */
function httpGet (url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { headers: { accept: 'text/html,text/plain,*/*' } }, (res) => {
      readBounded(res).then(
        (body) => { resolve({ status: res.statusCode ?? 0, headers: res.headers, body }) },
        reject
      )
    })
    request.setTimeout(timeoutMs, () => {
      const error = new Error(`probe timed out after ${String(timeoutMs)}ms`)
      error.code = 'ETIMEDOUT'
      request.destroy(error)
    })
    request.on('error', reject)
  })
}

/**
 * Probe one port and classify whatever answers.
 * @param {object} options - Probe options.
 * @param {string} [options.host] - Host to probe.
 * @param {number} options.port - Port to probe.
 * @param {number} [options.timeoutMs] - Per-attempt timeout.
 * @returns {Promise<{state: string, status?: number, detail?: string}>} Result.
 */
async function probeService ({ host = '127.0.0.1', port, timeoutMs = 2500 }) {
  const url = `http://${host}:${String(port)}/`
  try {
    const res = await httpGet(url, timeoutMs)
    const state = classifyResponse(res.status, res.body)
    const result = { state, status: res.status, url }
    if (state === FOREIGN) {
      result.detail = `HTTP ${String(res.status)} without the Harness fingerprint`
    }
    return result
  } catch (error) {
    const code = error?.code
    if (code === 'ETIMEDOUT') {
      return { state: FOREIGN, url, detail: 'the port accepted a connection but never answered' }
    }
    if (FREE_ERROR_CODES.has(code)) return { state: FREE, url, detail: code }
    return { state: FOREIGN, url, detail: `${String(code ?? 'error')}: ${error?.message ?? ''}`.trim() }
  }
}

/**
 * Poll a port until the service answers with the Harness fingerprint.
 * @param {object} options - Wait options.
 * @param {string} [options.host] - Host to probe.
 * @param {number} options.port - Port to probe.
 * @param {number} [options.timeoutMs] - Overall budget.
 * @param {number} [options.intervalMs] - Delay between attempts.
 * @param {() => boolean} [options.shouldStop] - Abort predicate, e.g. child exit.
 * @param {(result: object) => void} [options.onAttempt] - Attempt observer.
 * @returns {Promise<{state: string, status?: number, detail?: string}>} Final probe.
 */
async function waitForService ({
  host = '127.0.0.1',
  port,
  timeoutMs = 180000,
  intervalMs = 500,
  shouldStop,
  onAttempt
}) {
  const deadline = Date.now() + timeoutMs
  let last = { state: FREE }
  for (;;) {
    last = await probeService({ host, port, timeoutMs: Math.min(2500, intervalMs + 2000) })
    if (onAttempt) onAttempt(last)
    if (last.state === DSH) return last
    if (shouldStop && shouldStop()) return { ...last, stopped: true }
    if (Date.now() >= deadline) return { ...last, timedOut: true }
    await new Promise((resolve) => { setTimeout(resolve, intervalMs) })
  }
}

/**
 * Ask whether a session already holds a valid Harness browser cookie.
 *
 * The distinction matters: a 401 carrying the Harness fingerprint proves the
 * service is dsh but proves the caller is *not* authenticated. Only the
 * authenticated entry document counts as success, so this deliberately does
 * not reuse the identity classification for its verdict.
 * @param {string} url - Harness root URL to request.
 * @param {(url: string, init: object) => Promise<{status: number, text: () => Promise<string>}>} fetchImpl - Cookie-aware fetch.
 * @returns {Promise<{authenticated: boolean, state: string, status?: number}>} Outcome.
 */
async function probeAuthenticated (url, fetchImpl) {
  try {
    const res = await fetchImpl(url, { credentials: 'include', redirect: 'follow' })
    const body = await res.text()
    const state = classifyResponse(res.status, body)
    return {
      authenticated: res.status === 200 && body.includes(BOOT_MARKER),
      state,
      status: res.status
    }
  } catch (error) {
    return { authenticated: false, state: FOREIGN, detail: error?.message }
  }
}

/**
 * Find a free TCP port starting from a preferred number.
 * @param {object} options - Search options.
 * @param {string} [options.host] - Interface to bind-test.
 * @param {number} [options.prefer] - First candidate.
 * @param {number} [options.attempts] - How many candidates to try.
 * @returns {Promise<number>} A port nothing is listening on.
 */
async function findFreePort ({ host = '127.0.0.1', prefer = 3080, attempts = 40 }) {
  const net = require('node:net')
  for (let offset = 0; offset < attempts; offset += 1) {
    const port = prefer + offset
    if (port > 65535) break
    const free = await new Promise((resolve) => {
      const server = net.createServer()
      server.once('error', () => { resolve(false) })
      server.once('listening', () => { server.close(() => { resolve(true) }) })
      server.listen(port, host)
    })
    if (free) return port
  }
  throw new Error(`no free port found in range ${String(prefer)}-${String(prefer + attempts - 1)}`)
}

module.exports = {
  AUTH_FINGERPRINT,
  BOOT_MARKER,
  DSH,
  FOREIGN,
  FREE,
  classifyResponse,
  findFreePort,
  probeAuthenticated,
  probeService,
  waitForService
}
