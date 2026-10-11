'use strict'

/**
 * Lifecycle owner for the `dsh web` service.
 *
 * Three distinct relationships a service can have with this launcher drive
 * every decision here:
 *
 *   started - this launcher spawned it, so closing the window must stop it.
 *   adopted - a previous run of this launcher spawned it and the recorded
 *             launch token still authenticates, so ownership is recovered and
 *             closing the window must stop it.
 *   reused  - something else started it (another terminal, another tool). The
 *             launcher only borrows the UI and must never stop it.
 *
 * The launch token is what makes that distinction trustworthy. `dsh web`
 * mints the token inside its own process and never writes it to disk, so a
 * token that still completes the auth exchange is proof the process is ours;
 * a refused token means the service belongs to somebody else.
 */

const os = require('node:os')
const { spawn } = require('node:child_process')
const { EventEmitter } = require('node:events')

const probe = require('./probe')
const { DshUnavailableError, SOURCE_LABELS, buildLaunchPlan } = require('./dsh-locator')
const { isAlive, stopTree } = require('./kill-tree')

/** Readiness line the Harness CLI prints once its whole tree has settled. */
const READY_PATTERN = /dsh web: (http:\/\/\S+)/u

/** Upper bound on retained child output used for diagnostics. */
const OUTPUT_LIMIT = 200000

/** A launcher failure with copy the splash screen can present directly. */
class LauncherError extends Error {
  /**
   * @param {string} message - Summary shown as the headline.
   * @param {object} [details] - Presentation details.
   * @param {string} [details.code] - Stable identifier for the renderer.
   * @param {string} [details.hint] - Suggested next step.
   * @param {string[]} [details.problems] - Individual failed lookups.
   * @param {object} [details.values] - Values the localized copy interpolates.
   */
  constructor (message, { code = 'launcher-error', hint = '', problems = [], values = {} } = {}) {
    super(message)
    this.name = 'LauncherError'
    this.code = code
    this.hint = hint
    this.problems = problems
    this.values = values
  }
}

/**
 * Extract the launch token from a readiness URL.
 * @param {string} url - URL printed by the Harness CLI.
 * @returns {string} Token, or an empty string.
 */
function tokenOf (url) {
  try {
    return new URL(url).searchParams.get('token') ?? ''
  } catch {
    return ''
  }
}

/**
 * Reduce a readiness URL to its bare origin root.
 * @param {string} url - Any URL on the service.
 * @returns {string} `scheme://authority/`.
 */
function rootUrlOf (url) {
  try {
    const parsed = new URL(url)
    return `${parsed.protocol}//${parsed.host}/`
  } catch {
    return url
  }
}

/**
 * Rebuild the authenticated URL from a stored record.
 *
 * The record stores the tokenless root URL for display, so ownership
 * verification has to re-attach the launch token rather than trusting the
 * stored URL to carry it.
 * @param {object} record - Stored service record.
 * @param {string} host - Host to address.
 * @param {number} [port] - Port override, defaulting to the recorded one.
 * @returns {string} URL carrying the launch token.
 */
function tokenUrlFor (record, host, port) {
  const target = Number.isInteger(port) ? port : record.port
  if (typeof record.token === 'string' && record.token !== '') {
    return `http://${host}:${String(target)}/?token=${encodeURIComponent(record.token)}`
  }
  return typeof record.url === 'string' ? record.url : `http://${host}:${String(target)}/`
}

/**
 * Service lifecycle manager.
 * @fires ServerManager#status
 * @fires ServerManager#output
 */
