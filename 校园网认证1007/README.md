# 校园网自动认证（阳光学院 · 172.19.1.1）

用程序**控制浏览器**打开 `http://172.19.1.1`（阳光学院上网实名认证 / raas 门户），
自动填入学号与密码、点击「登录」完成校园网实名认证；随后自动 **ping 百度** 并做 **下载测速**。

- 账号 `2025269431`，密码写在 `config.json`（可用 `--user` / `--pass` 覆盖）
- **零第三方依赖**：只用 Node.js 内置能力（内置 `WebSocket` 直连 Chrome DevTools Protocol）
- 支持 Edge / Chrome，默认弹出可见浏览器窗口；密码由门户页面自己的 JS 加密后提交
- 完整「注销 → 登录」流程已实测通过，门户返回 `login.php ret=0` + `认证成功！`

---

## 一、快速开始

**方式 A：双击运行**

```
一键上网.cmd
```

**方式 B：命令行**

```bat
cd /d "D:\MUMUcode\MUMU harness code\校园网认证1007"
node src\main.mjs
```

**方式 C：npm 脚本**（无需 `npm install`，本程序没有依赖）

```bat
npm start          :: 认证 + ping + 测速
npm run relogin    :: 先注销下线，再重新认证（完整跑一遍登录流程）
npm run headless   :: 无界面模式
npm run netonly    :: 不认证，只做 ping + 测速
npm run logoff     :: 仅注销下线
```

前置条件：Windows + Node.js **22 或更高**（用到全局 `WebSocket`），以及已安装 Edge 或 Chrome。

---

## 二、命令行参数

| 参数 | 说明 |
| --- | --- |
| `--user <学号>` | 覆盖 `config.json` 里的账号 |
| `--pass <密码>` | 覆盖 `config.json` 里的密码 |
| `--portal <URL>` | 门户地址，默认 `http://172.19.1.1` |
| `--relogin` | 先调 `logoff` 注销，再执行登录（真正验证账号密码） |
| `--logoff` | 仅注销下线 |
| `--skip-auth` | 不启动浏览器，只做联网校验 / ping / 测速 |
| `--headless` | 无界面模式（后台静默认证） |
| `--keep-open` | 认证完成后保留浏览器窗口 |
| `--browser <路径>` | 指定浏览器可执行文件（默认自动查找 Edge → Chrome） |
| `--port <端口>` | CDP 调试端口，默认 `9222` |
| `--host <域名>` | ping 目标，默认 `www.baidu.com` |
| `--count <次数>` | ping 次数，默认 `5` |
| `--bytes <字节>` | 测速最多下载字节数，默认 200 MiB |
| `--max-ms <毫秒>` | 测速最长耗时，默认 8000 |
| `--no-ping` / `--no-speed` | 跳过 ping / 跳过测速 |

---

## 三、工作原理

### 3.1 门户协议（实测还原）

`http://172.19.1.1` 是一套 **raas** 门户（页面标题「阳光学院上网实名认证」，主题 `YG`）。
前端 `assets/js/raas.js` 把认证拆成几个 JSON 接口：

| 接口 | 作用 | 实测返回 |
| --- | --- | --- |
| `POST /api/ip.php` | 查询本机 IP 与认证状态 | `{"ret":0,"data":{"ip":"10.203.101.135","logined":1,"acct":""}}` |
| `POST /api/login.php` | 提交账号密码认证 | 成功 `{"ret":0,"data":{"type":0},"msg":""}`；`ret:3` 表示已经认证成功 |
| `POST /api/stat.php` | 轮询认证进度 | `{"ret":0,"data":[],"msg":"认证成功！"}` |
| `POST /api/ack_auth.php` | 认证成功后的确认（AFF_ACK_AUTH） | `{"ret":0,"data":[],"msg":""}` |
| `POST /api/logoff.php` | 注销下线 | `{"ret":0,"msg":"下线成功"}` |

