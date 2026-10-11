'use strict'

/**
 * End-to-end tests for the service manager.
 *
 * These spawn the real fixture process and talk to it over a real socket, so
 * they cover the parts that unit tests cannot: readiness detection from the
 * printed line, the token exchange, ownership proof, and the promise that a
 * borrowed service is never stopped.
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')

const probe = require('../src/main/probe')
const { Logger } = require('../src/main/logger')
const { OwnedServiceStore, SettingsStore } = require('../src/main/settings')
const { LauncherError, ServerManager, tokenOf, rootUrlOf, tokenUrlFor } = require('../src/main/server-manager')
const { createCookieFetch } = require('./helpers/cookie-fetch')

const FIXTURE = path.join(__dirname, 'fixtures', 'fake-dsh-web.js')

/** Allocate a port nothing is listening on. */
function freePort () {
  return probe.findFreePort({ prefer: 38000 + Math.floor(Math.random() * 1500), attempts: 60 })
}

/**
 * Create an isolated launcher harness.
 * @param {object} t - Node test context.
 * @param {object} [overrides] - Settings to persist.
 * @param {object} [options] - Harness options.
 * @param {string} [options.directory] - Reuse a directory, to simulate a second launch.
 * @param {Function} [options.fetchImpl] - Cookie source; fresh by default.
 * @returns {object} Harness handles.
 */
function harness (t, overrides = {}, { directory, fetchImpl } = {}) {
  const dir = directory ?? fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-launcher-test-'))
  if (directory === undefined) {
    t.after(() => { fs.rmSync(dir, { recursive: true, force: true }) })
  }
  // An empty environment keeps ambient DSH_LAUNCHER_* variables out of tests.
  const settingsStore = new SettingsStore(dir, {})
  settingsStore.update({ dshPath: FIXTURE, nodePath: process.execPath, ...overrides })
  const stateStore = new OwnedServiceStore(dir)
  const logger = new Logger({ directory: dir, echo: false })
  const manager = new ServerManager({
    settingsStore,
    stateStore,
    logger,
    fetchImpl: fetchImpl ?? createCookieFetch(),
    env: process.env,
    isPackaged: false
  })
  return { dir, settingsStore, stateStore, logger, manager }
}

/**
 * Start the fixture directly, as another tool would.
 * @param {number} port - Port to bind.
 * @returns {Promise<{child: object, tokenUrl: string}>} Running fixture.
 */
function startForeignService (port) {
  const child = spawn(process.execPath, [FIXTURE, 'web', '--port', String(port), '--no-open'], {
    stdio: ['ignore', 'pipe', 'ignore'],
    detached: process.platform !== 'win32'
  })
  return new Promise((resolve, reject) => {
    let buffered = ''
    const timer = setTimeout(() => { reject(new Error('fixture never reported readiness')) }, 15000)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buffered += chunk
      const match = /dsh web: (\S+)/u.exec(buffered)
      if (match?.[1] === undefined) return
      clearTimeout(timer)
      resolve({ child, tokenUrl: match[1] })
    })
    child.once('error', reject)
  })
}

/** Stop a fixture started by the test itself. */
function killForeign (child) {
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    else process.kill(-child.pid, 'SIGKILL')
  } catch { /* already gone */ }
}

test('tokenOf and rootUrlOf split the readiness URL correctly', () => {
  const url = 'http://127.0.0.1:3080/?token=abc-123_XYZ'
  assert.equal(tokenOf(url), 'abc-123_XYZ')
  assert.equal(rootUrlOf(url), 'http://127.0.0.1:3080/')
  assert.equal(tokenOf('not a url'), '')
})

test('tokenUrlFor re-attaches a token instead of trusting a tokenless stored URL', () => {
  const record = { pid: 1, port: 3080, token: 'secret', url: 'http://127.0.0.1:3080/' }
  assert.equal(tokenUrlFor(record, '127.0.0.1'), 'http://127.0.0.1:3080/?token=secret')
  assert.equal(tokenUrlFor(record, '127.0.0.1', 4100), 'http://127.0.0.1:4100/?token=secret')
  assert.equal(tokenUrlFor({ port: 3080, url: 'http://127.0.0.1:3080/' }, '127.0.0.1'), 'http://127.0.0.1:3080/')
})

