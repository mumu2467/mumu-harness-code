'use strict'

/**
 * Splash-screen copy in the two languages the launcher ships.
 *
 * The renderer receives a resolved dictionary, so the main process stays the
 * single owner of locale selection and the renderer never needs a locale API.
 */

const DICTIONARIES = {
  zh: {
    appTitle: 'DeepSeek Harness 启动器',
    stageChecking: '正在检查 3080 端口…',
    stageFound: '检测到已有 Harness 服务，正在复用…',
    stageStarting: '正在启动 dsh web 服务…',
    stageDownloading: '首次运行需要下载 dsh，请稍候…',
    stageWaiting: '服务已启动，正在等待就绪…',
    stageAuthenticating: '正在验证访问令牌…',
    stageLoading: '正在加载 Web 界面…',
    stageStopping: '正在停止服务…',
    stageReady: '就绪',
    errorTitle: '启动失败',
    errorPortTaken: '端口 {port} 已被其他程序占用',
    errorPortTakenHint: '该端口上运行的不是 Harness 服务。请关闭占用该端口的程序，或改用其他端口。',
    errorStartTimeout: '等待服务就绪超时',
    errorStartTimeoutHint: 'dsh 在 {seconds} 秒内没有就绪。若为首次运行，请确认网络可以访问 npm 仓库。',
    errorExited: 'dsh 进程已退出（退出码 {code}）',
    errorExitedHint: '请查看下方日志。首次运行可能未能下载 @deepseek-ai/dsh。',
    errorNoDsh: '未找到可用的 dsh 运行环境',
    errorNoDshHint: '请先从 https://nodejs.org 安装 Node.js 20 或更高版本，然后重试；'
      + '也可以在 settings.json 中把 dshPath 指向已有的 dsh 入口文件。',
    errorAuthRequired: '需要访问令牌',
    errorAuthRequiredHint: '该端口已有 Harness 服务，但它由其他终端启动，本启动器无法取得它的令牌。'
      + '请把终端里打印的完整地址（形如 http://127.0.0.1:3080/?token=…）粘贴到下面。',
    labelPort: '端口',
    labelToken: '令牌地址',
    tokenPlaceholder: 'http://127.0.0.1:3080/?token=…',
    actionRetry: '重试',
    actionChangePort: '更换端口',
    actionSubmitToken: '使用该地址打开',
    actionOpenExternal: '用系统浏览器打开',
    actionCopyDiagnostics: '复制诊断信息',
    actionCopied: '已复制',
    actionShowLog: '显示日志',
    actionHideLog: '隐藏日志',
    actionQuit: '退出',
    actionRestart: '重新启动服务',
    noteReused: '正在使用已在运行的服务；关闭窗口不会停止它。',
    noteOwned: '服务由本启动器启动；关闭窗口时会自动停止。'
  },
  en: {
    appTitle: 'DeepSeek Harness Launcher',
    stageChecking: 'Checking port 3080…',
    stageFound: 'An existing Harness service was found; reusing it…',
    stageStarting: 'Starting the dsh web service…',
    stageDownloading: 'First run downloads dsh, this can take a while…',
    stageWaiting: 'Service started, waiting for readiness…',
    stageAuthenticating: 'Verifying the access token…',
    stageLoading: 'Loading the Web UI…',
    stageStopping: 'Stopping the service…',
    stageReady: 'Ready',
    errorTitle: 'Startup failed',
    errorPortTaken: 'Port {port} is held by another program',
    errorPortTakenHint: 'Whatever answers there is not a Harness service. Close that program or choose another port.',
    errorStartTimeout: 'Timed out waiting for the service',
    errorStartTimeoutHint: 'dsh was not ready within {seconds}s. On a first run, confirm npm can be reached.',
    errorExited: 'The dsh process exited (code {code})',
    errorExitedHint: 'Read the log below. A first run may have failed to download @deepseek-ai/dsh.',
    errorNoDsh: 'No way to run dsh was found',
    errorNoDshHint: 'Install Node.js 20 or newer from https://nodejs.org, then retry. '
      + 'You can also point dshPath in settings.json at an existing dsh entry file.',
    errorAuthRequired: 'An access token is required',
    errorAuthRequiredHint: 'A Harness service already holds this port but was started elsewhere, so its token is '
      + 'unavailable to this launcher. Paste the full URL printed in that terminal (for example '
      + 'http://127.0.0.1:3080/?token=…).',
    labelPort: 'Port',
    labelToken: 'Token URL',
    tokenPlaceholder: 'http://127.0.0.1:3080/?token=…',
    actionRetry: 'Retry',
    actionChangePort: 'Change port',
    actionSubmitToken: 'Open this URL',
    actionOpenExternal: 'Open in system browser',
    actionCopyDiagnostics: 'Copy diagnostics',
    actionCopied: 'Copied',
    actionShowLog: 'Show log',
    actionHideLog: 'Hide log',
    actionQuit: 'Quit',
    actionRestart: 'Restart service',
    noteReused: 'Using an already running service; closing this window will not stop it.',
    noteOwned: 'Started by this launcher; closing the window stops it automatically.'
  }
}

/**
 * Pick a dictionary for a locale tag.
 * @param {string} [locale] - Electron locale such as `zh-CN`.
 * @returns {{code: string, strings: object}} Locale code and dictionary.
 */
function selectDictionary (locale = '') {
  const normalized = String(locale).toLowerCase()
  const code = normalized.startsWith('zh') ? 'zh' : 'en'
  return { code, strings: DICTIONARIES[code] }
}

module.exports = { DICTIONARIES, selectDictionary }
