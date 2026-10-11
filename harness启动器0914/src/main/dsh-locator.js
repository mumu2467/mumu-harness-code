'use strict'

/**
 * Discovery of a runnable `dsh` command.
 *
 * The launcher never assumes how Node was installed. It resolves a concrete
 * executable instead of relying on a shell to find one, because a GUI app
 * launched from Finder or a desktop shortcut inherits a minimal PATH that
 * does not contain nvm, Homebrew, or Volta shims.
 *
 * Resolution order, most explicit first:
 *   1. settings.dshPath      - path to a dsh entry file, run by a Node runtime
 *   2. settings.dshCommand   - a literal command string, run through a shell
 *   3. `dsh` on PATH         - an already installed CLI
 *   4. npm's npx-cli.js      - Node plus the npm that ships beside it
 *   5. `npx` on PATH         - last resort before failing with guidance
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

/** Published package the default launch strategy resolves. */
const DSH_PACKAGE = '@deepseek-ai/dsh'

/** Directories that commonly hold a Node install outside a GUI app's PATH. */
const POSIX_NODE_DIRS = ['/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin']

/** Raised when no launch strategy can be assembled. */
class DshUnavailableError extends Error {
  /**
   * @param {string} message - Human readable summary.
   * @param {object} [details] - Diagnostics for the splash screen.
   * @param {string[]} [details.problems] - Individual failed lookups.
   * @param {string} [details.hint] - Suggested fix.
   */
  constructor (message, { problems = [], hint = '' } = {}) {
    super(message)
    this.name = 'DshUnavailableError'
    this.problems = problems
    this.hint = hint
  }
}

/**
 * Path implementation for a target platform.
 *
 * Every path decision follows the requested platform rather than the host, so
 * resolution stays correct when the two differ and stays testable off-target.
 * @param {string} platform - Target platform.
 * @returns {typeof path.posix} Matching path module.
 */
function paths (platform) {
  return platform === 'win32' ? path.win32 : path.posix
}

/**
 * The flag tail every strategy shares.
 *
 * `--no-open` is essential: the Harness CLI would otherwise hand the URL to
 * the system browser, and this launcher owns that handoff itself.
 * @param {object} options - Argument options.
 * @param {number} options.port - Port the service should bind.
 * @param {string} [options.host] - Interface the service should bind.
 * @param {string[]} [options.extraArgs] - User supplied trailing arguments.
 * @returns {string[]} Arguments placed after the `web` profile selector.
 */
function webArguments ({ port, host = '127.0.0.1', extraArgs = [] }) {
  return ['web', '--host', host, '--port', String(port), '--no-open', ...extraArgs]
}

/**
 * Run a probe command, returning its trimmed stdout or an empty string.
 * @param {string} file - Executable to run.
 * @param {string[]} args - Arguments.
 * @param {object} [options] - Execution options.
 * @param {Function} [options.execFile] - Injected runner.
 * @param {number} [options.timeout] - Milliseconds before giving up.
 * @returns {string} Trimmed stdout.
 */
function tryExec (file, args, { execFile = execFileSync, timeout = 5000 } = {}) {
  try {
    const out = execFile(file, args, {
      encoding: 'utf8',
      timeout,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore']
    })
    return typeof out === 'string' ? out.trim() : ''
  } catch {
    return ''
  }
}

/**
 * Resolve an executable to an absolute path.
 * @param {string} name - Executable name without extension.
 * @param {object} [options] - Lookup options.
 * @param {string} [options.platform] - Platform to resolve for.
 * @param {NodeJS.ProcessEnv} [options.env] - Environment supplying PATH and SHELL.
 * @param {Function} [options.execFile] - Injected runner for probes.
 * @param {(candidate: string) => boolean} [options.exists] - File existence test.
 * @returns {string} Absolute path, or an empty string when nothing matched.
 */
