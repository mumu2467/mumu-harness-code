'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const {
  DshUnavailableError,
  buildLaunchPlan,
  findNpxCli,
  needsShell,
  shellQuote,
  webArguments,
  whichSync
} = require('../src/main/dsh-locator')

/** An `exists` stub that recognizes an explicit set of paths. */
const onlyThese = (paths) => (candidate) => paths.includes(candidate)

/** An `execFile` stub that must never run. */
const noProbe = () => { throw new Error('probe must not run') }

test('webArguments always suppresses the external browser handoff', () => {
  assert.deepEqual(webArguments({ port: 3080 }), [
    'web', '--host', '127.0.0.1', '--port', '3080', '--no-open'
  ])
  assert.deepEqual(webArguments({ port: 4100, host: 'localhost', extraArgs: ['--verbose'] }), [
    'web', '--host', 'localhost', '--port', '4100', '--no-open', '--verbose'
  ])
})

test('configured dshPath is run by a Node runtime and wins over PATH', () => {
  const plan = buildLaunchPlan({
    port: 3080,
    settings: { dshPath: '/opt/dsh/bin.js' },
    platform: 'linux',
    env: { PATH: '/usr/bin' },
    nodeExecPath: '/usr/bin/node',
    exists: onlyThese(['/opt/dsh/bin.js', '/usr/bin/node']),
    execFile: noProbe
  })
  assert.equal(plan.source, 'dshPath')
  assert.equal(plan.command, '/usr/bin/node')
  assert.deepEqual(plan.args, [
    '/opt/dsh/bin.js', 'web', '--host', '127.0.0.1', '--port', '3080', '--no-open'
  ])
  assert.equal(plan.shell, false)
})

test('a missing dshPath is reported instead of silently ignored', () => {
  assert.throws(() => buildLaunchPlan({
    port: 3080,
    settings: { dshPath: '/opt/missing.js', dshCommand: '' },
    platform: 'linux',
    env: { PATH: '/usr/bin' },
    nodeExecPath: '/usr/bin/node',
    exists: onlyThese([]),
    execFile: noProbe
  }), (error) => {
    assert.ok(error instanceof DshUnavailableError)
    assert.ok(error.problems.some((line) => line.includes('/opt/missing.js')))
    return true
  })
})

test('a configured command string is run through a shell', () => {
  const plan = buildLaunchPlan({
    port: 3080,
    settings: { dshCommand: 'pnpm dlx @deepseek-ai/dsh' },
    platform: 'linux',
    env: {},
    exists: onlyThese([]),
    execFile: noProbe
  })
  assert.equal(plan.source, 'dshCommand')
  assert.equal(plan.shell, true)
  assert.match(plan.label, /pnpm dlx @deepseek-ai\/dsh web/u)
})

test('a CLI on PATH is preferred over npx strategies', () => {
  const plan = buildLaunchPlan({
    port: 3080,
    settings: {},
    platform: 'linux',
    env: { PATH: '/fake/bin' },
    exists: onlyThese(['/fake/bin/dsh']),
    execFile: noProbe
  })
  assert.equal(plan.source, 'path')
  assert.equal(plan.command, '/fake/bin/dsh')
  assert.equal(plan.shell, false)
})

test('Node with npm npx-cli.js is used without a shell when dsh is absent', () => {
  const npxCli = '/fake/bin/node_modules/npm/bin/npx-cli.js'
  const plan = buildLaunchPlan({
    port: 3080,
    settings: {},
    platform: 'linux',
    env: { PATH: '/fake/bin' },
    exists: onlyThese(['/fake/bin/node', npxCli]),
    execFile: noProbe
  })
  assert.equal(plan.source, 'npx-cli')
  assert.equal(plan.command, '/fake/bin/node')
  assert.equal(plan.args[0], npxCli)
  assert.deepEqual(plan.args.slice(1, 3), ['-y', '@deepseek-ai/dsh'])
  assert.equal(plan.shell, false, 'no shell means the process tree stays signalable')
})

