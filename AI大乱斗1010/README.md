# AI 大乱斗 🥊

一个**纯本地运行**的 Electron 桌面应用：把同一段文字 + 同一批图片，**同时**发送到

| 站点 | 地址 | 登录态分区 |
| --- | --- | --- |
| 豆包 | https://www.doubao.com/chat/ | `persist:doubao` |
| DeepSeek | https://chat.deepseek.com/ | `persist:deepseek` |
| Kimi | https://www.kimi.com/ | `persist:kimi` |

三栏并排展示回答，方便横向对比。**没有后端、没有云端，所有数据都在你本机。**

---

## ⚠️ 最重要的一条：项目路径必须是纯英文/数字

**实测结论**：Electron/Chromium 无法从一个**含中文的目录名**里加载，表现是
双击启动后控制台一闪而过、或只打印

```
[launch] ⚠ Electron 在 15ms 内就退出了（code=2147483651）
```

同一个 `electron.exe`、同一份代码，放在 `C:\arena-test` 能正常启动，
放在 `D:\...\AI大乱斗1010\` 就必崩（连 `electron.exe --version` 都崩）。**与 Electron 版本无关**。

因此本项目当前的可运行副本放在：

```
D:\MUMUcode\AI-Arena\
```

以后请从那里启动（双击 `启动AI大乱斗.bat`）。如果你把目录改名/搬家，
**新路径里不要出现中文**（例如 `D:\MUMUcode\AI-Arena` 就可以）。

---

## 1. 安装与启动

### 方式 A：双击启动（最省事，推荐）

项目根目录里有**两个等效的启动器**，双击任意一个即可：

- `启动AI大乱斗.bat`（中文名，方便识别）
- `start.bat`（英文名，方便在命令行里敲）

双击后出现一个黑色控制台窗口（**使用期间别关它**），几秒后弹出应用窗口。
控制台里若打印了报错，照着它给的排查建议做即可；要退出应用就按 `Ctrl+C` 或直接关窗口。

> 第一次必须先装依赖（见下面"方式 B"的 `npm install`），否则双击时会提示
> `node_modules\electron not found`。

### 方式 B：命令行启动

```bash
# 需要 Node.js 18+（推荐 20 LTS）
npm install
npm start
```

- `npm install` 会自动下载 Electron 预编译包，并执行 `scripts/check-env.js` 环境自检。
- `npm start` 走 `scripts/launch.js` 启动器（**推荐**）；`npm run dev` 额外打开 Chromium 日志（排查注入问题用）；`npm run electron` 是"裸"启动方式，等价于 `electron .`。
- **自检**：`npm run selftest` 会以自检模式启动应用，约 40 秒后把三栏的加载情况、注入脚本是否生效、每个选择器是否命中写成报告并打印出来。改完选择器想快速确认时很有用。
- **离线测试**：`npm test` 用 jsdom 造出假的聊天页面，把注入脚本和适配器内核真的跑一遍（23 个用例：多候选选择器命中、受控组件原生 setter、三级文本降级、点击发送与就近猜测、`send()` 全流程、未登录中止、并发隔离、**注入脚本语法回归**等）。**不联网也能跑**，改完 `adapters/` 里的逻辑建议先跑一遍。
- 如果 Electron 下载慢/失败，可先设置镜像再装：

```bash
# Windows PowerShell
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
npm install
```

> 若 PowerShell 报"禁止运行脚本"（`npm.ps1 cannot be loaded`），改用 CMD：
> `Win+R` → 输入 `cmd` → 回车，然后
> `cd /d "D:\MUMUcode\MUMU harness code\AI大乱斗1010"` → `npm start`；
> 或直接双击 `start.bat`。

### ⚠ 如果 `npm start` 一闪而过、既没窗口也没日志

先检查这个环境变量：

```powershell
echo $env:ELECTRON_RUN_AS_NODE     # 如果不为空，就是它捣的鬼
Remove-Item Env:\ELECTRON_RUN_AS_NODE
npm start
```

`ELECTRON_RUN_AS_NODE=1` 会让 `electron.exe` 退化成**纯 Node 运行时**（连 `electron --version` 都会打印 Node 版本号），
此时窗口永远不会出现。`scripts/launch.js` 已经会自动清除这个变量，所以正常情况下用 `npm start` 不受影响。

---

## 2. 首次使用：先手动登录三个站点

应用启动后三个栏会各自加载站点。**第一次使用时三栏都是未登录状态**，需要你手动登录一次：

1. 栏目顶部状态灯的含义：
   - ⚪ 灰 = 还没加载
   - 🟡 黄 = 页面已加载但**需要登录**（或检测到验证码）
   - 🟢 绿 = 已登录就绪，可以发消息
   - 🔴 红 = 加载失败 / 渲染崩溃（栏内有"重试 ⟳"）
2. 检测到需要登录时，该栏顶部会出现闪烁的 **「扫码登录 📱」** 按钮，页面底部也会有黄色提示条。
3. 点它 → 该栏 `webview` 会**放大铺满整个窗口**，二维码足够大，拿手机扫即可。
   - 也可以随时点 **「放大 ⛶」** 手动放大/缩小任意一栏（`Esc` 或「返回三栏 ✕」退出）。
4. **登录成功后应用会自动缩小回三栏布局**，状态灯变绿。
   （判定依据：该站点输入框出现且可见；如果站点本身允许未登录试聊，登录后状态一样是绿。）
5. 登录态保存在各自的 `persist:` 分区里，**重启应用后依然有效**，不需要反复扫码。

> 应用**不会**自动填写账号密码、**不会**绕过验证码或风控。若某栏出现滑块/人机验证，日志区会提示"疑似风控/验证码"，请你在该栏网页里手动完成。

---

## 3. 怎么用

1. 顶部输入框写内容：
   - `Enter` 发送，`Shift+Enter` 换行，`Ctrl+Enter` 任意位置快速开战
   - **选择图片 🖼** / 直接把图片**拖进**输入区 / 截图后 `Ctrl+V` 粘贴，都支持多张，缩略图可单独删除
2. 勾选要发送的站点（每栏左上角复选框，或顶部"全选站点"）。
3. 点 **开战 🥊** —— 三个站点**并行**发送，用 `Promise.allSettled` 隔离，一栏失败不影响其他两栏。
4. 底部**日志区**按时间顺序显示每一步时序，例如：

   ```
   10:21:03.412  STEP  [豆包] ▶ 开始发送（文本 42 字，图片 1 张）
   10:21:04.051  STEP  [豆包] 等待输入框 ✓ ｜命中=div[contenteditable="true"][data-testid="chat_input_input"]
   10:21:04.480  STEP  [豆包] 注入文本 ✓ ｜方式=CDP Input.insertText
   10:21:06.902  STEP  [豆包] 注入图片 ✓ ｜方式=A 系统剪贴板 + Ctrl+V
   10:21:07.310  STEP  [豆包] 点击发送 ✓ ｜配置选择器:button[data-testid="chat_input_send_button"]
   10:21:07.860  STEP  [豆包] 校验输入框 ✓ ｜剩余字数=0
   ```

其他开关：**同步滚动**（任一栏滚动带动其他栏）、**最佳模型**（见下）、**切换上下/左右布局**、**全部重载 ⟳**、每栏独立的 **重新加载 ⟳ / 调试 / 清登录态**。

### ⚡ 最佳模型 / 最强推理（默认开启）

点「开战」时，应用会**先自动把每个站点切到最好的档位**，再发消息；
工具栏的「最佳模型」复选框可以关掉它，旁边的 **「套用最佳模型 ⚡」** 按钮可以立刻手动套用一次。

| 站点 | 自动设置 | 实测结果 |
| --- | --- | --- |
| 豆包 | 模型切到带「专家」的最强档（可选：豆包 / 快速 / 豆包 2.1 Turbo 专家） | ✅ 切到「豆包 2.1 Turbo专家」 |
| DeepSeek | 打开「深度思考」开关 | ✅ 已是开启状态 |
| Kimi | 模型保持 **K3**（旗舰），思考强度从 标准/进阶 提到 **极致**（标准 / 进阶 / 极致） | ✅ 切到「极致」 |

实现在 [adapters/preferences.mjs](adapters/preferences.mjs)：每个站点写清"触发元素 → 候选选项 → 偏好优先级（含要避开的降级档）"，
站点改版或你想换档位时只改这个文件即可。真实站点上的三条关键经验也写在注释里：

1. 豆包的模型菜单是 **Radix 弹层，只认真实指针交互** —— 页面内 `element.click()` 打不开它，
   必须用 CDP `Input.dispatchMouseEvent` 发真实鼠标事件（主进程的 `input:clickAt`）；
2. Kimi 的「思考强度」入口**长在模型菜单内部**，得先打开模型菜单才能点到；
3. 菜单项的 `textContent` 往往**含整行标题**（如"思考强度 进阶"），
   直接匹配会永远只命中最靠前的那档，所以要取"最后一行文字"当选项名。

---

## 4. 自动发送是怎么实现的（三条链路 + 降级）

### 文本注入（按顺序尝试，第一个"输入框里真的读回目标文本"的方案胜出）

1. **清空 + CDP 分块输入**（`Input.insertText`，每块 20 字）：最接近真人输入，React/Lexical/ProseMirror 都能感知。
   分块是因为一次性插入长文本会被内核静默截断（实测豆包会）。
2. **清空 + 原生 setter + 事件**：拿 `HTMLTextAreaElement.prototype` / `HTMLElement.prototype` 上的原生 `value`/`textContent` setter 赋值，
   改掉 React 的 `_valueTracker` 旧值，再派发 `input` / `change`。
3. **全选 + `document.execCommand('insertText')`**：作为最后兜底。

> **"清空"这一步比想象中难**（Kimi 用的是 Lexical 编辑器）：
> 主进程先把焦点真正给到该 webview（`focusWebview`），否则 `execCommand` 会静默失败；
> 仍清不掉时降级为**真实按键** `Ctrl+A` + `Backspace`（`sendInputEvent`），
> 这样编辑器自己的删除流程才会跑、内部模型才会同步。

### 图片注入（降级顺序）
| 方案 | 做法 | 说明 |
| --- | --- | --- |
| **A（优先）** | 主进程 `clipboard.writeImage(nativeImage)` 写系统剪贴板 → `webContents.sendInputEvent` 模拟 `Ctrl+V`（macOS `⌘V`） | 最像真人，兼容性最好 |
| **B** | 页面内构造 `DataTransfer` + `ClipboardEvent('paste')`，并用 `Object.defineProperty(event,'clipboardData',{value:dt})` 硬塞进去 | A 不生效时使用 |
| **C** | `webContents.debugger`(CDP) `DOM.setFileInputFiles` 把磁盘文件塞进 `input[type=file]` | 先用输入框位置反推"聊天区的上传框"并打标记，避免把图传到"换头像"的 input 上 |

每次注入用了哪种方案，日志区都会写明。

### 点击发送
1. 用配置里的 `sendButtonSelector` 多候选找按钮 → "就近猜测"（从输入框向上 6 层找语义含 `send`/`发送` 的可点元素）→ 页面上可点的 `button[type=submit]` → 容器内最后一个图标按钮
2. 点击；**700ms 后**用两个客观依据判断是否真的发出去了：
   - **输入框被清空**，或
   - **页面上的消息条数增加了**（数的是主滚动容器的子元素数量）
3. 两个依据都不满足时才降级：`sendInputEvent` 真实 `Enter`（`keyDown`+`char`+`keyUp`）并补一发 CDP `Input.insertText('\r')`

> 点击前会先等 450ms，让编辑器把自己的内部模型和 DOM 同步好 —— 否则会出现
> "输入框里明明有字，但发送按钮还是禁用态、点了没反应"（实测豆包/ProseMirror 有这个问题）。

> 所有网页操作都在**渲染进程**里通过 `webview.executeJavaScript()` 发起，逻辑集中在 `adapters/`；
> 主进程只提供网页做不到的能力：剪贴板、真实按键（含 Ctrl+A / Backspace）、CDP、临时文件。

---

## 4.5 聊天助手（独立窗口）

菜单 **窗口 → 聊天助手（独立窗口）**，或快捷键 **Ctrl+Shift+C**，或主界面工具栏的 **「聊天助手 💬」** 按钮，
会打开一个**只显示聊天问答页**的独立窗口：

- 一个输入框 + 「提问」按钮（`Enter` 提交、`Shift+Enter` 换行）；
- 一次提问**同时**发给三家，**并行**执行，单个失败只影响它自己那张卡片；
- 三张回答卡片按固定顺序 **DeepSeek → Kimi → 豆包** 排列，各自显示
  「等待中 → 输入问题 → 已发送，等待回答 → 回答中 N 字 → 完成 · N 字 · 耗时」；
- 每张卡片右上角有 **「选择」**（选中后卡片高亮）和 **「复制」**（复制该回答全文到系统剪贴板）。

实现要点（都在 [adapters/base.mjs](adapters/base.mjs) 的 `ask()` 里）：

1. **取答案是"DOM 差分"**：发送前后各取一次快照，只认"新出现/变长"的文本块；
   这比猜"哪个容器是消息列表"可靠得多（DeepSeek 的会话容器类名一直在变）。
2. **必须排除"思考过程"**：三家都会把推理过程也渲染在页面上
   （DeepSeek `ds-think-content`、Kimi `thinking-container`、豆包"已思考"），
   代码里按类名 + 文本开头（"已思考/我们需要/We need…"）识别并排除。
3. **回答结束的判据是"文本稳定"**（连续 4.5 秒没变化），不依赖"停止按钮消失"。

> ⚠ 聊天窗口里那三个站点的 webview 必须保持**接近正常的大小**：
> 一开始我用 `display:none` 藏起来 → 尺寸变 0 → 输入框拿不到焦点（问题写不进去）；
> 后来压成 176px 高的细带 → 站点切成折叠布局，DeepSeek 的发送按钮直接消失。
> 最终做法是"铺满窗口、藏在卡片层下面"（见 style.css 的 `body.chat-only #boards`）。