class ServerManager extends EventEmitter {
  /**
   * @param {object} options - Manager options.
   * @param {import('./settings').SettingsStore} options.settingsStore - Settings store.
   * @param {import('./settings').OwnedServiceStore} options.stateStore - Ownership record store.
   * @param {import('./logger').Logger} options.logger - Logger.
   * @param {Function} [options.fetchImpl] - Cookie-aware fetch, normally `session.fetch`.
   * @param {NodeJS.ProcessEnv} [options.env] - Environment for child processes and lookups.
   * @param {string} [options.platform] - Platform override for tests.
   * @param {boolean} [options.isPackaged] - Whether the Electron app is packaged.
   */
  constructor ({
    settingsStore,
    stateStore,
    logger,
    fetchImpl,
    env = process.env,
    platform = process.platform,
    isPackaged = false
  }) {
    super()
    this.setMaxListeners(0)
    this.settingsStore = settingsStore
    this.stateStore = stateStore
    this.logger = logger
    this.fetchImpl = fetchImpl ?? ((url, init) => fetch(url, init))
    this.env = env
    this.platform = platform
    this.isPackaged = isPackaged

    this.child = null
    this.owned = null
    this.phase = 'idle'
    this.outputBuffer = ''
    this.usingFallbackPort = false
    this.starting = false
  }

  /**
   * Announce a phase change.
   * @param {string} phase - Machine-readable phase.
   * @param {object} [detail] - Extra fields for the renderer.
   * @returns {void}
   */
  emitStatus (phase, detail = {}) {
    this.phase = phase
    this.emit('status', { phase, ...detail })
  }

  /**
   * Current lifecycle state.
   * @returns {{phase: string, owned: object|null, pid: number|undefined, port: number}} State snapshot.
   */
  status () {
    return {
      phase: this.phase,
      owned: this.owned,
      pid: this.child?.pid ?? this.owned?.pid,
      port: this.owned?.port ?? this.settingsStore.get().port
    }
  }

  /**
   * Ask whether the persistent session already holds a valid Harness cookie.
   * @param {string} rootUrl - Service root URL.
   * @returns {Promise<boolean>} True when the UI can be loaded without a token.
   */
  async sessionAuthenticated (rootUrl) {
    const result = await probe.probeAuthenticated(rootUrl, this.fetchImpl)
    return result.authenticated
  }

  /**
   * Complete a token exchange, which also stores the session cookie.
   * @param {string} url - URL carrying the launch token.
   * @returns {Promise<{ok: boolean, status?: number}>} Exchange outcome.
   */
  async exchangeToken (url) {
    const result = await probe.probeAuthenticated(url, this.fetchImpl)
    return { ok: result.authenticated, status: result.status }
  }

  /**
   * Start, adopt, or reuse a service on the configured port.
   * @returns {Promise<{mode: string, port: number, url: string, owned: boolean, authenticated: boolean}>} Outcome.
   * @throws {LauncherError} When start-up cannot proceed.
   */
  async start () {
    if (this.starting) throw new LauncherError('A start is already in progress.', { code: 'busy' })
    this.starting = true
    try {
      const settings = this.settingsStore.get()
      let port = settings.port
      this.emitStatus('checking', { port })

      // A service this launcher left behind on another port must not linger
      // silently once the record is overwritten.
      if (settings.killOrphanedService) await this.reconcileRecord({ settings, port })

      if (settings.reuseRunningService || settings.killOrphanedService) {
        const existing = await probe.probeService({ host: settings.host, port, timeoutMs: 2500 })
        this.logger.info(`probe ${settings.host}:${String(port)} -> ${existing.state}${existing.detail ? ` (${existing.detail})` : ''}`)

        if (existing.state === probe.DSH) {
          const outcome = await this.handleExistingService({ settings, port })
          if (outcome !== undefined) return outcome
        } else if (existing.state === probe.FOREIGN) {
          const taken = new LauncherError(
            `Port ${String(port)} is held by another program.`,
            {
              code: 'port-taken',
              hint: 'Close the program using that port, or choose a different port.',
              problems: [existing.detail ?? 'the port answered without the Harness fingerprint']
            }
          )
          if (!settings.fallbackToFreePort) throw taken
          port = await probe.findFreePort({ host: settings.host, prefer: port + 1 })
          this.usingFallbackPort = true
          this.logger.warn(`port ${String(settings.port)} is unavailable; falling back to ${String(port)}`)
          this.emitStatus('starting', { port, fallback: true })
        }
      }

      return await this.spawnService({ settings, port })
    } finally {
      this.starting = false
    }
  }

