# DeepSeek Harness 一键启动器

双击图标即可启动 **DeepSeek Harness（dsh）** Web UI 的桌面程序。它在后台运行
`dsh web`，等服务就绪后用内嵌窗口打开界面；关闭窗口时，只停掉**由它自己启动**的服务。

基于 Electron，支持 Windows（优先）、macOS 与 Linux。

---

## 1. 功能

| 需求 | 实现方式 |
|---|---|
| 双击图标自动后台启动 `dsh web` | 主进程解析本机可用的 dsh 运行方式，`spawn` 出服务并全程托管 |
| 自动检测服务就绪 | 解析 dsh 打印的就绪行（携带令牌），并行轮询 HTTP 端口作为兜底 |
| 就绪后打开**内嵌**窗口 | 同一个 `BrowserWindow` 从本地启动页导航到 Web UI，**不会**打开系统浏览器（显式传 `--no-open`） |
| 关闭窗口时停止自己启动的服务 | 关闭即停止整个进程树（Windows `taskkill /T`，POSIX 进程组信号），随后退出 |
| 3080 已有 dsh 服务则复用 | 通过指纹识别 + 浏览器会话 Cookie 复用；**绝不**停止不是自己启动的服务 |

额外能力：

- **归属可证明**：只有持有该进程的启动令牌，才认定服务"是自己启动的"，避免误杀他人服务。
- **崩溃后可接管**：上次启动器异常退出留下的服务，会在下次启动时被识别、接管，并在关闭窗口时正确停止。
- **单实例锁**：重复双击不会产生两个启动器争抢端口。
- **中英文界面**：跟随系统语言，可在 `settings.json` 中固定。
- **安全默认值**：`contextIsolation` + `sandbox` 开启、禁用 `nodeIntegration`、启动页使用严格 CSP、
  远程页面拿不到任何桥接 API、外部链接一律交给系统浏览器、令牌只允许发往回环地址。

---

## 2. 项目结构

```
dsh-launcher/
├── package.json                     # 依赖、脚本、Electron 入口
├── electron-builder.yml             # 打包配置（NSIS/portable、dmg/zip、AppImage/deb）
├── README.md
├── .gitignore
├── build/
│   └── icon.png                     # 由脚本生成的 1024×1024 图标（构建产物）
├── scripts/
│   ├── make-icon.mjs                # 无依赖生成图标（纯 zlib 手写 PNG）
│   └── preview-splash.js            # 开发用：截图预览启动页（不参与打包）
├── src/
│   ├── main/
│   │   ├── main.js                  # 主进程：窗口、IPC、启动流程、退出清理
│   │   ├── server-manager.js        # 核心：启动/复用/接管/停止服务
│   │   ├── dsh-locator.js           # 定位可运行的 dsh（PATH / npx / 指定路径）
│   │   ├── probe.js                 # 端口探测、服务指纹、令牌校验
│   │   ├── kill-tree.js             # 进程树终止与优雅→强制升级
│   │   ├── settings.js              # 配置与"自有服务"记录（原子写入）
│   │   ├── logger.js                # 日志（滚动文件 + 内存环形缓冲）
│   │   └── i18n.js                  # 界面文案（zh / en）
│   ├── preload/
│   │   └── preload.js               # 仅对本地启动页暴露的 contextBridge API
│   └── renderer/
│       ├── splash.html              # 启动页（加载中 / 失败 / 需要令牌）
│       ├── splash.css
│       └── splash.js
└── tests/                           # node:test，44 个用例
    ├── probe.test.js                # 指纹识别、探测、认证判定
    ├── locator.test.js              # dsh 定位策略（含 Windows/POSIX 路径）
    ├── kill-tree.test.js            # 真实进程树的终止与升级
    ├── server-manager.test.js       # 端到端：启动/复用/接管/拒绝误杀
    ├── settings.test.js
    ├── fixtures/fake-dsh-web.js     # 严格模仿 dsh web 协议的测试替身
    └── helpers/cookie-fetch.js      # 模拟浏览器 Cookie 的 fetch
```

