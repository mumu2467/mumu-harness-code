# MUMU harness code — 工作区约定

## 项目目录规范（必须遵守）

每开始一个新项目，都必须先在 `D:\MUMUcode\MUMU harness code\` 下
**单独建立一个子文件夹**，该项目的所有文件都生成在这个子文件夹内。

**命名格式：`<项目名><MMDD>`**

- 日期为**创建当天**，形如 `0914`（9 月 14 日）
- 不使用分隔符：不加 `-`、`_`、空格
- 示例：`harness启动器0914` = 项目名 `harness启动器`，9 月 14 日创建

### 硬性要求

1. **不要**把项目文件直接放在 `MUMU harness code\` 根目录下。
   根目录只保留本文件（`AGENTS.md`）和各项目文件夹。
2. 每个项目自成体系：源码、依赖（`node_modules`）、构建产物（如 `release\`）
   都放在该项目自己的文件夹里，**不要跨项目共享**。
3. 若**同名同日期**的文件夹已存在，视为同一个项目，直接在其中继续开发，
   **不要**另建 `xxx0914-2` 之类的副本。
4. 项目后续继续开发时**不重命名**目录，日期始终是创建日期。

### 目录形态示例

```
D:\MUMUcode\MUMU harness code\
├── AGENTS.md                  # 本文件（工作区约定）
├── harness启动器0914\          # 项目：harness启动器，9/14 创建
│   ├── src\
│   ├── package.json
│   └── release\
└── 记账工具0915\               # 下一个项目，9/15 创建
    └── ...
```

## 版本同步规范（必须遵守）

每次对话产生的修改，都要提交、打 tag 并推送到 GitHub：

**仓库地址：<https://github.com/mumu2467/mumu-harness-code>**

- 本工作区根目录即仓库根，4 个项目作为 monorepo 共存
- 根目录额外保留 `.gitignore`、`RELEASES.md` 与本文件

### 版本号格式

```
v<N>-<YYMMDD>-<HH-MM>
```

- `<N>`：对话版本号，从 1 起递增（`v1`、`v2`、`v3`……）
- `<YYMMDD>`：打 tag 当时的日期，如 `261012`
- `<HH-MM>`：打 tag 当时的时间，用 `-` 代替 `:`（Windows 文件名与 git tag 均不允许冒号）
- 示例：`v1-261012-00-08`
- 只涉及单个项目的版本，tag 用 `<项目名>-v<N>-<YYMMDD>-<HH-MM>` 以免歧义

### 每轮对话的执行要求

1. 改动完成后 `git add` → `commit` → 按上述格式打 **annotated tag** → `push` 到 `origin main`
2. 同时在根目录 `RELEASES.md` 的版本表中追加一行记录
3. **不要**用 `--force` 推送；历史只增不改

### 禁止入库的内容

| 路径 | 原因 |
|---|---|
| `**/node_modules/` | 依赖，可重新安装 |
| `校园网认证1007/.browser-profile/` | 浏览器登录态，含 cookie / session token，**入库即泄露凭据** |
| `harness启动器0914/release/win-unpacked/` | 含 200MB exe，**超过 GitHub 单文件 100MB 硬上限** |
| `harness启动器0914/release/api.txt` | **含真实 API key** |
| `边坡4G监测1007/firmware/.pio/libdeps/` 与 `.pio/build/*/` | PlatformIO 缓存，可由 `pio run` 还原 |

### 网络

本机访问 GitHub 需经代理 `127.0.0.1:10808`（v2rayN / sing-box）。
已写入 git 全局配置：`http.https://github.com/.proxy`，仅对 github.com 生效。

## 说明

- 本文件由 DSH 的 `dsh-agent-instructions` 自动加载，无需在各项目中重复声明。
- 约定变更时直接改本文件即可，它是这条规则的唯一出处。