  /**
   * Settle the record a previous launch left behind before the port is used.
   *
   * A live record on the target port is left for the adoption path. A live
   * record on a *different* port would otherwise be forgotten when the record
   * is overwritten, so it is verified by token and then stopped.
   * @param {object} options - Reconciliation inputs.
   * @param {object} options.settings - Effective settings.
   * @param {number} options.port - Port this launch targets.
   * @returns {Promise<void>} Resolves once the stale record is settled.
   */
  async reconcileRecord ({ settings, port }) {
    const record = this.stateStore.get()
    if (record === undefined) return
    if (!isAlive(record.pid)) {
      this.logger.info(`recorded pid ${String(record.pid)} is gone; clearing the stale record`)
      this.stateStore.clear()
      return
    }
    if (record.port === port) return

    const candidate = tokenUrlFor(record, settings.host)
    const exchanged = await this.exchangeToken(candidate)
    if (!exchanged.ok) {
      this.logger.warn(`pid ${String(record.pid)} refused its recorded token; leaving it alone`)
      this.stateStore.clear()
      return
    }
    this.logger.info(`stopping the service this launcher left running on port ${String(record.port)}`)
    await stopTree({ pid: record.pid, group: this.platform !== 'win32', platform: this.platform })
    this.stateStore.clear()
  }

  /**
   * Decide what to do about a port that already answers as Harness.
   * @param {object} options - Decision inputs.
   * @param {object} options.settings - Effective settings.
   * @param {number} options.port - Port that answered.
   * @returns {Promise<object|undefined>} Outcome, or undefined to start a fresh service.
   */
  async handleExistingService ({ settings, port }) {
    const rootUrl = `http://${settings.host}:${String(port)}/`
    this.emitStatus('found', { port })
    const record = this.stateStore.get()

    // Ownership first: an orphan of our own must not be mistaken for a
    // stranger's service, or its lifecycle would leak forever.
    if (settings.killOrphanedService
      && record !== undefined && record.port === port
      && typeof record.token === 'string' && record.token !== '') {
      const candidate = tokenUrlFor(record, settings.host, port)
      const exchanged = await this.exchangeToken(candidate)
      if (exchanged.ok) {
        this.owned = {
          pid: record.pid,
          port,
          token: record.token,
          url: rootUrl,
          label: record.label ?? 'adopted',
          startedAt: record.startedAt ?? Date.now()
        }
        this.stateStore.set({ ...record, port, url: candidate })
        this.logger.info(`adopted the service this launcher started earlier (pid ${String(record.pid)})`)
        this.emitStatus('adopted', { port, pid: record.pid })
        return { mode: 'adopted', port, url: rootUrl, owned: true, authenticated: true }
      }
      this.logger.warn(`recorded pid ${String(record.pid)} refused its own launch token; treating it as foreign`)
      this.stateStore.clear()
    }

    if (!settings.reuseRunningService) {
      throw new LauncherError(
        `A Harness service already runs on port ${String(port)} and reuse is disabled.`,
        {
          code: 'reuse-disabled',
          hint: 'Close the terminal running that service, or enable reuseRunningService in settings.json.'
        }
      )
    }

    this.logger.info(`reusing the Harness service already listening on ${rootUrl}`)
    const authenticated = await this.sessionAuthenticated(rootUrl)
    if (authenticated) {
      this.logger.info('the stored browser session is still valid; no token needed')
    } else {
      this.logger.warn('no valid stored session; the launch token must be supplied to authenticate')
    }
    return { mode: 'reused', port, url: rootUrl, owned: false, authenticated }
  }