---

## 3. 关键设计（为什么这样写）

### 3.1 `dsh web` 的令牌是一次性的，而且不落盘

这是整个启动器最重要的一条约束。阅读 Harness 源码与实际运行结果确认：

- `dsh web` 在**进程内存**里生成启动令牌（`WeakMap`，每个进程一个，从不写入磁盘）。
- 就绪后它把地址打印到 stdout：

  ```
  dsh web: http://127.0.0.1:3080/?token=<43 位 base64url>
  ```

- 用这个地址请求会得到 `303` 并下发 `Set-Cookie: dsh-auth-…`，该 Cookie 由 **`DSH_HOME`
  中持久保存的密钥签名**，有效期 **30 天**。
- 未认证的请求会得到固定响应，正好可以当指纹用：

  ```
  HTTP/1.1 401 Unauthorized
  dsh web authentication required; reopen the URL printed by dsh web.
  ```

因此启动器的做法是：

1. `spawn` 时加 `--no-open`，自己接管"打开界面"这一步；
2. 从 stdout 抓取带令牌的地址（**不能**只靠轮询端口，否则拿不到令牌）；
3. 用 Electron 的**持久化会话分区**（`persist:dsh-ui`）完成令牌兑换，Cookie 因此跨启动保留。

### 3.2 复用一个"别人的"服务时，为什么可能需要粘贴令牌

需求 5 要求"检测到 3080 已有 dsh 服务就直接复用"。但令牌只存在于**那个进程的内存**里，
启动器无法凭空取得。所以分两种情况：

| 情况 | 行为 |
|---|---|
| 上次启动器已完成过令牌兑换（30 天内 Cookie 仍有效） | 直接进入界面，无感复用 |
| 服务由**其他终端**启动，且本机没有有效 Cookie | 复用并加载，但会显示"需要访问令牌"面板，请把该终端打印的完整地址（含 `?token=…`）粘贴进去 |

这是这台机器上的真实情况：当前 3080 上运行的服务对未认证请求返回 401，所以**首次**复用
必须提供一次令牌；此后 30 天内都无需再输入。这也是官方桌面版选择"自带 Host、不开端口"的
根本原因；本启动器按需求采用"包装官方 CLI"的轻量路线，因此如实呈现这一步。

### 3.3 归属判定：只停止自己启动的服务

需求 4 的原文是"停止**自己启动的**服务进程"。启动器用一个可证明的判据来执行：

> 记录里的令牌**仍然能完成令牌兑换** ⟹ 该进程是启动器启动的 ⟹ 可以停止。

- 令牌被拒绝 ⟹ 服务属于别人 ⟹ **永不停止**（测试中专门覆盖了伪造归属记录的情形）。
- 上次异常退出留下的服务，令牌仍有效 ⟹ 接管并重新拥有它，关闭窗口时正确停止。
- 记录中的进程已不存在 ⟹ 丢弃过期记录，正常重新启动。

### 3.4 关窗口必须停掉**整棵**进程树

启动器直接持有的不是 dsh，而是 dsh 的父进程（`npx` → `node` → `dsh`）。
只杀直接子进程会留下真正的服务继续占用端口，所以：

- Windows：`taskkill /pid <pid> /T`（遍历父子链）。若该命令被拒绝（控制台程序无法优雅关闭，
  `taskkill` 会立刻返回失败），**立即**升级为 `/F`，不再空等宽限期。
- macOS / Linux：以 `detached` 启动，使子进程成为进程组组长，用 `-pid` 向整组发信号。

顺序始终是"先优雅、再强制"，最后校验端口是否真的释放。

### 3.5 端口占用与指纹

探测端口后会得到三种结论，避免把"别的程序"误当成 dsh：

- `free` — 连接被拒绝；
- `dsh` — 命中指纹：`401` + `dsh web authentication required`，或 `200` + 页面含 `__DSH_BOOT__`；
- `foreign` — 端口有人监听但不是 dsh → 报错并提示换端口（可选自动改用空闲端口）。