test('the npx shim is the last resort and needs a shell on Windows', () => {
  const plan = buildLaunchPlan({
    port: 3080,
    settings: {},
    platform: 'win32',
    env: { PATH: 'C:\\nodejs', PATHEXT: '.CMD' },
    exists: onlyThese(['C:\\nodejs\\npx.CMD']),
    execFile: noProbe
  })
  assert.equal(plan.source, 'npx')
  assert.equal(plan.shell, true, 'a .cmd shim cannot be spawned directly')
  assert.deepEqual(plan.args.slice(0, 2), ['-y', '@deepseek-ai/dsh'])
})

test('a packaged app turns its own executable into the Node runtime', () => {
  const plan = buildLaunchPlan({
    port: 3080,
    settings: { dshPath: '/opt/dsh/bin.js' },
    platform: 'linux',
    env: { PATH: '' },
    nodeExecPath: '/Applications/Launcher.app/Contents/MacOS/Launcher',
    isPackaged: true,
    exists: onlyThese(['/opt/dsh/bin.js']),
    execFile: noProbe
  })
  assert.equal(plan.env.ELECTRON_RUN_AS_NODE, '1')
})

test('nothing available raises guidance rather than an obscure spawn error', () => {
  assert.throws(() => buildLaunchPlan({
    port: 3080,
    settings: {},
    platform: 'linux',
    env: { PATH: '' },
    exists: onlyThese([]),
    execFile: noProbe
  }), (error) => {
    assert.ok(error instanceof DshUnavailableError)
    assert.match(error.hint, /nodejs\.org/u)
    assert.equal(error.problems.length, 3)
    return true
  })
})

test('whichSync scans PATH and honors PATHEXT on Windows', () => {
  assert.equal(whichSync('dsh', {
    platform: 'linux',
    env: { PATH: '/a:/b' },
    exists: onlyThese(['/b/dsh']),
    execFile: noProbe
  }), '/b/dsh')

  assert.equal(whichSync('dsh', {
    platform: 'win32',
    env: { PATH: 'C:\\a;C:\\b', PATHEXT: '.EXE;.CMD' },
    exists: onlyThese(['C:\\b\\dsh.CMD']),
    execFile: noProbe
  }), 'C:\\b\\dsh.CMD')

  assert.equal(whichSync('dsh', {
    platform: 'linux',
    env: { PATH: '/a' },
    exists: onlyThese([]),
    execFile: noProbe
  }), '')
})

test('findNpxCli looks beside Node and in the global npm layouts', () => {
  const beside = '/usr/bin/node_modules/npm/bin/npx-cli.js'
  assert.equal(findNpxCli('/usr/bin/node', { exists: onlyThese([beside]), platform: 'linux' }), beside)

  const global = path.posix.resolve('/usr/local/lib/node_modules/npm/bin/npx-cli.js')
  assert.equal(findNpxCli('/nothing/node', { exists: onlyThese([global]), platform: 'linux' }), global)
  assert.equal(findNpxCli('', { exists: onlyThese([]), platform: 'linux' }), '')
})

test('needsShell only fires for Windows command shims', () => {
  assert.equal(needsShell('C:\\nodejs\\npx.cmd', 'win32'), true)
  assert.equal(needsShell('C:\\nodejs\\npx.BAT', 'win32'), true)
  assert.equal(needsShell('C:\\nodejs\\dsh.exe', 'win32'), false)
  assert.equal(needsShell('/usr/bin/npx', 'linux'), false)
  assert.equal(needsShell('/usr/bin/npx.cmd', 'linux'), false)
})

test('shellQuote leaves safe arguments alone and quotes the rest', () => {
  assert.equal(shellQuote('--port'), '--port')
  assert.equal(shellQuote('@deepseek-ai/dsh'), '@deepseek-ai/dsh')
  assert.equal(shellQuote('/Program Files/dsh.js'), '"/Program Files/dsh.js"')
  assert.equal(shellQuote('a"b'), '"a\\"b"')
})