---

## 5. 站点改版 / 选择器失效了怎么办（调试模式）

所有选择器都集中在**两个文件**里，保持内容一致即可：

- `renderer/site-config.mjs` —— 渲染进程实际使用的配置
- `adapters/site-config.js` —— 主进程侧配置（UA / partition / session 策略）

调试步骤：

1. 应用里按 **`Ctrl+Shift+D`** 进入**选择器调试模式**（工具栏按钮同名）。
   页面内会画高亮框，标签上直接写出"字段名 ⇦ 实际命中的选择器 / CSS 路径"：
   - 粉色 = `inputSelector`
   - 绿色 = `sendButtonSelector`
   - 蓝色 = `readySelector` / `loggedInSelector`
   - 黄色 = `loginDetectSelector`
   - 红色 = `qrcodeSelector`
2. 同时底部日志会打印每个字段的命中情况，例如：
   `[豆包] 命中情况：输入框 inputSelector=div[contenteditable="true"] ｜发送按钮 sendButtonSelector=未命中 …`
3. 把命中的选择器**复制到候选数组的最前面**（顺序靠前优先），保存后按 `Ctrl+R` 重载窗口即可生效。
4. 想更精确时：点某栏的 **调试** 按钮（或 `F12`）打开该栏 DevTools，`document.querySelector(...)` 手测后再填回配置。
5. 另外提供 **探测上传框** 按钮：会列出每个站点里所有 `input[type=file]` 的 `accept/multiple/hidden/css 路径`，方便修正方案 C。