---

## 4. 快速开始

```bash
cd dsh-launcher
npm install          # 安装 Electron 与 electron-builder
npm start            # 以开发模式运行
npm run dev          # 运行并自动打开 DevTools
```

> 若你的 npm 版本启用了安装脚本审批（npm 11.19+ 的 `install-scripts`），
> Electron 的二进制可能未下载。确认 `node_modules/electron/dist/electron.exe` 存在，
> 否则执行 `npm install-scripts approve electron` 后重新 `npm install`。

### 冒烟测试（无需人工点击）

```bash
npm run smoke
```

会走完真实的启动流程并输出一行 JSON（`SMOKE_RESULT`）后退出。

指定端口与 dsh 入口（例如使用本地 checkout 的已构建产物）：

```powershell
$env:DSH_LAUNCHER_PORT='3179'
$env:DSH_LAUNCHER_DSH_PATH='D:\deepseek harness\deepseek-harness-master\apps\cli\lib\bin.js'
npm run smoke
```

### 运行测试

```bash
npm test          # 全部 44 个用例
npm run test:e2e  # 只跑进程/服务相关的端到端用例
```

---

## 5. 打包

```bash
npm run dist:win     # Windows: NSIS 安装包 + 免安装 portable
npm run dist:mac     # macOS: dmg + zip（x64 / arm64）
npm run dist:linux   # Linux: AppImage + deb
npm run dist         # 当前平台
```

产物输出到 `release/`。图标由 `npm run icon`（`scripts/make-icon.mjs`）生成 1024×1024 的
`build/icon.png`，electron-builder 会据此派生 `.ico` 与 `.icns`；`dist` 系列脚本已包含该步骤。

### 已打包好的 Windows 程序（`release/`）

| 文件 | 用途 |
|---|---|
| `DeepSeek Harness Launcher-1.0.0-x64-portable.exe` | **免安装版**，双击即用，最省事 |
| `DeepSeek Harness Launcher-1.0.0-x64-setup.exe` | 安装版，会创建桌面快捷方式与开始菜单项 |

只打其中一个目标可加快速度：

```bash
npx electron-builder --win portable --x64   # 只出免安装版
npx electron-builder --win nsis --x64       # 只出安装版
```

> **首次双击会慢一点**：此时会通过 `npx -y @deepseek-ai/dsh` 下载官方包（实测约 30 秒，
> 之后走 npm 缓存）。展开启动页的"显示日志"可以看到实时进度。
> 这些都未做代码签名，所以 Windows SmartScreen 可能提示"未知发布者"，选择"仍要运行"即可。

macOS 提示：正式分发需要代码签名与公证（`electron-builder.yml` 中补充 `mac.identity`、
`notarize` 等），否则 Gatekeeper 会拦截。

---

## 6. 使用说明

1. 双击 `DeepSeek Harness Launcher`（或安装后桌面/开始菜单的快捷方式）。
2. 启动页显示进度，首次运行若需下载 dsh 会较慢，可直接展开"显示日志"查看实时输出。
3. 服务就绪后自动进入 Harness Web UI。
4. **关闭窗口**：
   - 服务是本启动器启动的 → 自动停止后退出；
   - 服务是复用的（窗口底部会注明"关闭窗口不会停止它"）→ 只退出启动器，服务继续运行。
5. 启动失败时，启动页会给出原因、建议操作、日志尾部，并可一键复制诊断信息。

### 配置

配置文件位于 Electron 的 user-data 目录（目录名取自 `productName`）：

- Windows：`%APPDATA%\DeepSeek Harness Launcher\settings.json`
- macOS：`~/Library/Application Support/DeepSeek Harness Launcher/settings.json`
- Linux：`~/.config/DeepSeek Harness Launcher/settings.json`

同目录下还有 `launcher-state.json`（自有服务记录）与 `logs/launcher.log`（运行日志）。

