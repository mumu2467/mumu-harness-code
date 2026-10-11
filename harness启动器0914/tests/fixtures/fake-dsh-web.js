'use strict'

/**
 * A stand-in for `dsh web` used by the launcher's own tests.
 *
 * It reproduces the contract the launcher depends on, taken from the Harness
 * CLI: the readiness line with its per-process token, the 303 token exchange
 * that mints a session cookie, the authenticated entry document carrying the
 * boot marker, and the fixed 401 body used to identify the service.
 */

const http = require('node:http')
const crypto = require('node:crypto')

const AUTH_BODY = 'dsh web authentication required; reopen the URL printed by dsh web.'
const INDEX = '<!doctype html><html><head><script>window.__DSH_BOOT__ = {"mode":"test"}</script>'
  + '</head><body>harness</body></html>'
const COOKIE_NAME = 'dsh-auth-test'

/**
 * Read the value following a flag.
 * @param {string[]} argv - Raw arguments.
 * @param {string} name - Flag name.
 * @returns {string|undefined} Flag value.
 */
function flag (argv, name) {
  const index = argv.indexOf(name)
  return index === -1 ? undefined : argv[index + 1]
}

const argv = process.argv.slice(2)
const host = flag(argv, '--host') ?? '127.0.0.1'
const requestedPort = Number(flag(argv, '--port') ?? '0')
// A fresh token per process, exactly as the real CLI mints one per process.
const token = crypto.randomBytes(32).toString('base64url')

const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`)
  const offered = url.searchParams.getAll('token')

  if (request.method === 'GET' && url.pathname === '/' && offered.length === 1 && offered[0] === token) {
    response.writeHead(303, {
      location: '/',
      'cache-control': 'no-store',
      'set-cookie': `${COOKIE_NAME}=granted; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict`
    })
    response.end()
    return
  }

  const cookie = String(request.headers.cookie ?? '')
  if (request.method === 'GET' && url.pathname === '/' && cookie.includes(`${COOKIE_NAME}=granted`)) {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(INDEX)
    return
  }

  response.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
  response.end(AUTH_BODY)
})

server.listen(requestedPort, host, () => {
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : requestedPort
  process.stdout.write(`dsh web: http://${host}:${String(port)}/?token=${token}\n`)
})

process.on('SIGTERM', () => {
  server.close(() => { process.exit(0) })
})