  /**
   * Build the launch plan for the current machine.
   * @param {object} options - Plan inputs.
   * @param {number} options.port - Port the service should bind.
   * @returns {object} Launch plan.
   * @throws {LauncherError} When no strategy exists.
   */
  buildPlan ({ port }) {
    const settings = this.settingsStore.get()
    try {
      return buildLaunchPlan({
        port,
        host: settings.host,
        settings,
        platform: this.platform,
        env: this.env,
        nodeExecPath: process.execPath,
        isPackaged: this.isPackaged
      })
    } catch (error) {
      if (error instanceof DshUnavailableError) {
        throw new LauncherError(error.message, {
          code: 'dsh-missing',
          hint: error.hint,
          problems: error.problems
        })
      }
      throw error
    }
  }

  /**
   * Spawn the service and wait until it is ready.
   * @param {object} options - Start inputs.
   * @param {object} options.settings - Effective settings.
   * @param {number} options.port - Port the service should bind.
   * @returns {Promise<{mode: string, port: number, url: string, owned: boolean, authenticated: boolean}>} Outcome.
   */
  async spawnService ({ settings, port }) {
    const plan = this.buildPlan({ port })
    this.emitStatus('starting', { port, source: plan.source, label: plan.label })
    this.logger.info(`launching via ${SOURCE_LABELS[plan.source] ?? plan.source}: ${plan.label}`)

    const workingDirectory = typeof settings.workingDirectory === 'string' && settings.workingDirectory !== ''
      ? settings.workingDirectory
      : os.homedir()

    this.outputBuffer = ''
    const child = spawn(plan.command, plan.args, {
      cwd: workingDirectory,
      env: { ...this.env, ...plan.env, DSH_LAUNCHER: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      // A POSIX process group is what lets teardown reach grandchildren.
      detached: this.platform !== 'win32',
      shell: plan.shell
    })
    this.child = child
    this.exitInfo = undefined

    child.once('error', (error) => {
      this.logger.error(`failed to spawn ${plan.command}: ${error.message}`)
      this.exitInfo = { code: null, error }
    })
    child.once('exit', (code, signal) => {
      this.exitInfo = { code, signal }
      this.logger.info(`dsh exited (code ${String(code)}, signal ${String(signal)})`)
    })
    this.wireOutput(child)

    const ready = await this.waitForReady({ child, host: settings.host, port, timeoutMs: settings.startupTimeoutMs })

    const token = tokenOf(ready.url)
    const rootUrl = rootUrlOf(ready.url)
    // A service that became ready without printing its URL gives no token, so
    // authentication has to be checked rather than assumed.
    const authenticated = token !== '' || await this.sessionAuthenticated(rootUrl)

    this.owned = {
      pid: child.pid,
      port,
      token,
      url: rootUrl,
      label: plan.label,
      startedAt: Date.now()
    }
    this.stateStore.set({ ...this.owned })
    this.emitStatus('ready', { port, mode: 'started' })
    this.logger.info(`service ready on ${rootUrl} (pid ${String(child.pid)})`)
    return {
      mode: 'started',
      port,
      url: ready.url,
      owned: true,
      authenticated
    }
  }

  /**
   * Forward child output to the log and watch for the readiness line.
   * @param {import('node:child_process').ChildProcess} child - Spawned service.
   * @returns {void}
   */
  wireOutput (child) {
    const consume = (chunk) => {
      const text = String(chunk)
      this.outputBuffer = (this.outputBuffer + text).slice(-OUTPUT_LIMIT)
      for (const line of text.split(/\r?\n/u)) {
        if (line.trim() !== '') this.logger.info(`dsh | ${line.trim()}`)
      }
      this.emit('output', text)
      const match = READY_PATTERN.exec(this.outputBuffer)
      if (match?.[1] !== undefined) this.onReadyLine?.(match[1])
    }
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', consume)
    child.stderr?.on('data', consume)
  }

  /**
   * Wait until the service is ready.
   *
   * The printed URL is authoritative because it carries the launch token, so
   * it wins whenever it appears. The port probe runs in parallel as a
   * fallback for a service that becomes ready without printing, and the
   * child's own failure always ends the wait immediately.
   * @param {object} options - Wait inputs.
   * @param {import('node:child_process').ChildProcess} options.child - Spawned service.
   * @param {string} options.host - Host to probe.
   * @param {number} options.port - Port to probe.
   * @param {number} options.timeoutMs - Overall budget.
   * @returns {Promise<{url: string}>} The readiness URL.
   * @throws {LauncherError} On timeout, early exit, or spawn failure.
   */
  async waitForReady ({ child, host, port, timeoutMs }) {
    // The readiness line may already have arrived while the spawn was being
    // wired up; without this check that output would be lost and the launcher
    // would fall back to the tokenless port probe.
    const already = READY_PATTERN.exec(this.outputBuffer)
    if (already?.[1] !== undefined) return { url: already[1] }

    let settle
    const promise = new Promise((resolve, reject) => { settle = { resolve, reject } })
    let done = false
    const finish = (error, value) => {
      if (done) return
      done = true
      this.onReadyLine = undefined
      if (error) settle.reject(error)
      else settle.resolve(value)
    }

    this.onReadyLine = (url) => { finish(null, { url }) }

    const failure = new Promise((_resolve, reject) => {
      child.once('error', (error) => {
        finish(new LauncherError(`Could not start dsh: ${error.message}`, {
          code: 'spawn-failed',
          hint: 'Confirm that the configured dsh command exists and is executable.'
        }))
        reject(error)
      })
      child.once('exit', (code) => {
        if (done) return
        finish(new LauncherError(`The dsh process exited before it became ready (code ${String(code)}).`, {
          code: 'exited',
          hint: 'Read the log below. A first run may have failed to download @deepseek-ai/dsh.',
          problems: this.logger.tail(12),
          values: { code: String(code) }
        }))
        reject(new Error('exited'))
      })
    })
    failure.catch(() => { /* settled through finish */ })

    const polling = (async () => {
      const result = await probe.waitForService({
        host,
        port,
        timeoutMs,
        intervalMs: 500,
        shouldStop: () => done
      })
      if (done) return
      if (result.state === probe.DSH) {
        // A service without a printed token can still be borrowed when the
        // stored session is valid; the caller re-checks authentication.
        finish(null, { url: `http://${host}:${String(port)}/` })
      } else {
        finish(new LauncherError(`The dsh service did not become ready within ${String(Math.round(timeoutMs / 1000))}s.`, {
          code: 'start-timeout',
          hint: 'On a first run the package download needs working network access.',
          problems: this.logger.tail(12)
        }))
      }
    })()
    polling.catch(() => { /* reported through finish */ })

    return promise
  }

  /**
   * Stop the service only when this launcher owns it.
   * @returns {Promise<{stopped: boolean, owned: boolean, portStillHeld?: boolean}>} Teardown outcome.
   */
  async stop () {
    if (this.owned === null) {
      this.logger.info('no owned service to stop')
      return { stopped: true, owned: false }
    }
    const settings = this.settingsStore.get()
    const { pid, port } = this.owned
    this.emitStatus('stopping', { port, pid })

    const result = await stopTree({
      child: this.child ?? undefined,
      pid,
      group: this.platform !== 'win32',
      platform: this.platform
    })
    this.logger.info(`stop pid ${String(pid)} -> stopped=${String(result.stopped)} escalated=${String(result.escalated)}`)

    if (!result.stopped) {
      this.logger.error(`pid ${String(pid)} survived every signal; the record is kept for the next launch`)
      return { stopped: false, owned: true }
    }

    this.stateStore.clear()
    this.child = null
    this.owned = null

    // A killed parent does not guarantee the port is free: an adopted or
    // grandchild process may still hold it.
    await new Promise((resolve) => { setTimeout(resolve, 300) })
    const after = await probe.probeService({ host: settings.host, port, timeoutMs: 2000 })
    if (after.state === probe.DSH) {
      this.logger.warn(`port ${String(port)} still answers as Harness after teardown`)
      return { stopped: true, owned: true, portStillHeld: true }
    }
    return { stopped: true, owned: true }
  }
}

module.exports = { LauncherError, READY_PATTERN, ServerManager, rootUrlOf, tokenOf, tokenUrlFor }