| 键 | 默认值 | 说明 |
|---|---|---|
| `port` | `3080` | 服务端口 |
| `host` | `127.0.0.1` | 绑定地址 |
| `locale` | `""` | `""` 跟随系统，可设为 `zh` / `en` |
| `startupTimeoutMs` | `240000` | 就绪等待上限（首次下载需要余量） |
| `dshPath` | `""` | dsh 入口文件（`.js`），由 Node 运行 |
| `dshCommand` | `""` | 自定义命令字符串，经 shell 运行 |
| `nodePath` | `""` | 指定 Node 运行时 |
| `workingDirectory` | `""` | 子进程工作目录，默认用户主目录 |
| `extraArgs` | `[]` | 追加到 `dsh web` 之后的参数 |
| `reuseRunningService` | `true` | 复用已在运行的服务 |
| `stopServiceOnExit` | `true` | 退出时停止自有服务 |
| `killOrphanedService` | `true` | 接管/清理上次遗留的服务 |
| `fallbackToFreePort` | `false` | 端口被非 dsh 程序占用时自动改用空闲端口 |
| `windowBounds` | `null` | 自动保存的窗口位置与大小 |

环境变量可覆盖其中若干项（优先级高于配置文件，便于做多个快捷方式）：

`DSH_LAUNCHER_PORT`、`DSH_LAUNCHER_HOST`、`DSH_LAUNCHER_DSH_PATH`、`DSH_LAUNCHER_NODE_PATH`

### dsh 定位顺序

1. `dshPath` / `dshCommand`（显式配置）
2. `PATH` 上的 `dsh`
3. `node` + 与它同级的 npm `npx-cli.js`（**不经 shell**，进程树更可控）
4. `PATH` 上的 `npx`
5. 都没有 → 给出明确指引（安装 Node.js 20+，或配置 `dshPath`）

在 macOS 上，从 Finder 启动的应用只会继承极简 `PATH`，因此定位 `node`/`npx` 时还会
回退到登录 shell（`$SHELL -ilc 'command -v …'`）以及 nvm、Homebrew 的常见目录。

---

## 7. 常见问题

**端口 3080 被其他程序占用**
启动页会提示"端口被其他程序占用"。关闭该程序，或在启动页直接输入新端口点"更换端口"，
也可把 `fallbackToFreePort` 设为 `true` 自动改用空闲端口。

**提示"需要访问令牌"**
说明 3080 上已有 dsh，但它由别的终端启动。把那个终端打印的
`http://127.0.0.1:3080/?token=…` 完整粘贴进去即可；成功后 30 天内无需再次输入。

**提示未找到 dsh 运行环境**
安装 Node.js 20+，或在 `settings.json` 里设置 `dshPath` 指向 dsh 入口文件。

**关闭窗口后端口仍被占用**
理论上不会：关闭时会先优雅、再强制终止整棵进程树，并校验端口。若仍失败，
日志会记录升级失败的原因，且"自有服务"记录会被保留，下次启动会自动接管并重试停止。

**首次启动很慢**
`npx -y @deepseek-ai/dsh` 需要下载包。展开"显示日志"可以看到实时进度；
超时上限由 `startupTimeoutMs` 控制。

---

## 8. 实测记录

本机（Windows，Node v24.21.0，Electron 38.8.6）已验证：

- **复用路径**：对真实运行的 3080 服务识别为 `dsh`，判定 `owned=false`，未发送任何停止信号。
- **完整启动路径**：用本地 checkout 的已构建 CLI 启动真实 `dsh web`，约 5 秒后抓到就绪行
  与 43 位令牌，经 Electron 会话完成令牌兑换并确认认证成功，随后停止整棵进程树，端口已释放、
  无残留进程。
- **测试**：44/44 通过，覆盖指纹识别、认证判定、进程树终止（含孙进程与无视优雅信号的进程）、
  定位策略、以及"借用他人服务绝不误杀""伪造归属记录被拒绝"等安全性质。