每个字段都是**多候选数组**，从左到右依次尝试、命中即用；选择器挂掉时只要在前面补一个新的即可。

---

## 6. 目录结构

```
AI大乱斗1010/
├── 启动AI大乱斗.bat       # ★ 双击启动（中文名）
├── start.bat               # ★ 双击启动（英文名，等效）
├── package.json            # 依赖与脚本（start / dev / selftest / test）
├── main.js                 # 主进程：窗口、partition 策略、剪贴板/按键/CDP/临时文件 IPC、安全护栏
├── preload.js              # 渲染进程的能力白名单（contextBridge）
├── webview-preload.js      # 注入到每个站点网页的 preload（同步滚动回传）
├── adapters/
│   ├── site-config.js      # ★ 选择器集中配置（主进程侧：UA / partition / session）
│   ├── preferences.mjs     # ★ 最佳模型/推理强度偏好（每站点的档位优先级）
│   ├── page-utils.mjs      # ★ 注入网页的工具库（选择器匹配/原生 setter/DataTransfer/高亮）
│   ├── page-utils.js       # 上面那个的 CommonJS 桥接（给主进程 require 用）
│   ├── base.mjs            # 适配器内核：探测、文本/图片注入、点击发送、最佳配置、诊断
│   ├── base.js             # 上面那个的 CommonJS 桥接
│   ├── doubao.js           # 豆包适配器（薄封装，差异都在 site-config）
│   ├── deepseek.js         # DeepSeek 适配器
│   ├── kimi.js             # Kimi 适配器
│   └── index.js            # 适配器注册中心
├── renderer/
│   ├── index.html          # 界面结构
│   ├── style.css           # 样式（浅色主题 / 三栏 / 放大模式 / 日志配色）
│   ├── arena.mjs           # 渲染进程主逻辑（视图、状态机、并行开战/聊天、日志、自检）
│   └── site-config.mjs     # ★ 选择器集中配置（渲染进程侧）
├── scripts/
│   ├── launch.js           # 启动器（清除 ELECTRON_RUN_AS_NODE、日志落盘、秒退诊断）
│   ├── selftest.js         # 自检运行器（npm run selftest）
│   └── check-env.js        # npm install 后的环境自检
├── test/
│   ├── page-utils.test.mjs      # 注入脚本的 DOM 单测（jsdom）
│   ├── adapter.test.mjs         # 适配器内核集成测试：真的跑一遍发送流程
│   └── injected-syntax.test.mjs # 注入脚本语法回归（防止模板字符串吃掉正则）
└── README.md
```