function whichSync (name, {
  platform = process.platform,
  env = process.env,
  execFile,
  exists = fs.existsSync
} = {}) {
  const target = paths(platform)
  if (platform === 'win32') {
    const whereOutput = tryExec('where.exe', [name], { execFile })
    for (const line of whereOutput.split(/\r?\n/u)) {
      const candidate = line.trim()
      if (candidate !== '' && exists(candidate)) return candidate
    }
  }

  const pathValue = env.PATH ?? env.Path ?? ''
  const separator = platform === 'win32' ? ';' : ':'
  const extensions = platform === 'win32'
    ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : ['']
  for (const directory of pathValue.split(separator).filter(Boolean)) {
    for (const extension of extensions) {
      for (const suffix of extension === '' ? [''] : [extension, extension.toLowerCase()]) {
        const candidate = target.join(directory, `${name}${suffix}`)
        if (exists(candidate)) return candidate
      }
    }
  }

  for (const directory of platform === 'win32' ? [] : POSIX_NODE_DIRS) {
    const candidate = target.join(directory, name)
    if (exists(candidate)) return candidate
  }

  // nvm keeps every runtime under the home directory rather than on PATH.
  if (platform !== 'win32') {
    const home = env.HOME ?? os.homedir()
    const versions = target.join(home, '.nvm', 'versions', 'node')
    try {
      for (const version of fs.readdirSync(versions)) {
        const candidate = target.join(versions, version, 'bin', name)
        if (exists(candidate)) return candidate
      }
    } catch { /* no nvm installation */ }
  }

  // A login shell rebuilds the PATH a desktop launch stripped away. This is
  // the usual reason a macOS app cannot find nvm or Homebrew Node.
  if (platform !== 'win32') {
    const shell = env.SHELL ?? (platform === 'darwin' ? '/bin/zsh' : '/bin/sh')
    const resolved = tryExec(shell, ['-ilc', `command -v -- ${name}`], { execFile })
    const candidate = resolved.split(/\r?\n/u).map((line) => line.trim()).find((line) => line.startsWith('/'))
    if (candidate !== undefined && exists(candidate)) return candidate
  }

  return ''
}

/**
 * Locate npm's `npx-cli.js` beside a Node runtime.
 *
 * Running it through Node keeps the launcher free of a shell, which preserves
 * the ability to signal only the process tree it started.
 * @param {string} nodeExecutable - Resolved Node path.
 * @param {object} [options] - Lookup options.
 * @param {(candidate: string) => boolean} [options.exists] - File existence test.
 * @param {string} [options.platform] - Target platform.
 * @returns {string} Absolute path, or an empty string.
 */