test('start spawns the service, captures the token, and stop releases the port', async (t) => {
  const port = await freePort()
  const { manager, stateStore } = harness(t, { port })

  const outcome = await manager.start()
  assert.equal(outcome.mode, 'started')
  assert.equal(outcome.owned, true, 'a service it started is owned')
  assert.equal(outcome.authenticated, true, 'the launch token authenticates the UI')
  assert.match(outcome.url, /\?token=/u)

  const record = stateStore.get()
  assert.ok(record.pid > 0)
  assert.ok(record.token.length >= 32, 'the per-process launch token was captured')
  assert.equal(record.port, port)

  const stopped = await manager.stop()
  assert.equal(stopped.stopped, true)
  assert.equal(stopped.owned, true)
  assert.equal(stateStore.get(), undefined, 'the ownership record is cleared')

  const after = await probe.probeService({ port, timeoutMs: 2000 })
  assert.equal(after.state, probe.FREE, 'the port is released')
})

test('a session with a stored cookie reuses a service without a token', async (t) => {
  const port = await freePort()
  const foreign = await startForeignService(port)
  t.after(() => { killForeign(foreign.child) })

  // Exchange the token once, exactly as the first launch would.
  const jar = createCookieFetch()
  const first = harness(t, { port }, { fetchImpl: jar })
  const exchanged = await first.manager.exchangeToken(foreign.tokenUrl)
  assert.equal(exchanged.ok, true)

  // A second launch sharing that cookie jar needs no token at all.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-launcher-reuse-'))
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }) })
  const { manager, stateStore } = harness(t, { port }, { directory: dir, fetchImpl: jar })

  const outcome = await manager.start()
  assert.equal(outcome.mode, 'reused')
  assert.equal(outcome.owned, false, 'a foreign service is not owned')
  assert.equal(outcome.authenticated, true, 'the persisted cookie still authenticates')
  assert.equal(stateStore.get(), undefined, 'reuse records no ownership')

  const stopped = await manager.stop()
  assert.equal(stopped.owned, false, 'there is nothing to stop')
  assert.equal((await probe.probeService({ port })).state, probe.DSH, 'the borrowed service keeps running')
})

test('a foreign service without a session is reused but demands a token', async (t) => {
  const port = await freePort()
  const foreign = await startForeignService(port)
  t.after(() => { killForeign(foreign.child) })

  const { manager } = harness(t, { port })
  const outcome = await manager.start()
  assert.equal(outcome.mode, 'reused')
  assert.equal(outcome.owned, false)
  assert.equal(outcome.authenticated, false, 'the launcher must not claim it can load the UI')

  // The supplied token then completes the exchange and yields a session.
  const exchanged = await manager.exchangeToken(foreign.tokenUrl)
  assert.equal(exchanged.ok, true)
  assert.equal(await manager.sessionAuthenticated(`http://127.0.0.1:${String(port)}/`), true)

  await manager.stop()
  assert.equal((await probe.probeService({ port })).state, probe.DSH, 'a borrowed service is never stopped')
})

test('a service recorded by an earlier launch is adopted and then stopped', async (t) => {
  const port = await freePort()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-launcher-adopt-'))
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  // First launch: start the service, then abandon the manager as a crash would.
  const first = harness(t, { port }, { directory: dir })
  const started = await first.manager.start()
  assert.equal(started.mode, 'started')
  const pid = first.stateStore.get().pid

  // Second launch: a fresh cookie jar, but the same record on disk.
  const { manager, stateStore } = harness(t, { port }, { directory: dir })
  const outcome = await manager.start()
  assert.equal(outcome.mode, 'adopted', 'ownership is recovered from the launch token')
  assert.equal(outcome.owned, true, 'an adopted service is owned again')
  assert.equal(outcome.authenticated, true)
  assert.equal(stateStore.get().pid, pid, 'the same process was adopted')

  const stopped = await manager.stop()
  assert.equal(stopped.stopped, true)
  assert.equal((await probe.probeService({ port, timeoutMs: 2000 })).state, probe.FREE, 'the adopted service is stopped')
})