---

## 7. 已知限制

> **实测状态（本机 Windows 10 + Electron 38.8.6，已用真实站点验证过）**
>
> | 站点 | 加载 | 登录探测 | 输入框识别 | 文本注入 | 发送 | 图片 |
> |---|---|---|---|---|---|---|
> | 豆包 | ✅ | ✅ | ✅ `div.ProseMirror[contenteditable]` | ✅ | ✅ **实测真实发出并出现在对话里** | 待你首次使用时确认 |
> | Kimi | ✅ | ✅ | ✅ `.chat-input-editor` | ⚠ 偶发竞态 | ⚠ 见下 | ✅ 找到隐藏 `input[type=file]` |
> | DeepSeek | ✅（会跳 `/sign_in`） | ✅ 识别到手机验证码/微信扫码页 | 未登录时无输入框（正确） | — | 需先登录 | — |
>
> 说明：豆包这条链路是**真的跑通了**（点了发送后输入框清空、页面里出现了消息内容）。
> Kimi 用的是 **Lexical** 编辑器（有内部模型），"清空"已经能用"真实按键兜底"解决，
> 但"写入新文本"在窗口焦点/时序不理想时仍可能失败——这种情况下日志会明确写出
> 三种注入方式各自的失败原因，你可以手动在栏内清一下再点开战。