关键点：**密码不是明文提交的**。页面脚本 `tp/YG/js/index.js` 里的 `encode()` 会先取 4 个随机字符
拼在密码前，再做一次混淆运算（`_0x5e74e9`），最后才 POST 给 `api/login.php`。
所以本程序**不重写加密算法**，而是老老实实驱动真实页面：填入输入框 → 点击登录按钮 →
让门户自己的 JS 去加密和提交。门户日后改算法也不影响本程序。

### 3.2 浏览器控制方式

`src/browser.mjs` 是一个**零依赖的 CDP 驱动**：

1. 用独立配置目录（`.browser-profile`）拉起 Edge/Chrome，带上 `--remote-debugging-port`；
2. 从 `http://127.0.0.1:<port>/json/version` 拿到 WebSocket 调试地址；
3. 用 Node 内置的全局 `WebSocket` 连接，`Target.createTarget` + `Target.attachToTarget` 新建标签页；
4. `Runtime.evaluate` 在页面里填表单、点按钮、读状态。

因为所有请求都发生在**页面上下文里**，Cookie / Session / 同源策略都与真人操作完全一致。

### 3.3 如何确凿判定认证成功

认证成功后门户会立刻把页面跳到 `https://www.baidu.com`，此时**上一文档的响应体已被浏览器回收**，
事后用 `Network.getResponseBody` 取不到报文。因此程序采用两级机制：

1. **页面内拦截器 + CDP Binding（主）**：`Runtime.addBinding` 建立回传通道，
   在页面注入 XHR/fetch 拦截器，门户接口一返回就**当场**把报文推给 Node 进程；
2. **`Network` 域事件（备）**：同时监听 `Network.responseReceived` / `loadingFinished` 作补充。

最终以门户自己的 `ret` 码判定，并打印原始报文，例如：

```
stat.php  {"ret":0,"data":[],"msg":"认证成功！"}
接口报文 /api/login.php → {"ret":0,"data":{"type":0},"msg":""}
接口报文 /api/ack_auth.php → {"ret":0,"data":[],"msg":""}
```

### 3.4 ping 与测速

- **ICMP ping**：调用系统 `ping.exe`。中文 Windows 的 ping 输出是 **GBK 编码**，
  按 UTF-8 解码会变乱码导致解析失败，`nettest.mjs` 做了 UTF-8 → GBK 自动回退解码，
  并以「带 `TTL=` 的应答行」为语言无关的取时依据。
- **TCP 握手延时（兜底）**：ICMP 被环境禁止（如受限沙箱里 spawn EPERM）时，
  改用 `net.connect` 到 `baidu:443` 测量握手时延与抖动。
- **下载测速**：从 102.5 MB 的国内镜像文件下载，**丢弃前 1 秒 TCP 慢启动阶段**，
  用首尾采样点的累计字节差计算稳态吞吐（`steadyMbps`），同时给出峰值与首字节时间。

---

## 四、目录结构

```
校园网认证1007\
├── 一键上网.cmd            # 双击即用的启动器（自动设置 UTF-8 代码页）
├── config.json             # 账号、密码、测速源等配置
├── package.json            # npm 脚本入口（无依赖）
├── README.md
├── src\
│   ├── main.mjs            # 主流程：预检 → 认证 → 联网校验 → ping → 测速 → 汇总
│   ├── browser.mjs         # 零依赖 CDP 浏览器驱动（含接口实时回传通道）
│   ├── portal-auth.mjs     # 门户登录流程（填表、点击、报文抓取、判定）
│   ├── nettest.mjs         # ICMP ping / TCP 延时 / 连通性 / 下载测速
│   └── util.mjs            # 日志、参数解析、配置加载
├── tools\                  # 前期侦察探针（保留备查）
│   ├── cdp-probe.mjs       # 验证零依赖 CDP 可控浏览器
│   ├── speed-probe.mjs     # 第一批测速源评估
│   ├── speed-probe2.mjs    # 第二批（国内镜像）
│   └── speed-probe3.mjs    # 大文件测速源筛选
├── assets\                 # 门户前端抓取副本（raas.js / index.js / index.html / css）
└── reports\                # 每次运行的 JSON 报告（含门户原始报文）
```