test('a stale record whose process is gone is discarded, not adopted', async (t) => {
  const port = await freePort()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-launcher-stale-'))
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  const first = harness(t, { port }, { directory: dir })
  await first.manager.start()
  await first.manager.stop()

  // The record was cleared by stop, so rebuild a stale one by hand.
  const stateStore = new OwnedServiceStore(dir)
  stateStore.set({ pid: 999999, port, token: 'stale', url: `http://127.0.0.1:${String(port)}/`, startedAt: 1, label: 'stale' })

  const { manager } = harness(t, { port }, { directory: dir })
  const outcome = await manager.start()
  assert.equal(outcome.mode, 'started', 'a dead record does not block a fresh start')
  await manager.stop()
})

test('a record whose token is refused is treated as somebody else and never killed', async (t) => {
  const port = await freePort()
  const foreign = await startForeignService(port)
  t.after(() => { killForeign(foreign.child) })

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-launcher-forged-'))
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }) })
  const stateStore = new OwnedServiceStore(dir)
  // Claim ownership of a live process without holding its real token.
  stateStore.set({ pid: foreign.child.pid, port, token: 'not-the-real-token', url: `http://127.0.0.1:${String(port)}/`, startedAt: 1, label: 'forged' })

  const { manager } = harness(t, { port }, { directory: dir })
  const outcome = await manager.start()
  assert.equal(outcome.mode, 'reused', 'a refused token means the service is not ours')
  assert.equal(outcome.owned, false)

  await manager.stop()
  assert.equal((await probe.probeService({ port })).state, probe.DSH, 'the innocent service survives')
})

test('a non-Harness program on the port fails with actionable copy', async (t) => {
  const port = await freePort()
  const http = require('node:http')
  const decoy = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end('<html>an unrelated app</html>')
  })
  await new Promise((resolve) => { decoy.listen(port, '127.0.0.1', resolve) })
  t.after(() => { decoy.close() })

  const { manager } = harness(t, { port })
  await assert.rejects(manager.start(), (error) => {
    assert.ok(error instanceof LauncherError)
    assert.equal(error.code, 'port-taken')
    assert.match(error.hint, /port/iu)
    return true
  })
})

test('fallbackToFreePort starts elsewhere when the port is taken by a stranger', async (t) => {
  const port = await freePort()
  const http = require('node:http')
  const decoy = http.createServer((_request, response) => { response.end('busy') })
  await new Promise((resolve) => { decoy.listen(port, '127.0.0.1', resolve) })
  t.after(() => { decoy.close() })

  const { manager } = harness(t, { port, fallbackToFreePort: true })
  const outcome = await manager.start()
  assert.equal(outcome.mode, 'started')
  assert.notEqual(outcome.port, port, 'a different port was chosen')
  assert.equal(outcome.authenticated, true)
  await manager.stop()
})

test('a service that dies before readiness reports an exit error with the log tail', async (t) => {
  const port = await freePort()
  const failing = path.join(os.tmpdir(), `dsh-failing-${String(Date.now())}.js`)
  fs.writeFileSync(failing, "process.stderr.write('boom: cannot start\\n'); process.exit(3)\n", 'utf8')
  t.after(() => { fs.rmSync(failing, { force: true }) })

  const { manager } = harness(t, { port, dshPath: failing, startupTimeoutMs: 20000 })
  await assert.rejects(manager.start(), (error) => {
    assert.ok(error instanceof LauncherError)
    assert.equal(error.code, 'exited')
    assert.ok(error.problems.some((line) => line.includes('boom: cannot start')), 'the log tail is attached')
    return true
  })
})
