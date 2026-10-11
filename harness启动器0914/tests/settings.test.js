'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const settings = require('../src/main/settings')

/** Create a temporary directory removed when the test ends. */
function tempDirectory (t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-launcher-settings-'))
  t.after(() => { fs.rmSync(directory, { recursive: true, force: true }) })
  return directory
}

test('normalizePort accepts only usable ports', () => {
  assert.equal(settings.normalizePort(3080), 3080)
  assert.equal(settings.normalizePort('4096'), 4096)
  assert.equal(settings.normalizePort(0, 3080), 3080)
  assert.equal(settings.normalizePort(-1, 3080), 3080)
  assert.equal(settings.normalizePort(70000, 3080), 3080)
  assert.equal(settings.normalizePort('abc', 3080), 3080)
  assert.equal(settings.normalizePort(undefined, 3080), 3080)
})

test('withDefaults fills gaps and repairs invalid stored values', () => {
  const merged = settings.withDefaults({ port: 'nonsense', extraArgs: ['--x', 7], startupTimeoutMs: 5 })
  assert.equal(merged.port, settings.DEFAULT_SETTINGS.port)
  assert.deepEqual(merged.extraArgs, ['--x'])
  assert.equal(merged.startupTimeoutMs, settings.DEFAULT_SETTINGS.startupTimeoutMs)
  assert.equal(merged.host, settings.DEFAULT_SETTINGS.host)
})

test('applyEnvironment lets the environment pin a port and paths', () => {
  const base = settings.withDefaults({ port: 3080 })
  const overridden = settings.applyEnvironment(base, {
    DSH_LAUNCHER_PORT: '4567',
    DSH_LAUNCHER_DSH_PATH: '/opt/dsh/bin.js',
    DSH_LAUNCHER_NODE_PATH: '/usr/bin/node'
  })
  assert.equal(overridden.port, 4567)
  assert.equal(overridden.dshPath, '/opt/dsh/bin.js')
  assert.equal(overridden.nodePath, '/usr/bin/node')
  // An empty value must not clobber a stored setting.
  assert.equal(settings.applyEnvironment(base, { DSH_LAUNCHER_PORT: '' }).port, 3080)
})

test('SettingsStore persists updates and survives a corrupt file', (t) => {
  const directory = tempDirectory(t)
  const store = new settings.SettingsStore(directory, {})
  assert.equal(store.get().port, 3080)

  store.update({ port: 4100, dshPath: '/tmp/dsh.js' })
  assert.equal(store.get().port, 4100)

  const reopened = new settings.SettingsStore(directory, {})
  assert.equal(reopened.get().port, 4100)
  assert.equal(reopened.get().dshPath, '/tmp/dsh.js')

  fs.writeFileSync(path.join(directory, 'settings.json'), '{ not json', 'utf8')
  const recovered = new settings.SettingsStore(directory, {})
  assert.equal(recovered.get().port, 3080, 'a corrupt file falls back to defaults')
})

test('OwnedServiceStore records, reads, and clears ownership', (t) => {
  const directory = tempDirectory(t)
  const store = new settings.OwnedServiceStore(directory)
  assert.equal(store.get(), undefined)

  store.set({ pid: 4242, port: 3080, token: 'abc', url: 'http://127.0.0.1:3080/?token=abc', startedAt: 1, label: 'x' })
  const reopened = new settings.OwnedServiceStore(directory)
  assert.equal(reopened.get().pid, 4242)
  assert.equal(reopened.get().token, 'abc')

  reopened.clear()
  assert.equal(new settings.OwnedServiceStore(directory).get(), undefined)
})

test('OwnedServiceStore ignores a record without a usable pid', (t) => {
  const directory = tempDirectory(t)
  fs.writeFileSync(path.join(directory, 'launcher-state.json'), JSON.stringify({ ownedService: { port: 3080 } }), 'utf8')
  assert.equal(new settings.OwnedServiceStore(directory).get(), undefined)
})