---

## 五、实测结果（2026-10-07）

### 5.1 完整「注销 → 登录」认证（`node src\main.mjs --relogin`）

```
① 门户预检     http://172.19.1.1 可达，本机 IP 10.203.101.135
② 浏览器认证   Edge Edg/154.0.4258.53 已连接 CDP，打开门户
                标题「阳光学院上网实名认证」
   注销        /api/logoff.php → {"ret":0,"msg":"下线成功"}
   填入        账号 2025269431 / 密码 ******（页面 encode() 加密后提交）
   点击登录    门户提示「开始认证...」→「欢迎回来！」
   接口报文    /api/login.php    → {"ret":0,"data":{"type":0},"msg":""}
               /api/stat.php     → {"ret":0,"data":[],"msg":"认证成功！"}
               /api/ack_auth.php → {"ret":0,"data":[],"msg":""}
   结果        认证成功（门户随后跳转 https://www.baidu.com/）
```

### 5.2 ping 百度

```
目标        36.152.44.93（www.a.shifen.com）　TTL 52
丢包        0%
ICMP 延时   最短 18ms / 平均 18ms / 最长 18ms
TCP 443     最短 18.8ms / 平均 22.9ms / 最长 28.4ms　抖动 3.2ms
```

### 5.3 下载测速（稳态吞吐）

| 测速源 | 稳态速度 | 峰值 | 数据量 |
| --- | --- | --- | --- |
| 阿里 npmmirror CDN | **117.2 Mbps**（16.55 MB/s） | 520.4 Mbps | 102.52 MB / 6.2s |
| 华为云镜像 | 83.9 Mbps（9.55 MB/s） | 235.9 Mbps | 80.00 MB / 8.38s |
| 平均 | **100.6 Mbps**（≈ 12.6 MB/s） | | |

多次运行稳态值在 **108 ~ 121 Mbps** 之间，即约 **13 ~ 15 MB/s**，
符合百兆级校园网出口的典型水平。总耗时约 21 秒。

> 补充说明：门户的 `ip.php` 在本部署下始终返回 `"acct":""`（即使刚用该账号认证成功），
> 这是门户自身的行为，`sessionlogined` 也一直为 0；判定在线状态应看 `logined` 字段。

---

## 六、常见问题

**Q1：提示「无法访问门户 172.19.1.1」**
确认已连上校园网（网线或 WiFi），并关闭会改路由的代理 / VPN / 加速器。

**Q2：浏览器没弹出来 / 报 CDP 端口未就绪**
可能是 `9222` 被占用，用 `--port 9333` 换一个端口；或指定浏览器路径
`--browser "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"`。

**Q3：ICMP ping 显示「被当前运行环境禁止（spawn EPERM）」**
说明程序跑在受限沙箱里（例如 DSH 沙箱禁止派生子进程捕获输出）。
这不是网络故障——程序会自动降级为 **TCP 443 握手延时**测量。
在普通命令行窗口里直接运行即可得到真正的 ICMP ping 结果。

**Q4：认证失败了怎么办**
错误信息会直接显示门户返回的原文（如 `帐号或密码不正确`）。核对 `config.json`；
门户限定密码长度 24 字符以内。若已离线，在浏览器里手动打开 `http://172.19.1.1` 即可重新认证。

**Q5：想让它开机自动联网**
把 `一键上网.cmd --headless` 的快捷方式放进
`shell:startup`（Win+R 输入即可打开启动文件夹）。（未默认启用，避免误操作。）

**Q6：密码存在 `config.json` 里安全吗**
明文存储，便于你随时修改。该文件只在本机，请勿把整个目录上传到公开仓库。