function findNpxCli (nodeExecutable, { exists = fs.existsSync, platform = process.platform } = {}) {
  const target = paths(platform)
  const directories = []
  if (typeof nodeExecutable === 'string' && nodeExecutable !== '') {
    directories.push(target.dirname(nodeExecutable))
  }
  if (platform !== 'win32') directories.push(...POSIX_NODE_DIRS)

  for (const directory of directories) {
    const candidates = [
      target.join(directory, 'node_modules', 'npm', 'bin', 'npx-cli.js'),
      target.join(directory, '..', 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js')
    ]
    for (const candidate of candidates) {
      const resolved = target.resolve(candidate)
      if (exists(resolved)) return resolved
    }
  }
  return ''
}

/**
 * Windows cannot execute a `.cmd`/`.bat` shim without a shell.
 * @param {string} command - Resolved executable path.
 * @param {string} platform - Target platform.
 * @returns {boolean} True when the command needs `shell: true`.
 */
function needsShell (command, platform) {
  return platform === 'win32' && /\.(cmd|bat)$/iu.test(command)
}

/**
 * Quote one argument for shell mode.
 * @param {string} value - Raw argument.
 * @returns {string} Argument safe to append to a shell command line.
 */
function shellQuote (value) {
  if (/^[\w@%/.:=+-]+$/u.test(value)) return value
  return `"${value.replaceAll('"', '\\"')}"`
}

/**
 * Choose a launch strategy.
 * @param {object} options - Resolution options.
 * @param {number} options.port - Port the service should bind.
 * @param {string} [options.host] - Interface the service should bind.
 * @param {object} [options.settings] - Launcher settings.
 * @param {string} [options.platform] - Target platform.
 * @param {NodeJS.ProcessEnv} [options.env] - Environment used for lookups.
 * @param {Function} [options.execFile] - Injected runner for probes.
 * @param {(candidate: string) => boolean} [options.exists] - File existence test.
 * @param {string} [options.nodeExecPath] - Runtime to fall back to.
 * @param {boolean} [options.isPackaged] - Whether the Electron app is packaged.
 * @returns {{command: string, args: string[], shell: boolean, source: string, env: object, label: string}} Launch plan.
 * @throws {DshUnavailableError} When nothing can run dsh.
 */
function buildLaunchPlan (options = {}) {
  const {
    port,
    host = '127.0.0.1',
    settings = {},
    platform = process.platform,
    env = process.env,
    execFile,
    exists = fs.existsSync,
    nodeExecPath = process.execPath,
    isPackaged = false
  } = options

  const problems = []
  const extraArgs = Array.isArray(settings.extraArgs) ? settings.extraArgs : []
  const webArgs = webArguments({ port, host, extraArgs })

  /** Attach the runtime overrides a chosen command needs. */
  const finish = (command, args, { source, node }) => {
    const launchEnv = {}
    // A packaged app's own executable is Electron, not Node; this is the
    // documented switch that turns it into a plain Node runtime.
    if (node !== undefined && node === nodeExecPath && isPackaged) {
      launchEnv.ELECTRON_RUN_AS_NODE = '1'
    }
    return {
      command,
      args,
      shell: needsShell(command, platform),
      source,
      env: launchEnv,
      label: [command, ...args].map(shellQuote).join(' ')
    }
  }

  // 1. An explicit dsh entry file.
  if (typeof settings.dshPath === 'string' && settings.dshPath !== '') {
    const entry = paths(platform).resolve(settings.dshPath)
    if (!exists(entry)) {
      problems.push(`dshPath does not exist: ${entry}`)
    } else {
      const node = settings.nodePath || whichSync('node', { platform, env, execFile, exists }) || nodeExecPath
      if (!exists(node) && node !== nodeExecPath) problems.push(`nodePath does not exist: ${node}`)
      else return finish(node, [entry, ...webArgs], { source: 'dshPath', node })
    }
  }

  // 2. A literal command string owned by the user, run through a shell.
  if (typeof settings.dshCommand === 'string' && settings.dshCommand !== '') {
    return {
      command: settings.dshCommand,
      args: webArgs,
      shell: true,
      source: 'dshCommand',
      env: {},
      label: [settings.dshCommand, ...webArgs.map(shellQuote)].join(' ')
    }
  }

  // 3. An installed CLI on PATH.
  const dshBinary = whichSync('dsh', { platform, env, execFile, exists })
  if (dshBinary !== '') {
    return finish(dshBinary, webArgs, { source: 'path' })
  }
  problems.push('`dsh` was not found on PATH')

  // 4. Node plus the npm that ships beside it, without a shell.
  const node = settings.nodePath || whichSync('node', { platform, env, execFile, exists })
  if (node !== '') {
    const npxCli = findNpxCli(node, { exists, platform })
    if (npxCli !== '') {
      return finish(node, [npxCli, '-y', DSH_PACKAGE, ...webArgs], { source: 'npx-cli', node })
    }
    problems.push(`npx-cli.js was not found beside Node at ${node}`)
  } else {
    problems.push('`node` was not found on PATH')
  }

  // 5. The npx shim itself.
  const npxBinary = whichSync('npx', { platform, env, execFile, exists })
  if (npxBinary !== '') {
    return finish(npxBinary, ['-y', DSH_PACKAGE, ...webArgs], { source: 'npx' })
  }
  problems.push('`npx` was not found on PATH')

  throw new DshUnavailableError(
    'No way to run dsh was found on this computer.',
    {
      problems,
      hint: 'Install Node.js 20 or newer from https://nodejs.org, then retry. '
        + 'Alternatively set dshPath in settings.json to an existing dsh entry file.'
    }
  )
}

/** Human readable summary of what each strategy means. */
const SOURCE_LABELS = {
  dshPath: 'configured dsh entry file',
  dshCommand: 'configured dsh command',
  path: 'dsh on PATH',
  'npx-cli': 'Node with npm npx-cli.js',
  npx: 'npx on PATH'
}

module.exports = {
  DSH_PACKAGE,
  DshUnavailableError,
  SOURCE_LABELS,
  buildLaunchPlan,
  findNpxCli,
  needsShell,
  shellQuote,
  webArguments,
  whichSync
}
