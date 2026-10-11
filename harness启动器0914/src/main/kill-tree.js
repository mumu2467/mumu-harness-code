'use strict'

/**
 * Process-tree teardown.
 *
 * A launcher never owns the `dsh web` process directly: it owns the tool that
 * owns it (`npx` -> `node` -> `dsh`). Signalling only the direct child leaves
 * the real service alive holding the port, so teardown targets the whole tree
 * and verifies the port is actually released afterwards.
 */

const { spawn } = require('node:child_process')

/** How long a graceful signal gets before the tree is killed outright. */
const DEFAULT_GRACE_MS = 6000

/**
 * Is a process id still alive?
 * @param {number} pid - Process id to test.
 * @returns {boolean} True when the process exists.
 */
function isAlive (pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return error?.code === 'EPERM'
  }
}

/**
 * Send one signal to a process group or a single process, ignoring races.
 * @param {number} pid - Target process id.
 * @param {NodeJS.Signals} signal - Signal to deliver.
 * @param {boolean} group - Signal the whole POSIX process group.
 * @returns {boolean} True when the signal was delivered.
 */
function signalQuietly (pid, signal, group) {
  try {
    if (group) process.kill(-pid, signal)
    else process.kill(pid, signal)
    return true
  } catch (error) {
    // ESRCH simply means the process is already gone, which is success here.
    return error?.code === 'ESRCH'
  }
}

/**
 * Terminate a process tree.
 *
 * Windows has no process groups reachable from Node, so `taskkill /T` walks
 * the parent/child chain. POSIX trees are spawned detached, which makes the
 * child a process-group leader whose negative pid addresses every descendant.
 *
 * The Windows graceful attempt reports whether the tool actually accepted the
 * request. A console process cannot be closed gracefully, and taskkill says
 * so immediately, which lets the caller escalate at once instead of waiting
 * out a grace period that can never succeed.
 * @param {object} options - Teardown options.
 * @param {number} options.pid - Root process id.
 * @param {boolean} [options.group] - Treat pid as a POSIX process-group leader.
 * @param {boolean} [options.force] - Skip directly to an unconditional kill.
 * @param {string} [options.platform] - Platform override for tests.
 * @param {(command: string, args: string[]) => Promise<object|void>} [options.run] - Runner override for tests.
 * @returns {Promise<{ok: boolean, code?: number, output?: string}>} Whether the kill was accepted.
 */
async function killTree ({
  pid,
  group = false,
  force = false,
  platform = process.platform,
  run = defaultRun
}) {
  if (!Number.isInteger(pid) || pid <= 0) return { ok: true }
  if (platform === 'win32') {
    const args = ['/pid', String(pid), '/T']
    if (force) args.push('/F')
    const result = await run('taskkill', args)
    return {
      ok: result?.code === undefined || result.code === 0,
      code: result?.code,
      output: result?.output ?? ''
    }
  }
  return { ok: signalQuietly(pid, force ? 'SIGKILL' : 'SIGTERM', group) }
}

/**
 * Run a command to completion, reporting its exit code and combined output.
 * @param {string} command - Executable name.
 * @param {string[]} args - Arguments.
 * @returns {Promise<{code: number, output: string}>} Command result.
 */
function defaultRun (command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let output = ''
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => { output += String(chunk) })
    child.stderr?.on('data', (chunk) => { output += String(chunk) })
    child.once('error', (error) => { resolve({ code: -1, output: String(error.message) }) })
    child.once('close', (code) => { resolve({ code: code ?? 0, output }) })
  })
}

/**
 * Stop a spawned service and confirm it is gone.
 *
 * Escalation is deliberate: a graceful signal first, then an unconditional
 * kill, then a bounded liveness check. The returned outcome distinguishes a
 * clean stop from a process that outlived every signal so the caller can tell
 * the user the port is still held instead of silently pretending success.
 * @param {object} options - Stop options.
 * @param {import('node:child_process').ChildProcess} [options.child] - Spawned child.
 * @param {number} [options.pid] - Known pid when no child handle remains.
 * @param {boolean} [options.group] - Child leads a POSIX process group.
 * @param {number} [options.graceMs] - Grace period before escalation.
 * @param {string} [options.platform] - Platform override for tests.
 * @param {(command: string, args: string[]) => Promise<void>} [options.run] - Runner override for tests.
 * @param {number} [options.pollMs] - Liveness poll interval.
 * @returns {Promise<{stopped: boolean, escalated: boolean, pid: number|undefined}>} Outcome.
 */
async function stopTree ({
  child,
  pid,
  group = false,
  graceMs = DEFAULT_GRACE_MS,
  platform = process.platform,
  run = defaultRun,
  pollMs = 200
}) {
  const target = Number.isInteger(pid) ? pid : child?.pid
  if (!Number.isInteger(target) || target <= 0) return { stopped: true, escalated: false, pid: undefined }

  const exited = new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) { resolve(); return }
    child.once('close', () => { resolve() })
  })

  const gracefulAttempt = await killTree({ pid: target, group, force: false, platform, run })

  // A graceful Windows kill that taskkill already refused cannot succeed by
  // waiting, so escalate immediately instead of stalling the window close.
  const waitMs = gracefulAttempt.ok ? graceMs : 0
  const graceful = waitMs === 0
    ? false
    : await Promise.race([
      exited.then(() => true),
      delay(waitMs).then(() => false)
    ])
  if (graceful && !isAlive(target)) return { stopped: true, escalated: false, pid: target }

  await killTree({ pid: target, group, force: true, platform, run })

  const deadline = Date.now() + graceMs
  while (Date.now() < deadline) {
    if (!isAlive(target)) return { stopped: true, escalated: true, pid: target }
    await delay(pollMs)
  }
  return { stopped: !isAlive(target), escalated: true, pid: target }
}

/**
 * Sleep helper.
 * @param {number} ms - Milliseconds to wait.
 * @returns {Promise<void>} Resolves after the delay.
 */
function delay (ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

module.exports = { isAlive, killTree, stopTree, DEFAULT_GRACE_MS }
