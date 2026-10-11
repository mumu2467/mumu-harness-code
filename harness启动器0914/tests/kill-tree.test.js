'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')

const { DEFAULT_GRACE_MS, isAlive, killTree, stopTree } = require('../src/main/kill-tree')

/** Access the POSIX-group mode this platform needs. */
const GROUP = process.platform !== 'win32'

/**
 * Spawn a two-level tree and report both pids.
 * @param {number} sleepMs - How long the processes linger.
 * @returns {Promise<{child: import('node:child_process').ChildProcess, grandchildPid: number}>} Tree handles.
 */
function spawnTree (sleepMs) {
  const script = [
    "const { spawn } = require('node:child_process')",
    `const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, ${String(sleepMs)})'], { stdio: 'ignore' })`,
    'process.stdout.write(String(grandchild.pid) + "\\n")',
    `setTimeout(() => {}, ${String(sleepMs)})`
  ].join(';')

  const child = spawn(process.execPath, ['-e', script], {
    stdio: ['ignore', 'pipe', 'ignore'],
    detached: GROUP
  })

  return new Promise((resolve, reject) => {
    let buffered = ''
    const timer = setTimeout(() => { reject(new Error('tree did not report its grandchild')) }, 10000)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buffered += chunk
      const line = buffered.split('\n')[0]
      if (line.trim() === '') return
      clearTimeout(timer)
      resolve({ child, grandchildPid: Number.parseInt(line, 10) })
    })
    child.once('error', reject)
  })
}

test('isAlive reports live and dead processes', async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' })
  assert.equal(isAlive(child.pid), true)
  const exited = new Promise((resolve) => { child.once('close', resolve) })
  child.kill()
  await exited
  assert.equal(isAlive(child.pid), false)

  assert.equal(isAlive(0), false)
  assert.equal(isAlive(-1), false)
  assert.equal(isAlive(undefined), false)
})

test('killTree ignores a pid that cannot be signalled', async () => {
  await killTree({ pid: 0 })
  await killTree({ pid: undefined })
  await killTree({ pid: -5 })
})

test('killTree uses taskkill with the tree flag on Windows', async () => {
  const calls = []
  await killTree({
    pid: 4321,
    platform: 'win32',
    run: async (command, args) => { calls.push([command, args]) }
  })
  assert.deepEqual(calls, [['taskkill', ['/pid', '4321', '/T']]])

  calls.length = 0
  await killTree({
    pid: 4321,
    force: true,
    platform: 'win32',
    run: async (command, args) => { calls.push([command, args]) }
  })
  assert.deepEqual(calls, [['taskkill', ['/pid', '4321', '/T', '/F']]])
})

test('stopTree terminates a child and every grandchild it started', async () => {
  const { child, grandchildPid } = await spawnTree(120000)
  assert.equal(isAlive(child.pid), true)
  assert.equal(isAlive(grandchildPid), true)

  const result = await stopTree({
    child,
    pid: child.pid,
    group: GROUP,
    graceMs: 4000
  })

  assert.equal(result.stopped, true)
  assert.equal(isAlive(child.pid), false, 'the direct child is gone')
  assert.equal(isAlive(grandchildPid), false, 'the grandchild holding the port is gone too')
})

test('stopTree reports success for a process that already exited', async () => {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' })
  await new Promise((resolve) => { child.once('close', resolve) })
  const result = await stopTree({ child, pid: child.pid, group: GROUP, graceMs: 500 })
  assert.equal(result.stopped, true)
})

test('stopTree escalates when a process ignores the graceful signal', async () => {
  // This process traps SIGTERM, so only an unconditional kill can end it.
  const stubborn = "process.on('SIGTERM', () => {}); setTimeout(() => {}, 120000)"
  const child = spawn(process.execPath, ['-e', stubborn], { stdio: 'ignore', detached: GROUP })
  await new Promise((resolve) => { setTimeout(resolve, 400) })

  const result = await stopTree({ child, pid: child.pid, group: GROUP, graceMs: 1200 })

  assert.equal(result.stopped, true)
  if (GROUP) {
    assert.equal(result.escalated, true, 'the graceful signal was not enough')
  }
  assert.equal(isAlive(child.pid), false)
})

test('the default grace period is long enough for a graceful shutdown', () => {
  assert.ok(DEFAULT_GRACE_MS >= 1000)
})
