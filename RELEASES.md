# 版本记录（RELEASES）

本仓库遵循「**对话即版本**」的同步规则：每次对话产生的修改，都会提交、打 tag 并推送到
GitHub（<https://github.com/mumu2467/mumu-harness-code>）。

## 版本命名规则

```
v<N>-<YYMMDD>-<HH-MM>
```

| 片段 | 含义 | 示例 |
|---|---|---|
| `v<N>` | 对话版本号，从 1 起递增 | `v1`、`v2`、`v3` |
| `<YYMMDD>` | 打 tag 当天的日期 | `261012` |
| `<HH-MM>` | 打 tag 当时的时间 | `00-08` |

完整示例：`v1-261012-00-08`（2026-10-12 00:08 的第 1 版）

> **为什么时间是 `00-08` 而不是 `00:08`？**
> Windows 文件名与 git tag 都不允许冒号，故用 `-` 代替。

若某次改动只涉及单个项目，为避免 monorepo 中 tag 语义歧义，可用带项目名的形式：

```
<项目名>-v<N>-<YYMMDD>-<HH-MM>
```

例如：`harness启动器0914-v2-261012-01-30`

## 版本列表

| Tag | 时间 | 主要内容 |
|---|---|---|
| `v1-261012-00-08` | 2026-10-12 00:08 | 建立仓库与版本同步机制：初始化 git 并接入 GitHub、制定忽略规则、写入 `AGENTS.md` 版本同步规范、新增本文件 |

## 入库范围约定

纳入版本管理的：

- 所有项目源码、配置、文档
- `harness启动器0914/release/` 下的两个安装包（setup / portable，共约 170MB）
- `边坡4G监测1007/firmware/` 源码与可烧录成品（`firmware.bin` / `bootloader.bin` / `partitions.bin`）

**永久排除**的：

| 路径 | 体积 | 原因 |
|---|---|---|
| `**/node_modules/` | 约 296MB | 依赖，可由 `npm install` 还原 |
| `校园网认证1007/.browser-profile/` | 约 119MB | 浏览器登录态，含 cookie / session token / VPN Tokens，**入库即泄露凭据** |
| `harness启动器0914/release/win-unpacked/` | 约 324MB | electron-builder 中间产物，含 200MB exe，**超过 GitHub 单文件 100MB 硬上限** |
| `harness启动器0914/release/api.txt` | — | **含真实 API key**，禁止入库 |
| `边坡4G监测1007/firmware/.pio/libdeps/`、`.pio/build/*/` | 约 66MB | PlatformIO 缓存与编译中间产物，可由 `pio run` 还原 |

> ⚠️ **安全提示**：`harness启动器0914/release/api.txt` 中的 API key 已存在于本地磁盘，
> 建议尽快到服务商控制台**吊销并轮换**，不要依赖 `.gitignore` 作为唯一防线。