1. **选择器会随站点改版失效**。本项目用"多候选 + 调试模式 + 自检报告"降低维护成本，但无法保证永久有效。
   实测校准过的选择器已经写进两个 `site-config` 文件；失效时按第 5 节改配置即可。
2. **`webview` 是 Electron 的遗留标签**，虽然仍可用（官方推荐 `WebContentsView`），但本项目依赖 `<webview>` 才能做出"三栏 + 单栏放大"的纯 CSS 布局。
3. **风控与验证码不处理**。出现滑块/人机验证时只提示，需要你手动完成后重新开战；部分站点对自动化输入有频率限制。
4. **编辑器的"内部模型"是本项目最大的技术坑**：
   - 直接改 `innerHTML` 在 Lexical/ProseMirror 上会"看着有字、其实没字"（发送按钮仍是禁用态）；
   - `document.execCommand('insertText')` 在页面没有键盘焦点时会静默失败；
   - 一次性插入很长的文本可能被内核截断，所以代码里是**分块 20 字**发送的。
   这些都已按"能用就用、不行就降级、全程记日志"的方式处理。
5. **"是否已登录"是启发式判断**（输入框是否可见 + 是否出现登录框/二维码）。
   像 DeepSeek 这类未登录会跳 `/sign_in` 的站点判断很准；而"未登录也能试聊"的站点，未登录时灯也可能是绿的。
6. **同步滚动是比例同步**：各站点正文长度差很多时只能近似对齐，且只能同步主滚动容器。
7. **没有做发送去重/历史记录**，也不保存你的输入内容；关闭应用后输入区内容不保留。
8. **"清登录态"** 会调用主进程 `session.clearStorageData` + `clearCache` 清掉该 `persist:` 分区的 cookie 与本地存储再重载。
9. **运行环境的坑**：
   - 若外层环境设置了 `ELECTRON_RUN_AS_NODE=1`，Electron 会退化成纯 Node（窗口不出现）。`npm start` 走 `scripts/launch.js`，已自动清除并会在秒退时打印诊断。
   - **Electron 版本**：本项目实测在 **Electron 38.8.6** 上可正常启动并加载三个站点；32.x 在本机 GUI 模式起不来（连 `electron --version` 都失败）。因此 `package.json` 里写的是 `^38.8.6`，请不要随意降级。
10. 首次加载 + 扫码登录需要一点时间；网络被墙/代理异常时页面会一直转圈，请用"换个域名试试"或系统代理排查。
11. **改样式时注意一个坑**（已经踩过，导致"三栏全黑"）：
    `.col-error` / `.col-loading` / `#enlargeBar` 这几个遮罩用了 `display: flex`，
    **作者样式的优先级高于浏览器默认的 `[hidden] { display: none }`**，
    所以 JS 里设 `element.hidden = true` 会失效、遮罩永远盖在页面上。
    CSS 里已经显式补了 `[hidden] { display: none !important }`；**新增这类遮罩层时记得照做**。
12. 页面里的 `did-fail-load` 对**子框架/子资源**（登录 iframe、埋点、favicon）也会触发，
    代码里已用 `isMainFrame` 过滤，并加了"页面能探测到内容就不再显示错误遮罩"的保护。
    如果以后看到某个站点显示"加载失败"但其实能操作，先看日志区是不是子框架失败。
13. 本项目仅用于**本机个人使用**的对比测试，请遵守三个站点各自的服务条款，不要用于批量刷量等违规用途。
