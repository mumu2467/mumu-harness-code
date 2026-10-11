'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')

const probe = require('../src/main/probe')
const { createCookieFetch } = require('./helpers/cookie-fetch')

/** Start a throwaway HTTP server. */
function serve (handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler)
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port })
    })
  })
}

/** Stop a throwaway server. */
function close (server) {
  return new Promise((resolve) => { server.close(resolve) })
}

test('classifyResponse identifies the Harness service from either signal', () => {
  assert.equal(probe.classifyResponse(401, probe.AUTH_FINGERPRINT), probe.DSH)
  assert.equal(probe.classifyResponse(401, `${probe.AUTH_FINGERPRINT}; reopen the URL printed by dsh web.`), probe.DSH)
  assert.equal(probe.classifyResponse(200, `<script>window.${probe.BOOT_MARKER}={}</script>`), probe.DSH)
  assert.equal(probe.classifyResponse(303, ''), probe.DSH)
})

test('classifyResponse refuses to mistake another program for Harness', () => {
  assert.equal(probe.classifyResponse(200, '<html>some other app</html>'), probe.FOREIGN)
  assert.equal(probe.classifyResponse(401, 'Unauthorized'), probe.FOREIGN)
  assert.equal(probe.classifyResponse(404, 'not found'), probe.FOREIGN)
  assert.equal(probe.classifyResponse(500, ''), probe.FOREIGN)
})

test('probeService reports a free port when nothing listens', async () => {
  const { server, port } = await serve((_req, res) => { res.end('x') })
  await close(server)
  const result = await probe.probeService({ port, timeoutMs: 1200 })
  assert.equal(result.state, probe.FREE)
})

test('probeService identifies a Harness service and a foreign one', async () => {
  const harness = await serve((_req, res) => {
    res.writeHead(401, { 'content-type': 'text/plain' })
    res.end(probe.AUTH_FINGERPRINT)
  })
  const foreign = await serve((_req, res) => { res.writeHead(200); res.end('hello') })
  try {
    assert.equal((await probe.probeService({ port: harness.port })).state, probe.DSH)
    const other = await probe.probeService({ port: foreign.port })
    assert.equal(other.state, probe.FOREIGN)
    assert.match(other.detail, /without the Harness fingerprint/u)
  } finally {
    await close(harness.server)
    await close(foreign.server)
  }
})

test('probeAuthenticated requires the authenticated document, not merely identity', async () => {
  const fake = await serve((request, response) => {
    if (String(request.headers.cookie ?? '').includes('granted=yes')) {
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end(`<script>window.${probe.BOOT_MARKER}={}</script>`)
      return
    }
    response.writeHead(401, { 'content-type': 'text/plain' })
    response.end(probe.AUTH_FINGERPRINT)
  })
  try {
    // A 401 that identifies the service must not count as authenticated.
    const outcome = await probe.probeAuthenticated(`http://127.0.0.1:${String(fake.port)}/`, createCookieFetch())
    assert.equal(outcome.state, probe.DSH, 'identity is recognized')
    assert.equal(outcome.authenticated, false, 'but the caller is not authenticated')
    assert.equal(outcome.status, 401)
  } finally {
    await close(fake.server)
  }
})

test('waitForService resolves once Harness answers and reports a timeout otherwise', async () => {
  const harness = await serve((_req, res) => {
    res.writeHead(401, { 'content-type': 'text/plain' })
    res.end(probe.AUTH_FINGERPRINT)
  })
  const foreign = await serve((_req, res) => { res.writeHead(200); res.end('nope') })
  try {
    const found = await probe.waitForService({ port: harness.port, timeoutMs: 3000, intervalMs: 100 })
    assert.equal(found.state, probe.DSH)

    const missed = await probe.waitForService({ port: foreign.port, timeoutMs: 500, intervalMs: 100 })
    assert.equal(missed.timedOut, true)
  } finally {
    await close(harness.server)
    await close(foreign.server)
  }
})

test('findFreePort returns a bindable port and skips an occupied one', async () => {
  const taken = await serve((_req, res) => { res.end('x') })
  try {
    const port = await probe.findFreePort({ prefer: taken.port, attempts: 25 })
    assert.notEqual(port, taken.port)
    assert.ok(port > taken.port)
  } finally {
    await close(taken.server)
  }
})
