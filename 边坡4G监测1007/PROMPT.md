# 【终极 PROMPT】ESP32-S3 边坡监测节点 + 银尔达 M100MG-C2 4G 透传 DTU + 网页大地图

> **使用方法**：把本文件**整份**粘贴进 VSCode 的 Cline 对话框，然后让它按「第 12 节 执行阶段」逐阶段做。
> **不要**让它一次性吐完所有代码。每个阶段做完，先编译/先跑，确认无误再让它进入下一阶段。

---

## 0. 给你的执行铁律（Cline 必须遵守，违反就是失败）

1. **分阶段交付**。严格按第 12 节的 8 个阶段推进。**每完成一个阶段就停下来汇报**，等我确认再继续。
   不要一次性生成整个项目。
2. **不要猜硬件协议**。本文档给出的 DTU 命令格式、引脚、供电要求均来自官方文档，**照抄**。
   文档没写的地方，**停下来问我**，不要编造 AT 指令或寄存器。
3. **不许用 `delay()` 做长等待**。所有等待必须是 `millis()` 超时驱动的非阻塞状态机。
   （尤其：基站定位命令最长 60 秒才返回，阻塞等待会毁掉 20Hz 采样和 20FPS 刷屏。）
4. **不许破坏我已有的工程**。原有 I2C、屏幕 SPI、`USE_FSPI_PORT`、串口输出格式**一律不动**。
5. **引脚选完必须自检**。任何新引脚都要加进 `app_config.h` 现有的编译期冲突检查（`#error` 风格）。
6. **每个阶段可验证**。服务端阶段用 `curl` 打假数据；固件阶段要能 `pio run` 编译通过；
   最后才上真硬件。
7. **写代码同时写文档**。每个阶段产出对应的 `.md` 更新，不要最后补。

---

## 1. 我的最终作品目标

一张**网页大地图**，地图上按经纬度摆着我的边坡监测设备；点开设备能看到它通过 4G 传回来的
**GPS 经纬度 + 温湿度 + 姿态倾角（pitch/roll）**，并且有历史曲线、状态告警，
参数（上报周期、告警阈值、传感器量程等）全部走**可配置接口**，以后加传感器不用重写。

**架构一句话**：
`AHT30 + MPU6050 --I2C--> ESP32-S3 --UART--> M100MG-C2 透传DTU --4G--> 我的服务器 --> SQLite --> 网页大地图`

---

## 2. ★ 架构前提（最重要，先读懂再动手）

**YED-M100MG-C2 是「透传 DTU」，不是需要 MCU 驱动的 AT 模块。**

- DTU 上电后**自己**注册 4G 网络、自己激活 PDP、自己连接并保持服务器通道。
  **ESP32-S3 不需要发送任何 AT 指令联网**（不要写 `AT+CGATT` / `AT+CIPSTART` / `AT+HTTPINIT` 之类）。
- ESP32-S3 与 DTU 之间只有一件事：**ESP32 往串口写数据 → DTU 原样透传到服务器 URL**。
- 服务器返回的响应体，DTU 会从串口吐回来给 ESP32。
- 数据流以**设备发起**为主。以下两条限制是官方文档原文，必须遵守：
  - 「服务器不能主动给设备发数据，只有在设备请求服务器的时候，服务器才能返回」
  - 「HTTP协议，不能控制DTU内部资源，不支持远程控制命令」
  → **不要设计「服务器推送配置到设备」的功能**。以后要下行控制必须换 TCP 通道，另立任务。

### 2.1 DTU 配置协议（写代码/写文档以这个为准）

命令格式（本地串口配置，也支持服务器下发）：
```
config,set,<命令>,[参数...]\r\n      # 设置
config,get,<命令>,[参数...]\r\n      # 查询
```
应答格式：
```
\r\nconfig,<命令>,ok,[参数]\r\n
\r\nconfig,<命令>,error,<错误码>\r\n
```
- 关键词与命令**全小写**，字段用英文逗号 `,` 分隔，**必须以 `\r\n`（0x0D 0x0A）结尾**
- 一般命令响应超时 **3 秒**；基站定位命令超时 **60 秒**
- 错误码：`1`=本设备不支持该命令，`2`=参数错误，`3`=需要验证密码

### 2.2 ★★ 字节级铁律（本项目第一大坑）

官方文档 2.1 原文：
> 「系统以 `config` 开头、并且以 `\r\n`（回车换行）结尾的数据都会被认为是配置命令，
> **不参与透传数据发送和接收**，在使用的时候，尽量避免这种格式的数据。」

**因此，以下三条是硬性编码纪律：**

1. ESP32 通过串口发给 DTU 的**业务数据里，绝对不能出现「以 `config` 开头且以 `\r\n` 结尾」的行**。
2. 上报的 JSON **必须是单行紧凑格式**，以 `\r\n` 结尾。
3. 调试日志一律以 `#` 开头；如果日志可能以 `config` 开头，**必须加前缀**（如 `#DBG:config...`）。

**并且必须实现一个「行分流器」（line dispatcher）**，因为 DTU 的配置命令应答也会出现在同一条串口上：
- 收到以 `config,` 开头的行 → 交给**内部配置状态机**消费，绝不透传给服务器
- 其他行 → 视为服务器下发的业务数据 / DTU 日志
- **这一点必须写单元测试**：喂几条混合输入，断言分流结果正确（见 12.3 阶段）

### 2.3 定位相关命令全集（照抄《5、DTU透传固件定位命令》）

```
# ① 开启定位（不开启的话：基站定位会卡顿、最长超时60秒；GPS 完全取不到定位）
config,set,location,<定位类型>,<是否开启>,<更新周期秒>,<上报类型>,<上报内容>,<通道ID>,<付费模式>\r\n
    定位类型: 1=基站定位   2=GPS定位
    是否开启: 0=关闭       1=开启
    更新周期: 单位秒
    上报类型: 0=不上报     1=固定格式 "经度_纬度"    2=自定义格式（支持 ${XXX} 变量）
    上报内容: 上报类型=2 时有效，其他情况填 0 占位
    通道ID  : 网络通道 ID
    付费模式: 0=免费（单基站，偏差大）   1=付费（多基站联合+WIFI，更精确）
示例:
    config,set,location,2,1,60,2,test${GPSLON}:${GPSLAT},1\r\n
  → \r\nconfig,location,ok\r\n

# ② 查询定位配置
config,get,location,<定位类型>\r\n
  → \r\nconfig,location,ok,0,0,0,0,0\r\n

# ③ 读取基站定位（需联网；城市精度约500m，偏远可能几公里；命令最长超时60秒）
config,get,lbsloc\r\n
  → \r\nconfig,lbsloc,ok,110.1234567,020.1234567\r\n
    （3位整数7位小数，WGS84 坐标系）

# ④ 读取 GPS 定位（需先开启 GPS；需室外空旷，室内无法定位）
config,get,gps\r\n
  → \r\nconfig,gps,ok,E,110.1234567,N,20.1234567\r\n
    （返回：经度方向,经度,纬度方向,纬度；WGS84）

# ⑤ 读取 GPS 扩展信息（推荐用这个）
config,get,gpsext\r\n
  → \r\nconfig,gps,ok,1,E,113.9739056,N,22.6927826,0,0,184,-3.6,0,2022-11-3 2:43:51\r\n
    字段顺序：定位标记(0失败/1成功), 经度方向, 经度, 纬度方向, 纬度,
              速度(km/h), 速度(节), 海拔, 椭球高, 方向角, GPS时间
```

**坐标系警告（必须在文档里重复一遍）**：DTU 输出 **WGS84**。官方原文：
> 「GPS的数据是WG84坐标，要用到需要转换成使用地图的坐标系」
> 「GPS数据不能直接用在地图上，有偏差，需要纠偏」

所以服务器端**必须**做坐标转换：
- **Leaflet + OSM 瓦片** → 直接用 WGS84，**无需转换**
- **高德 / 腾讯** → WGS84 → **GCJ-02**
- **百度地图** → WGS84 → **BD-09**（先转 GCJ-02 再转 BD-09）
转换函数要做成**独立模块 + 单元测试**（用已知坐标对拍），**不要散落在渲染代码里**。

### 2.4 数据流方案（二选一，默认用方案 B）

DTU 有两种能力，本项目**默认用 (b)**：
- **(a) DTU 自动上报定位**：`config,set,location,2,1,<周期>,...` 让 DTU 自己把坐标发到服务器
- **(b) ESP32 主动查定位** ← **推荐**：ESP32 定期发 `config,get,gpsext\r\n`，解析应答，
  把坐标和温湿度、姿态拼成**一条完整 JSON** 上报

**选 (b) 的理由**：一次请求一个完整快照，服务器无需做时间窗关联，数据不会错位、不会出现
「GPS 和姿态差 30 秒」的问题。
**同时把 (a) 作为备选方案写进文档**（含命令样例 + 什么场景改用 (a)），以便将来做超低功耗。

---

## 3. 硬件确认表（已从官方文档确认，直接采用，不要再查）

| 项目 | 结论 |
|---|---|
| 型号 | **YED-M100MG-C2 DTU**（银尔达），工业级单 TTL 串口 4G DTU，25×25mm，2.54mm 双排排针 |
| 4G 制式 | Cat1 全网通；LTE-FDD: B1/B3/B5/B8；LTE-TDD: B34/B38/B39/B40/B41 |
| **供电** | **3.3~4.2V，功率 10W**；官方推荐 **3.8V 2A DCDC**；**明确写「不要用 3.3V，防止纹波导致电源跌了」**；3.7V 锂电可直供；3.6V 锂亚电池必须加电容；**3.3V 串口工具供电功率不足会导致设备异常** |
| 串口电平 | TTL，**兼容 3.3V 与 5V**，**无需电平转换**，但**必须共 GND** |
| 串口参数 | 1200~460800；数据位 8/7；停止位 1/2；校验 奇/偶/无 |
| 工作环境 | -35℃ ~ +75℃；湿度 5%~95%RH（无凝露）—— 适合边坡野外 |
| 引脚 | `VIN`/`GND` 电源；`RXD`/`TXD` 主串口；`DTR`（可唤醒，3.3~5V）；`RST`（复位，3.3~5V）；`RDY`（联网后输出**高电平，3.3V**）；`1PPS`（**1.8V 电平**，定位成功后每秒脉冲）；`BOOT` 键（强制升级：按住再上电）；`Relaod` 键（按 7 秒恢复出厂）；USB（`VB/DM/DP/GND`，下载程序/看日志） |
| 天线 | **4G 天线 IPEX 1代，必须接**；GPS 天线 IPEX，支持 **3.3V 有源天线与无源天线** |
| 定位模块 | 独立 GNSS：**ATGM336H-5NR32**（GPS+北斗+GLONASS+GALILEO+QZSS+SBAS，冷启动 ≤35s，1Hz，<2.5m CEP50）或 **ATGM336H-6N22**（单北斗，冷启动 ≤23s，<2.0m） |
| 功耗 | DTU 待机 **6.3~11mA**（随电压/是否关LED）；**GPS 叠加 26mA**(5NR32) / **42mA**(6N22) |
| 超低功耗 | 支持周期唤醒：10分钟周期唤醒约 2.4mA；60分钟周期唤醒约 520µA（3.7V/500mAh 可用约 40 天） |
| 官方建议 | 「强烈建议硬件设计能控制模组的复位脚或者电源脚，方便异常恢复」；「震动、运动、腐蚀、潮湿环境推荐贴片卡」，外置卡有松动/氧化风险建议打胶 |
| 定位前提 | **「GPS必须放到室外空旷的地方才能定位，室内无法定位」** |
| 网络指示灯 | `NET LED`：SIM不识别=5s亮5s灭；注册不上网=100ms闪；注册成功未连服务器=500ms慢闪；**成功连上服务器=1000ms慢闪且 `RDY` 常亮**；`GPS LED`(1PPS)：定位成功闪烁，失败熄灭 |

**关键澄清**：文档里「DTU固件实例讲解」那 16 个链接（TCP/UDP/HTTP/MQTT/…）是**配置教程**，
不是 AT 指令手册。本项目按 2.4 节方案 B 走 **HTTP** 通道。

---

## 4. ★ 接线与供电（照抄这一节，接线错了一晚上都调不出来）

### 4.1 ESP32-S3 现有引脚占用（来自我的现有工程，**不许改动**）

来源：`D:\MUMUcode\esp32 毕设\esp32-0920-aht30-mpu6050\SKILL.md` 第 4 节「ESP32 引脚总表」

| ESP32-S3 GPIO | 功能 | 外设 | 备注 |
|---|---|---|---|
| **GPIO8** | I2C SDA | AHT30 + MPU6050（共用） | `PIN_I2C_SDA` |
| **GPIO9** | I2C SCL | AHT30 + MPU6050（共用） | `PIN_I2C_SCL` |
| **GPIO21** | SPI SCLK | ST7789 | `-DTFT_SCLK=21` |
| **GPIO47** | SPI MOSI | ST7789 | `-DTFT_MOSI=47` |
| **GPIO41** | SPI CS | ST7789 | `-DTFT_CS=41`（S3 JTAG MTDI） |
| **GPIO40** | SPI DC | ST7789 | `-DTFT_DC=40`（S3 JTAG MTDO） |
| **GPIO45** | SPI RST | ST7789 | `-DTFT_RST=45` ⚠ **S3 strapping 脚** |
| **GPIO42** | 背光 PWM | ST7789 BLK | `-DTFT_BL=42`（LEDC 5kHz/8bit） |
| GPIO43 / GPIO44 | UART0 TX/RX | 板上 USB 转串口 | 硬占用，程序不能占 |
| GPIO19 / GPIO20 | 原生 USB D-/D+ | USB 座（USB CDC） | 硬占用 |
| GPIO26~32 | ❌ 不可用 | 模块内部 Flash/PSRAM | 编译期 `#error` |
| GPIO33~37 | ⚠ 视模块而定 | 八线 PSRAM（N16R8）占用 | 本工程 N8 无 PSRAM，可用但会 `#warning` |

### 4.2 ★ 4G DTU 接线表（ESP32-S3 ↔ YED-M100MG-C2）

| DTU 引脚 | 接到 | 说明 |
|---|---|---|
| `VIN` | **→ 独立 3.8V 电源（★ 禁止接开发板 3V3）** | 必须能供 **2A** |
| `GND` | **ESP32-S3 GND（必须共地）** | 共地 |
| `RXD` | **ESP32-S3 的 TX → 建议 GPIO17** | ★★ **交叉接** |
| `TXD` | **ESP32-S3 的 RX → 建议 GPIO18** | ★★ **交叉接** |
| `RST` | **建议接 ESP32 GPIO16** | 官方要求「方便异常恢复」，异常时拉低复位。**做成可配置；不接则宏填 `-1`，并在文档说明放弃了什么** |
| `RDY` | 可选接 ESP32 GPIO（如 GPIO15） | 3.3V 电平，**联网成功输出高电平**，可快速判断在线。不接填 `-1` |
| `1PPS` | **❌ 不要直连 ESP32** | ★ **1.8V 电平**，低于 S3 的 VIH，直连读不到；要接必须加电平转换或分压。本项目**不接** |
| `DTR` | 不需要接 | 仅 AT 固件用于唤醒 |
| `4G天线` | **必须接**（IPEX 1代） | |
| `GPS天线` | **必须接**（IPEX） | 有源天线注意供电；**必须放室外/窗边** |
| `BOOT` 键 | 不用 | 强制升级用（按住再上电） |
| `Relaod` 键 | 不用 | 按 7 秒恢复出厂设置 |

**接线示意：**
```
        ESP32-S3-DevKitC-1                        YED-M100MG-C2 DTU
        ┌──────────────────┐                      ┌──────────────────┐
  3.3V ─┤ 3V3          GND ├──── 共地 ────────────┤ GND              │
        │                  │                      │                  │
        │        GPIO17 TX ├─────────────────────►┤ RXD              │
        │        GPIO18 RX ◄──────────────────────┤ TXD              │
        │        GPIO16    ├─────────────────────►┤ RST (可选)       │
        │        GPIO15    ◄──────────────────────┤ RDY (可选)       │
        │                  │                      │                  │
        │                  │        ┌─────────────┤ VIN ◄── 3.8V/2A 独立电源
        │                  │        │             │                  │
        │   GPIO8  SDA ────┼──┐     │             │  4G 天线 IPEX ──► 必须接
        │   GPIO9  SCL ────┼──┤     │             │  GPS 天线 IPEX ─► 必须接(室外)
        │                  │  │     │             └──────────────────┘
        │  GPIO21/47/41/40/45/42 │   │
        └──────────────────┘  │   │
              │               │   │
        ┌─────┴──────┐  ┌─────┴───┴──┐
        │ AHT30      │  │ MPU6050    │
        │ VCC→3.3V   │  │ VCC→3.3V   │   ★ MPU6050 不要接 5V
        │ GND→GND    │  │ GND→GND    │
        │ SDA→GPIO8  │  │ SDA→GPIO8  │   ← 两个模块并联同一条 I2C
        │ SCL→GPIO9  │  │ SCL→GPIO9  │
        └────────────┘  └────────────┘

        ┌─────────────────────────────┐
        │ ST7789 240x320 SPI 竖屏      │
        │ VCC→3V3(不要5V)  GND→GND     │
        │ SCL→GPIO21  SDA→GPIO47       │
        │ RES→GPIO45  DC→GPIO40        │
        │ CS→GPIO41   BLK→GPIO42       │
        │ MISO→不接                    │
        └─────────────────────────────┘
```

**接线三重检查（务必写进文档的 FAQ）：**
1. `RXD`/`TXD` 是**交叉接**（DTU 的 RXD 接 MCU 的 TX）。文档里的引脚命名是**模块侧**视角，最容易错。
2. **必须共地**。不共地会出现「能收到乱码但解析不了」。
3. DTU 的 `VIN` **绝不能**接开发板 3V3。开发板 LDO 带不动 10W 峰值。

### 4.3 引脚选择任务（Cline 必做）

1. 上面的 `GPIO17 / GPIO18 / GPIO16 / GPIO15` 是**建议值**。你要对照 4.1 节引脚表**逐条验证**
   这些脚没被占用、不在 26~32、不是 43/44、不是 19/20、不撞 I2C 8/9 与屏幕 6 个脚。
2. 把最终选定的脚写进 `app_config.h`，并**加入现有的编译期冲突检查**（`#error` 风格与老工程一致）。
3. **明确输出一段「引脚分配理由」**：为什么选它、排除了哪些脚、依据哪条规则。
4. 如果排下来没有合适的空闲脚，**停下来告诉我**并给备选方案（如牺牲某个屏脚 / 改 UART 实例），
   **绝对不要偷偷复用已占用的脚**。

### 4.4 ★ 供电方案（必须单独成节，写清楚为什么）

**为什么不能用开发板的 3.3V：**
- ESP32-S3 开发板的 `3V3` 来自板上 LDO，电流能力有限，**完全带不动 10W 的 4G 发射峰值**。
- 官方原文两条：「推荐 3.8V 2A 的 DCDC 芯片供电。**不要用 3.3V** 防止文波（纹波）导致电源跌了」、
  「特别是用 3.3V 串口工具的电源功率不足，设备会异常」。

**推荐供电方案（写进文档）：**

| 场景 | 方案 |
|---|---|
| 桌面调试 | **独立 3.8V/2A DCDC 电源**（或用 3.7V 锂电池直供），与 ESP32 分开供电、**共地** |
| 野外长期部署 | **太阳能板 → 充电管理 → 3.7V 锂电（大容量）→ 3.8V DCDC → DTU**；ESP32 与传感器由 3.3V LDO 从电池取电 |
| 电源去耦 | VIN/GND **就近**并联大容量低 ESR 电容：先按 **1000µF 电解 + 100nF 陶瓷** 起步，按实测掉电情况加大 |
| 若用锂亚电池 | 官方明确「3.6V 锂亚电池供电**要加电容**」（锂亚内阻大，扛不住发射脉冲） |

**必须给出的估算表（写进文档）：**

| 负载 | 电流 |
|---|---|
| ESP32-S3 主体（含 USB 通信） | ~100 mA |
| ST7789 屏（含背光 80%） | 20~60 mA（背光 80% 约 30~40 mA） |
| AHT30 | <1 mA（测量时） |
| MPU6050 | ~4 mA |
| DTU 待机 | 6.3~11 mA |
| GNSS 叠加 | 26 mA（5NR32）/ 42 mA（6N22） |
| **4G 发射瞬时峰值** | **按手册 10W 量级估算，必须用示波器/电流表实测确认** |
| **合计（典型/待机）** | **约 160~220 mA**；发射瞬间可达安培级 |

**野外部署额外算清（写进文档）：**
- 太阳能板功率（按日均发电量 vs 日均耗电量，留 2 倍余量）
- 电池容量（按夜间 + 连续阴雨天续航，如 3~5 天）
- **SIM 卡月流量估算**：给出算式，例如 60s 一条、单条 JSON 约 400 B →
  `400B × (86400/60) 条/天 × 30 天 ≈ 17 MB/月`，再乘上 HTTP 头开销，取 50 MB/月 余量
- 若做超低功耗：说明用 DTU 的周期唤醒能力（10 分钟周期约 2.4mA / 60 分钟周期约 520µA），
  以及此时应改用方案 (a) 让 DTU 自己上报

---

## 5. 我已有的工程（复用，不要重写）

**原工程路径**：`D:\MUMUcode\esp32 毕设\esp32-0920-aht30-mpu6050`

**Cline 必须先完整阅读这两个文件，把它们当作事实来源：**
- `SKILL.md` —— 引脚总表、寄存器、初始化顺序、常见坑、适配指南、编译期自检清单
- `README_接线与使用说明.md` —— 接线表、通信协议、FAQ、屏幕专项（第十二节）

### 5.1 已实现且**编译通过**的功能（全部保留）

- 主控：**ESP32-S3-DevKitC-1 N8**（8MB Flash，无 PSRAM），PlatformIO + Arduino 框架
  （`platform = espressif32`，实测 7.1.3 + Arduino-ESP32 核心 2.0.17 / IDF 4.4.7），
  board = `esp32-s3-devkitc-1`，上传速率 921600，串口 115200
- **AHT30** 温湿度（I2C **0x38**，7 字节帧 + CRC8 poly `0x31` init `0xFF`，
  触发命令 `0xAC 0x33 0x00`，等待 90ms，状态字正常 `0x18`，含 0x1B/0x1C/0x1E 校准寄存器修复）
- **MPU6050** 六轴（I2C **0x68**，AD0 接地；备 0x69。`WHO_AM_I` 0x75 期望 0x68。
  `PWR_MGMT_1=0x01`、`SMPLRT_DIV=0x09`(100Hz)、`CONFIG=0x03`(DLPF 44/42Hz)、
  `ACCEL_CONFIG=0x00`(±2g, 16384 LSB/g)、`GYRO_CONFIG=0x00`(±250dps, 131 LSB/dps)，
  从 `0x3B` 连读 14 字节）
- **I2C 总线**：`SDA=GPIO8`、`SCL=GPIO9`、**400 kHz**，`Wire.setTimeOut(50)`
- **ST7789 240×320 竖屏**：`SCLK=21 MOSI=47 CS=41 DC=40 RST=45 BL=42 MISO=-1`，
  `SPI_FREQUENCY=40000000`，`TFT_INVERSION_ON`，**`-DUSE_FSPI_PORT=1`（S3 必须，缺了 `tft.init()` 崩）**
- **姿态解算**：互补滤波 `CF_TAU_S=0.35`、显示低通 `DISP_TAU_S=0.20`、
  开机静置校准 `CALIB_MS=1200`、`pitch = atan2(f, √(r²+u²))`（抬头为正）、
  `roll = atan2(-r, u)`（右倾为正），安装方向宏 `IMU_MOUNT` 可用串口 `m` 循环切换
- **非阻塞状态机**：MPU 20Hz（50ms）/ AHT 1Hz（1000ms，+90ms 等待）/
  刷屏 20FPS（50ms）/ 掉线重试 2000ms（连续 3 次失败判掉线）
- **串口输出格式（★ 不要改，`web/` 依赖它）**：
  ```
  MPU,<ms>,ax,ay,az,gx,gy,gz
  AHT,<ms>,temperature,humidity
  ATT,<ms>,pitch,roll          （或 Pitch: .., Roll: ..）
  状态行一律以 # 开头
  ```
- **TFT_eSprite** 离屏画布 240×240 16bpp（115200 B 堆），失败自动降级直接绘制
- 背光 `GPIO42` LEDC PWM（5kHz/8bit，默认 80%）
- 屏幕串口调试命令：`d`(自检画面) `m`(安装方向) `g`(填充方式) `r`(旋转) `b`/`B`(背光) `c`(重校准)
- `web/` 网页仪表盘（Web Serial + Canvas 人工地平仪/气泡水平仪/曲线），
  自检：`node web/selftest.js`（34 项）、`node web/selftest_ui.js`（25 项），**必须继续全过**
- PlatformIO 环境：主用 `esp32-s3-devkitc-1`，备用 `esp32-s3-uart0`；
  **`default_envs` 那一行不要删**

### 5.2 ★ 禁止修改清单（红线）

| 不许动 | 原因 |
|---|---|
| `PIN_I2C_SDA=8` / `PIN_I2C_SCL=9` / 400kHz | 传感器已按这个接线 |
| 屏幕 6 个 SPI 引脚 + 背光 GPIO42 | 接线已固定 |
| `-DUSE_FSPI_PORT=1` | 缺了 `tft.init()` 触发 `EXCVADDR=0x10` 崩溃 |
| 现有串口输出行格式（`MPU,` / `AHT,` / `ATT,` / `Pitch:`） | `web/decode.js`、`web/selftest.js` 依赖 |
| `default_envs = esp32-s3-devkitc-1` | 删了会按顺序烧两个环境 |
| 老工程目录本身 | **不要原地改**；要复用就复制到新项目 |

---

## 6. 交付物（缺一不可）

### 6.0 工作区与目录规范（硬要求）

- 新项目**必须**建在 `D:\MUMUcode\MUMU harness code\边坡4G监测1007\`
  （命名格式 `<项目名><MMDD>`，日期=创建当天，不加分隔符。本 prompt 已放在该目录）
- **不许**把文件放在 `MUMU harness code\` 根目录（根目录只留 `AGENTS.md` 与各项目文件夹）
- 每个项目自成体系：源码、依赖、构建产物都放在项目自己文件夹里，**不跨项目共享**
- 若同名同日期文件夹已存在，视为同一项目，直接在其中继续开发，**不要**另建 `xxx-2` 副本

**建议的目录结构：**
```
边坡4G监测1007\
├─ PROMPT.md                        # 本文件
├─ README_接线与使用说明.md          # 接线 + 供电 + DTU配置 + FAQ（对标老工程水准）
├─ SKILL.md                         # 引脚表/命令表/初始化顺序/常见坑/待确认项
├─ firmware\                        # ESP32-S3 固件（PlatformIO）
│  ├─ platformio.ini                # ★ 完整 build_flags，不许写 "沿用原工程"
│  ├─ src\
│  │  ├─ main.ino                   # 状态机 + 定时任务
│  │  ├─ app_config.h               # ★ 所有可配置参数集中在这里
│  │  ├─ attitude.h/.cpp            # 姿态解算（从老工程搬，标注"原样搬入"）
│  │  ├─ display_st7789.h/.cpp      # 屏幕（从老工程搬 + 新增状态条）
│  │  ├─ sensor_aht30.h/.cpp        # ★ 拆成独立驱动
│  │  ├─ sensor_mpu6050.h/.cpp      # ★ 拆成独立驱动
│  │  ├─ net_dtu.h/.cpp             # ★ 4G DTU 通信 + 命令解析 + 上报
│  │  ├─ json_build.h/.cpp          # ★ JSON 组包（字段表集中定义）
│  │  └─ data_model.h               # ★ 统一数据结构 + 扩展字段预留
│  └─ test\                         # 单元测试（分流器、JSON 字段一致性）
├─ server\                          # Python 服务端
│  ├─ requirements.txt
│  ├─ app.py                        # FastAPI 主程序
│  ├─ db.py                         # SQLite 建表 + 读写
│  ├─ coord.py                      # ★ WGS84↔GCJ02↔BD09 坐标转换
│  ├─ config.py                     # ★ 所有可配置参数
│  ├─ schema.sql                    # ★ 建表 SQL
│  └─ test_coord.py                 # 坐标转换单测
└─ web\                             # 网页大地图
   ├─ index.html
   ├─ map.js                        # ★ 地图主逻辑
   ├─ api.js                        # ★ 后端接口封装
   ├─ config.js                     # ★ 瓦片源/坐标系/刷新周期等参数
   ├─ vendor\                       # ★ Leaflet 本地副本（离线可用）
   ├─ tiles\                        # 可选：离线瓦片
   └─ serve.bat                     # 本地静态服务器
```

### 6.1 固件（ESP32-S3 侧）

1. **`app_config.h` 新增 4G 配置区 + 编译期冲突检查**（见第 7 节完整清单）
2. **新增 `net_dtu.h/.cpp`**（**不要**把网络逻辑塞进 `main.ino`）：
   - UART 收发、行缓冲、`config,` 命令构造、应答解析
   - `config,get,gpsext` 应答解析（含失败标记 0 的处理）
   - JSON 组包与上报节流、stale 判定、失败重发
   - **非阻塞状态机**：`DTU_OFF → DTU_WAIT_READY → DTU_CFG_LOC → DTU_READY → DTU_UPLOAD`，
     每步有超时与重试，所有 `config,` 应答打日志到 `#DTU` 开头的行
3. **行分流器（line dispatcher）**，规则见 2.2 节
4. **失败不丢数据**：RAM 里存最近 N（默认 10）条，失败保留、下次成功补发或只发最新。
   **写明你选了哪种、为什么**
5. **屏幕加分项**：现有 240×320 竖屏加一行网络状态条
   `4G: OK/NO SIM/NO NET` + `GPS: FIX/FIX 9sats/SEARCH` + `TX: 12/12 ok`。
   ★ 加完必须看 `#FPS` 行，帧率掉到 18 以下要给出降载方案（参考老 README 12.6）

### 6.2 服务端 + 网页大地图

见第 8、9 节（大地图步骤已拆成可执行小步）。

### 6.3 文档

- `README_接线与使用说明.md`：DTU 接线表（强调交叉接）、**供电方案与电容**、
  DTU 配置命令清单（命令 + 期望应答）、启动日志样例、字段说明表、
  FAQ（连不上网 / NO SIM / 定不了位 / 上报失败 / 坐标偏到海里 分别怎么排查）
- `SKILL.md`：按老工程那份结构写 —— 引脚总表、DTU 命令表、初始化顺序、常见坑、
  以及**待确认项 / 推测项 / 冲突项**（如实标注哪些来自官方文档、哪些是你推测的）
- **端到端联调步骤**：烧录 → 插卡接天线 → 配置 DTU → 等定位 → 看服务器收到 → 打开地图看到设备，
  每步给出**期望输出**（串口行 / 服务器日志 / 网页画面）
- **答辩用说明**：为什么用透传 DTU 而不是 AT 模块 / 为什么选 HTTP 而不是 MQTT /
  WGS84 纠偏的必要性（可引用官方文档原文）

---

## 7. ★ 预留的参数接口（重点要求：以后加东西不用推倒重来）

**总原则：所有"会变的量"集中到一处，业务代码只引用符号，不写裸数字。**

### 7.1 固件侧 `app_config.h` 完整参数清单

**A. 身份与网络**
```c
#define NET_ENABLE          1
#define DEVICE_ID           "slope-001"     // 设备唯一 ID，上报/数据库主键
#define DEVICE_MODEL        "M100MG-C2"
#define FW_VERSION          "1.0.0"
#define SERVER_HOST         "192.168.1.100" // 服务器 IP 或域名（可配置）
#define SERVER_PORT         8000
#define POST_PATH           "/api/report"
#define UPLOAD_PERIOD_MS    60000UL         // 上报周期；演示时可改 10000
#define UPLOAD_BACKOFF_MS   30000UL         // 上报失败后的重试间隔
#define UPLOAD_BUF_SLOTS    10              // 失败缓存槽位数
#define HTTP_TIMEOUT_MS     10000UL
```

**B. DTU 串口与命令**
```c
#define PIN_DTU_TX          17      // ESP32 TX -> DTU RXD（按 4.3 节验证后确定）
#define PIN_DTU_RX          18      // ESP32 RX <- DTU TXD
#define PIN_DTU_RST         16      // DTU 复位脚；不接填 -1
#define PIN_DTU_RDY         15      // 联网状态脚；不接填 -1
#define DTU_BAUD            115200UL
#define DTU_UART_NUM        1       // 用 Serial1
#define DTU_CMD_TIMEOUT_MS  3000UL  // 一般命令响应超时（官方建议 3s）
#define DTU_LBS_TIMEOUT_MS  60000UL // 基站定位命令超时（官方建议 60s）
#define DTU_LOC_TYPE        2       // 1=基站定位 2=GPS定位
#define DTU_LOC_PERIOD_S    60      // location 更新周期（秒）
#define DTU_LOC_REPORT_TYPE 0       // 0=不上报(由MCU查) 1=固定格式 2=自定义 ← 方案B用0
#define DTU_PAID_MODE       0       // 0=免费(单基站) 1=付费(多基站+WIFI)
#define DTU_DOWNLINK_ENABLE 1       // 是否解析服务器下发内容
#define DTU_AT_BOOT_RETRY   5       // 配置失败重试次数
```

**C. 定位有效性判定**
```c
#define GPS_STALE_FACTOR    3       // 超过 3×定位周期 未更新 → stale=1
#define GPS_FIX_TIMEOUT_MS  300000UL// 首次定位最长等待（冷启动≤35s，留足余量）
#define GPS_ALLOW_LBS_FALLBACK 0    // 定位失败时是否退回基站定位
#define GPS_MIN_SATS        4       // 判定可用定位的最少卫星数（若 gpsext 能取到）
#define GPS_ALT_VALID       1       // 是否上报海拔
```

**D. 传感器量程与周期（沿用老工程，集中在此）**
```c
#define I2C_SDA             8
#define I2C_SCL             9
#define I2C_CLOCK_HZ        400000UL
#define I2C_TIMEOUT_MS      50
#define AHT30_ADDR          0x38
#define MPU6050_ADDR        0x68
#define MPU6050_ADDR_ALT    0x69
#define MPU_ACCEL_FS_SEL    0
#define MPU_GYRO_FS_SEL     0
#define MPU_PERIOD_MS       50UL    // 20Hz
#define AHT_PERIOD_MS       1000UL  // 1Hz
#define AHT_WAIT_MS         90UL
#define DISP_PERIOD_MS      50UL    // 20FPS
#define CF_TAU_S            0.35f
#define DISP_TAU_S          0.20f
```

**E. 扩展预留（★ 这是本次重点，即使现在不实现也要把接口留好）**

```c
/* ===== 预留：未来传感器插槽，默认 0 = 未启用 ===== */
#define EXT_RAIN_ENABLE     0   // 雨量计
#define EXT_SOIL_ENABLE     0   // 土壤含水率
#define EXT_CRACK_ENABLE    0   // 裂缝位移计
#define EXT_TILT2_ENABLE    0   // 第二路倾角（深部位移）
#define EXT_BATT_ENABLE     0   // 电池电压监测（ADC）

/* 每个扩展传感器预留：类型、引脚/地址、周期、量程、精度、字段名 */
#define EXT_RAIN_PIN        -1
#define EXT_RAIN_PERIOD_MS  60000UL
#define EXT_RAIN_MM_PER_TIP 0.2f

#define EXT_SOIL_ADDR       -1      // 若为 Modbus/RS485 则填地址
#define EXT_SOIL_PERIOD_MS  300000UL

#define EXT_CRACK_PIN       -1
#define EXT_CRACK_PERIOD_MS 60000UL
#define EXT_CRACK_MM_PER_V  1.0f

#define EXT_BATT_ADC_PIN    -1
#define EXT_BATT_DIV_R1     100000.0f
#define EXT_BATT_DIV_R2     100000.0f

/* ===== 预留：低功耗与休眠（现在不实现，留宏与状态机占位） ===== */
#define PWR_SAVE_ENABLE     0
#define PWR_SLEEP_AFTER_MS  0       // 空闲多久进休眠
#define PWR_GPS_OFF_WHEN_IDLE 0     // 空闲时是否关 GPS 电源（GpsSetPower）
#define PWR_LED_OFF_ENABLE  0       // 是否关 LED（PerSetLedSta）

/* ===== 预留：告警阈值（本地判断，服务器端也有一份） ===== */
#define ALARM_TEMP_HIGH_C   40.0f
#define ALARM_TEMP_LOW_C    -10.0f
#define ALARM_HUMI_HIGH_PCT 95.0f
#define ALARM_TILT_DEG      10.0f    // 倾角突变阈值
#define ALARM_BATT_LOW_MV   3400
#define ALARM_ENABLE        0

/* ===== 预留：看门狗与自恢复 ===== */
#define WDT_ENABLE          0
#define WDT_TIMEOUT_S       30
#define DTU_RST_ON_HANG_ENABLE 0     // 长时间无网络时自动复位 DTU
#define DTU_HANG_TIMEOUT_MS 600000UL
```

### 7.2 固件侧统一数据结构（`data_model.h`）——加字段只改这里

```c
/* 统一上报模型：新增传感器 = 在此加一个 struct + 在 json_build 里加一段序列化
   注意：所有可选字段用 "has_xxx" 标志位，未启用时 JSON 里直接不输出该键，
   服务器端按"可选字段"处理，这样固件加字段不会让老服务器报错。 */

typedef struct {
    float temp_c;         bool has_temp;
    float humi_pct;       bool has_humi;
} EnvData;

typedef struct {
    float pitch_deg, roll_deg;
    float ax, ay, az, gx, gy, gz;
    bool  has_att;
} AttData;

typedef struct {
    double lat, lon;
    float  alt;
    float  speed_kmh, course;
    int    sats;
    char   gps_time[24];
    uint8_t fix;      // 0=失败 1=成功
    uint8_t stale;    // 0=新鲜 1=过期
    uint8_t src;      // 0=none 1=gnss 2=lbs
    bool    has_gps;
} GpsData;

/* ★ 扩展位：新传感器往这里加，并同步更新 json_build.c 的字段表 */
typedef struct {
    float rain_mm;      bool has_rain;
    float soil_pct;     bool has_soil;
    float crack_mm;     bool has_crack;
    float tilt2_deg;    bool has_tilt2;
    int   batt_mv;      bool has_batt;
    /* >>> 新增传感器加在这里 <<< */
} ExtData;

typedef struct {
    char     device_id[24];
    uint32_t ts;        // Unix 秒（优先来自 GPS 时间或 NTP，退化用 uptime）
    uint32_t ms;        // 开机毫秒
    EnvData  env;
    AttData  att;
    GpsData  gps;
    ExtData  ext;       // ★ 扩展
    uint8_t  seq;       // 序号，便于服务器去重/排序
} Report_t;
```

**要求**：`has_xxx = false` 时，JSON 里**不要输出**该键（不要输出 `"rain_mm": null`），
这样固件端扩展不会让服务器解析失败。

### 7.3 ★ 字段表（单一事实来源，固件与服务器共用）

新建一份 `field_map.md`（或代码里的常量表），列清楚：

| JSON 路径 | 类型 | 单位 | 是否必填 | 来源 | 说明 |
|---|---|---|---|---|---|
| `device_id` | string | — | ✅必填 | 配置 | 设备唯一 ID |
| `ts` | int | Unix 秒 | ✅必填 | GPS/NTP/uptime | 服务器以它为准排序 |
| `ms` | int | 毫秒 | 可选 | `millis()` | 设备运行时长，调试用 |
| `seq` | int | — | 可选 | 递增 | 去重/乱序检测 |
| `gps.lat` | float | 度 | 定位时必填 | `gpsext` | **WGS84**，7 位小数 |
| `gps.lon` | float | 度 | 定位时必填 | `gpsext` | **WGS84** |
| `gps.alt` | float | 米 | 可选 | `gpsext` | 椭球高/海拔 |
| `gps.fix` | int | — | ✅必填 | `gpsext` | 0 失败 / 1 成功 |
| `gps.stale` | int | — | ✅必填 | 本机判定 | 0 新鲜 / 1 过期 |
| `gps.src` | string | — | ✅必填 | 本机判定 | `gnss`/`lbs`/`none` |
| `gps.sats` | int | 颗 | 可选 | `gpsext` | 卫星数 |
| `gps.speed_kmh` | float | km/h | 可选 | `gpsext` | |
| `gps.course` | float | 度 | 可选 | `gpsext` | 方向角 |
| `gps.gps_time` | string | — | 可选 | `gpsext` | GPS 时间戳 |
| `env.temp_c` | float | ℃ | 可选 | AHT30 | 2 位小数 |
| `env.humi_pct` | float | %RH | 可选 | AHT30 | 2 位小数 |
| `att.pitch_deg` | float | 度 | 可选 | MPU6050 | 抬头为正 |
| `att.roll_deg` | float | 度 | 可选 | MPU6050 | 右倾为正 |
| `att.ax/ay/az` | float | g | 可选 | MPU6050 | |
| `att.gx/gy/gz` | float | °/s | 可选 | MPU6050 | |
| `ext.*` | — | — | **预留** | 未来传感器 | 见 7.1 E 节 |

**硬要求**：写一个自检脚本，**断言固件构造的 JSON 字段与服务器解析的字段完全一致**
（字段名、类型、单位都要对得上）。这是防止「加了字段但服务器不认识」的唯一有效手段。

### 7.4 服务端侧可配置参数（`server/config.py`）

```python
# ===== 服务端可配置参数（集中在此，其他文件不许写裸值）=====
DB_PATH            = "data/slope.db"
HOST               = "0.0.0.0"
PORT               = 8000
CORS_ORIGINS       = ["*"]           # 生产环境收窄
MAX_HISTORY_LIMIT  = 5000            # 单次历史查询上限
ONLINE_TIMEOUT_S   = 300             # 多久没上报算离线（演示可调）
DEFAULT_COORD_SYS  = "wgs84"         # wgs84 | gcj02 | bd09
STORE_RAW_WGS84    = True            # 是否原始坐标与转换坐标都存
RETENTION_DAYS     = 0               # 0=永久保留；>0 自动清理
ALARM_RULES = [                      # ★ 告警规则可配置，不写死在代码里
    # (字段路径, 比较符, 阈值, 级别, 说明)
    ("env.temp_c",    ">",  40.0, "warn", "温度过高"),
    ("env.temp_c",    "<", -10.0, "warn", "温度过低"),
    ("env.humi_pct",  ">",  95.0, "warn", "湿度过高"),
    ("att.pitch_deg", "abs>", 10.0, "critical", "俯仰角突变"),
    ("att.roll_deg",  "abs>", 10.0, "critical", "横滚角突变"),
    ("gps.fix",       "==",   0,  "info",  "定位丢失"),
    ("gps.stale",     "==",   1,  "warn",  "定位数据过期"),
    # >>> 新增告警加在这里 <<<
]
# ★ 预留：将来加传感器只需在这里加规则，无需改代码
```

### 7.5 ★ 数据库设计：用「可扩展」的方式存字段

**核心要求：加一个传感器字段，不需要 `ALTER TABLE`、不需要改插入语句。**

```sql
-- schema.sql

-- 设备表（设备影子 / 远程参数）
CREATE TABLE IF NOT EXISTS devices (
    device_id     TEXT PRIMARY KEY,
    model         TEXT,
    fw_version    TEXT,
    -- ★ 设备侧参数镜像：JSON 存，加参数不用改表
    params_json   TEXT DEFAULT '{}',
    first_seen_ts INTEGER,
    last_seen_ts  INTEGER,
    last_lat      REAL,      -- 最近一次有效定位（WGS84）
    last_lon      REAL,
    last_lat_gcj  REAL,      -- 转换后（按需）
    last_lon_gcj  REAL,
    last_fix      INTEGER DEFAULT 0,
    online        INTEGER DEFAULT 0
);

-- 上报明细表
CREATE TABLE IF NOT EXISTS reports (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id    TEXT NOT NULL,
    ts           INTEGER NOT NULL,      -- Unix 秒
    ms           INTEGER,
    seq          INTEGER,
    -- 固定高频字段，便于索引与地图查询
    lat          REAL,                  -- WGS84
    lon          REAL,
    lat_gcj      REAL,
    lon_gcj      REAL,
    fix          INTEGER DEFAULT 0,
    stale        INTEGER DEFAULT 0,
    src          TEXT,
    temp_c       REAL,
    humi_pct     REAL,
    pitch_deg    REAL,
    roll_deg     REAL,
    -- ★★ 扩展字段一律进 JSON 列：加传感器不用改表结构
    ext_json     TEXT DEFAULT '{}',
    raw_json     TEXT,                  -- 原始报文，排查用
    created_at   INTEGER DEFAULT (strftime('%s','now'))
);

CREATE INDEX IF NOT EXISTS idx_reports_dev_ts ON reports(device_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_reports_ts     ON reports(ts DESC);

-- 告警表
CREATE TABLE IF NOT EXISTS alarms (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id  TEXT NOT NULL,
    ts         INTEGER NOT NULL,
    rule       TEXT,          -- 触发的规则名
    level      TEXT,          -- info/warn/critical
    field      TEXT,
    value      REAL,
    message    TEXT,
    acked      INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_alarms_dev_ts ON alarms(device_id, ts DESC);

-- ★ 预留：原始时序扩展表（将来要做长期趋势/降采样时用，现在建空表即可）
CREATE TABLE IF NOT EXISTS metrics (
    device_id TEXT NOT NULL,
    ts        INTEGER NOT NULL,
    metric    TEXT NOT NULL,   -- 字段名，如 'rain_mm'
    value     REAL,
    PRIMARY KEY (device_id, ts, metric)
);
```

**写入逻辑要求**：
- 插入 `reports` 时，**固定字段照填，其他所有未识别字段统一塞进 `ext_json`**。
  这样固件加了 `rain_mm`，服务器**不改代码**也能存下来，地图/表格想显示时再读 `ext_json`。
- 提供 `GET /api/devices/{id}/metrics?field=rain_mm` 之类的**通用取数接口**，
  前端加一条曲线只需在 `web/config.js` 里加一行字段名。

---

## 8. ★ 网页大地图：拆成可执行小步（Cline 按顺序做）

> 目标：一张大地图，上面按经纬度摆设备 marker，点开看数据，有历史曲线，离线可跑。

### 步骤 1：地图骨架（先不接设备）
1. 下载 **Leaflet** 到 `web/vendor/`（`leaflet.js` + `leaflet.css` + marker 图标），
   **不要用 CDN**，必须能离线打开。
2. `web/index.html` 建一张全屏地图，`web/map.js` 初始化：

```js
// web/config.js —— ★ 所有地图参数集中在这里
export const MAP_CONFIG = {
  tileSource: "osm",        // osm | gaode | tencent | baidu | offline
  coordSys:   "wgs84",      // ★ 与 tileSource 配套：osm→wgs84, gaode/tencent→gcj02, baidu→bd09
  center:     [30.1234567, 104.1234567],
  zoom:       13,
  refreshMs:  5000,
  apiBase:    "http://127.0.0.1:8000",
  showTrail:  true,         // 是否显示轨迹
  trailPoints: 200,         // 轨迹保留点数
  staleDimOpacity: 0.45,    // stale 设备的透明度
  // ★ 预留：以后加曲线只需在这里加字段名
  chartFields: [
    { key: "att.pitch_deg", label: "Pitch (°)" },
    { key: "att.roll_deg",  label: "Roll (°)"  },
    { key: "env.temp_c",    label: "温度 (℃)"  },
    { key: "env.humi_pct",  label: "湿度 (%RH)"},
    // { key: "ext.rain_mm", label: "雨量 (mm)" },   ← 以后加传感器打开这行即可
  ],
};
```
3. 瓦片源配置（`tileSource` 决定 URL 模板与坐标系）：

| tileSource | URL 模板 | 坐标系 | 离线做法 |
|---|---|---|---|
| `osm` | `https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png` | **wgs84** | 下载小范围瓦片到 `web/tiles/` |
| `gaode` | `https://webrd0{1-4}.is.autonavi.com/appmaptile?x={x}&y={y}&z={z}&lang=zh_cn&size=1&scl=1&style=7` | **gcj02** | 同上，需纠偏 |
| `tencent` | `https://rt{0-3}.map.gtimg.com/tile?z={z}&x={x}&y={-y}&type=vector&styleid=3` | **gcj02** | 同上 |
| `offline` | `tiles/{z}/{x}/{y}.png`（本地） | 按你导出时用的底图 | 用工具预先下载区域瓦片 |

**离线可用性要求**：`web/serve.bat` 一键起本地静态服务（浏览器 `file://` 打不开时用）；
文档里给出"如何预先下载一块区域瓦片"的具体命令或工具名。

### 步骤 2：从后端拉设备并摆 marker
```js
// web/api.js —— ★ 后端接口封装，所有请求只在这里
export const api = {
  listDevices:    ()      => fetchJSON(`${API}/api/devices`),
  deviceDetail:   (id)    => fetchJSON(`${API}/api/devices/${id}`),
  deviceHistory:  (id, p) => fetchJSON(`${API}/api/devices/${id}/history?` + qs(p)),
  deviceMetrics:  (id, f) => fetchJSON(`${API}/api/devices/${id}/metrics?field=${f}`),
  health:         ()      => fetchJSON(`${API}/api/health`),
};
```
`map.js` 里：
- `setInterval(refresh, MAP_CONFIG.refreshMs)` 定时刷新
- 每台设备一个 `L.marker`，**按 `coordSys` 决定是否需要坐标转换**（转换在服务器做，前端只声明）
- **`fix=0` 或 `lat==null` 的设备：只出现在侧边设备列表里，绝不落图**（否则会全堆在 (0,0) 大西洋上）
- `stale=1` 的设备：marker 降低透明度 + 换灰色图标，提示"数据过期"
- marker 颜色按状态：正常绿 / 告警黄 / 离线灰 / 严重红

### 步骤 3：点击 marker 弹出数据面板
面板内容（全部来自 `/api/devices/{id}` + 最新 report）：
- 设备号、型号、固件版本
- **最后在线**（相对时间，如"3 分钟前"，超 `ONLINE_TIMEOUT_S` 标红"离线"）
- **定位**：经纬度（同时显示 WGS84 与转换后坐标）、海拔、`fix`、`sats`、`src`、是否 `stale`
- **环境**：温度、湿度
- **姿态**：pitch / roll（**方向约定必须与固件和屏幕一致**：
  pitch = `atan2(f, √(r²+u²))` 抬头为正；roll = `atan2(-r, u)` 右倾为正；注意 +Y 物理上指向左边）
- **扩展区**：遍历 `ext_json` 的键值自动渲染（★ 以后加传感器**不用改前端**）
- 快捷操作：聚焦到该设备、显示/隐藏轨迹、查看历史

### 步骤 4：历史曲线
- 用**轻量方案**（自己用 Canvas 画，或引一个极小的图表库），**不要**引一堆重量级依赖
- 曲线字段来自 `MAP_CONFIG.chartFields` 数组 → **加一条曲线只改 `config.js` 一行**
- 支持时间范围切换（1h / 6h / 24h / 7d）、鼠标悬停读数、点击图表重置
- 姿态角曲线要与屏幕朝向口径一致（见步骤 3）

### 步骤 5：轨迹与漫游（加分项）
- `polyline` 画设备历史轨迹（点数上限 `trailPoints`），按时间渐变着色
- 多设备时可选"自动跟随最新上报的设备"
- 可选：时间轴播放（拖动滑块回放历史轨迹）

### 步骤 6：离线与演示保障
- 全部依赖放 `web/vendor/`，`index.html` 用相对路径引用
- 提供 `serve.bat`（Python `http.server` 或 Node）
- **提供"演示数据"按钮**：不连服务器也能看地图效果（生成几台虚拟设备绕圈移动），
  便于答辩前演练和前端调试
- 文档写明：答辩现场若断网，如何切到 `offline` 瓦片源

### 步骤 7：自检脚本（对标老工程的 `selftest.js`）
- `web/selftest.js`：坐标转换正确性、API 响应解析、`fix=0` 不落图、`stale` 降透明度、
  `ext_json` 动态渲染 —— 全部断言，`node web/selftest.js` 返回码 0 表示通过

---

## 9. 服务端接口定义（服务端按此实现）

| 方法 | 路径 | 用途 | 关键点 |
|---|---|---|---|
| `POST` | `/api/report` | 设备上报 | **必须容错**：缺字段 / `lat=null` / `fix=0` / 未知扩展字段 都要能入库并返回 200 |
| `GET` | `/api/devices` | 设备列表 + 最新状态 | 含在线判定、最新坐标、最新温湿度/姿态 |
| `GET` | `/api/devices/{id}` | 单设备详情 | 含 `params_json` 镜像 |
| `GET` | `/api/devices/{id}/history?from=&to=&limit=` | 历史明细 | 分页，`limit` 受 `MAX_HISTORY_LIMIT` 限制 |
| `GET` | `/api/devices/{id}/metrics?field=&from=&to=` | **★ 通用指标取数** | 加传感器不用加接口 |
| `GET` | `/api/alarms?device_id=&level=&acked=` | 告警列表 | 按 `ALARM_RULES` 生成 |
| `POST` | `/api/alarms/{id}/ack` | 确认告警 | |
| `GET` | `/api/health` | 健康检查 | 返回版本、库大小、设备数 |

**实现要求：**
- 监听 `HOST`/`PORT`（`0.0.0.0`），文档写清**防火墙放行**
- CORS 按 `CORS_ORIGINS` 配置
- 请求体解析失败要返回 **400 且带原因**，不要 500
- **错误日志要打印原始报文**，方便定位是固件组包问题还是解析问题
- 出报告单：给出 `curl` 测试命令（假数据打通用）

---

## 10. 端到端联调步骤（写完文档把这节做成清单）

| # | 步骤 | 期望看到什么 |
|---|---|---|
| 1 | 只烧固件（不插 DTU），看串口 | 原有 `MPU,` / `AHT,` / `Pitch:` 行正常，20Hz/1Hz 稳定 |
| 2 | 启动服务端，`curl` POST 假 JSON | 服务器 200 + 日志打印；`sqlite3` 能查到记录 |
| 3 | 打开网页地图 | 假数据那台"设备"落在地图正确位置；点开面板数据对 |
| 4 | 接上 DTU，**先只做电源与串口通信** | 串口看到 `#DTU` 配置命令与应答；`config,get,gpsext` 有返回 |
| 5 | 看 DTU 指示灯 | 网络正常时 `NET LED` 1000ms 慢闪且 **`RDY` 常亮**；SIM 不识别是 5s 亮 5s 灭 |
| 6 | 拿 DTU 到**室外/窗边**等定位 | `GPS LED`(1PPS) 开始闪烁；`gpsext` 返回定位标记 `1` |
| 7 | 观察服务器日志 | 收到真实设备的 POST，经纬度合理（不是 0,0） |
| 8 | 刷新网页地图 | 真实设备落图；点开面板显示温湿度与姿态 |
| 9 | 拔天线/断电测试 | 服务器能看到设备 `offline`；地图上设备变灰，**不消失也不跑到 (0,0)** |
| 10 | 拔插 SIM、断开 DTU 电源，看恢复 | 固件与 DTU 都能自动恢复，无需人工重启 |

---

## 11. 硬性约束（违反就是错）

1. **不要写 AT 指令联网流程**（`AT+CGATT`/`AT+CIPSTART`/`AT+HTTPINIT` 等一律不要）。
   配置命令必须是 `config,set/get,...` 格式（见 2.1、2.3）。
2. **不许猜命令**。文档没写的，停下来问我，或做成"可配置命令模板 + 打印原始应答"。
3. **报文字节纪律**：ESP32 发给 DTU 的数据里不得出现"以 `config` 开头且 `\r\n` 结尾"的行；
   配置命令必须以 `\r\n` 结尾；上报 JSON 必须单行。
4. **供电不许糊弄**：不许把 DTU 的 `VIN` 接到开发板 `3V3`。必须独立 3.8V/2A（或 3.7V 锂电 + DCDC）+ 去耦电容。
5. **不许用 `delay()` 做长等待**（尤其基站定位 60s 超时那次）。
6. **不许破坏现有功能**：I2C 8/9、屏幕 6 脚、`USE_FSPI_PORT`、串口输出格式，
   `node web/selftest.js` 与 `selftest_ui.js` 必须继续全过。
7. **引脚不够就明说**：排不出可用 GPIO 时明确告知并给备选，**不要偷偷复用已占用的脚**。
8. **先打通假数据**：先用 `curl` POST 一条假 JSON，确认入库 + 地图显示正确，再上真硬件。
9. **可扩展性是本项目的验收标准之一**：新增一个传感器字段，固件只改 `data_model.h` 与字段表，
   服务器不改表结构、不改插入语句，前端只改 `config.js` 一行。
   **你要在文档里用一个具体例子演示这条路径**（例如"现在把雨量计加进来，需要改哪 3 个地方"）。
10. **平台配置文件必须给完整内容**：`platformio.ini` 的 `build_flags`、`compile_options`
    全部逐行写出，**不许写"沿用原工程配置"**（我不是从零建的空项目，但你不知道我手上是哪份，
    所以必须给全，以便我核对）。

---

## 12. 执行阶段（严格按顺序，每阶段做完停下来汇报）

### 阶段 1：接线与供电确认（**不做代码，只出方案**）
产出：最终引脚分配表 + 理由、DTU 接线复核（强调交叉接与共地）、
供电方案与电容取值、整机电流估算表。
→ **停下来等我确认。**

### 阶段 2：工程骨架 + 原代码搬迁
产出：按 6.0 节建目录；把老工程的 `attitude.*`、`display_st7789.*` 复制过来并在文档标注"原样搬入"；
`platformio.ini` **写全**；`app_config.h` 按第 7 节写全（含扩展预留宏）。
**验收**：`pio run` 编译通过，行为与老工程一致。

### 阶段 3：数据模型 + JSON 组包 + 单测
产出：`data_model.h`、`json_build.*`、字段表文档、**JSON 字段一致性自检脚本**。
**验收**：自检脚本跑通；`has_xxx=false` 的字段确实不出现在 JSON 里。

### 阶段 4：DTU 通信层（先不接真 DTU，用假串口/回环测）
产出：`net_dtu.*`、行分流器、`config,` 命令构造、`gpsext` 解析、非阻塞状态机；
**分流器单元测试**（混合输入断言分流正确）。
**验收**：编译通过 + 单测通过；用日志能看到完整状态迁移。

### 阶段 5：服务端
产出：`server/` 全部文件、`schema.sql`、`coord.py` + `test_coord.py`、`config.py`。
**验收**：`curl -X POST` 假 JSON 返回 200；`sqlite3` 查到记录；坐标转换单测通过；
`fix=0` 与未知扩展字段都能入库。

### 阶段 6：网页大地图
产出：`web/` 全部文件（含本地 Leaflet）、`config.js` 参数化、`selftest.js`。
按第 8 节步骤 1→7 逐步做。
**验收**：断开外网仍能打开地图（`offline` 或已缓存瓦片）；
假数据设备落图正确；`fix=0` 设备不落图；`node web/selftest.js` 通过。

### 阶段 7：端到端联调
按第 10 节清单逐条走，记录实测结果（**如实写，没测到的就写"未测"**）。

### 阶段 8：文档收尾
产出：`README_接线与使用说明.md`（含接线、供电、DTU 命令清单、FAQ、联调清单）、
`SKILL.md`（引脚表/命令表/待确认项/推测项/冲突项）、
**可扩展性演示**（第 11 节第 9 条的"加一个雨量计要改哪 3 个地方"）、
答辩用说明。

---

## 13. 我需要你特别注意的「待确认 / 推测」项（必须如实标注）

写文档时，把下面这些**明确标为"推测"或"待实测"**，不要写成确定结论：

| 项 | 状态 |
|---|---|
| DTU 主串口默认波特率具体是多少 | **待实测**（规格书写支持 1200~460800；本文档默认按 115200 起步） |
| DTU 出厂默认网络通道是否已配置好 HTTP | **待确认**（需用银尔达 DTU 配置平台 `https://dtu.yinerda.com` 或串口配置） |
| `location` 的"定位数据更新周期"是查询周期还是上报周期 | **待实测**（本文档按方案 B 用 `report_type=0`，由 MCU 主动查，规避该歧义） |
| `gpsext` 是否返回卫星数 `sats` | **待实测**（返回字段清单里没有 sats，若取不到则 `sats` 置 0 或去掉该字段） |
| 4G 发射瞬时峰值电流实测值 | **待实测**（按 10W 估算，必须实测后再定电容容量） |
| 屏幕加网络状态条后的实际帧率 | **待实测**（看 `#FPS` 行） |
| 基站定位在本地的实际可用性与精度 | **待实测**（官方说明偏差大、可能失败） |
| GPIO15/16 在你的具体开发板上是否引出 | **待确认**（对照你的板子丝印/原理图；不可用就换脚） |

---

## 14. 参考资料（官方文档，遇到歧义优先查这些）

- **M100MG-C2 主文档**：https://yinerda.yuque.com/yt1fh6/4gdtu/uucgolaszusid1ok
- **DTU 透传固件命令约定**：https://yinerda.yuque.com/yt1fh6/eth/keuxg7rbz3hlrw3g
- **DTU 透传固件定位命令**：https://yinerda.yuque.com/yt1fh6/4gdtu/qmevnwraemriyoo1
- **DTU 透传固件常用 API 手册**：https://yinerda.yuque.com/yt1fh6/eth/fnvdlih159wtyqth
- **HTTP 配置测试实例**：https://yinerda.yuque.com/yt1fh6/4gdtu/sqk72vapn8l56hy0
- **MQTT 配置测试实例**：https://yinerda.yuque.com/yt1fh6/4gdtu/qqvrgz251f9tu1u1
- **DTU 硬件相关 FAQ**：https://yinerda.yuque.com/yt1fh6/4gdtu/oiwacwtdreng1tgs
- **DTU 配置平台**：https://dtu.yinerda.com　　**DTU 测试平台**：http://test.yinerda.com
- **合宙 Air780 官方 API**：https://wiki.luatos.com/api/index.html

**我的现有工程参考文档（同目录外）**：
- `D:\MUMUcode\esp32 毕设\esp32-0920-aht30-mpu6050\SKILL.md`
- `D:\MUMUcode\esp32 毕设\esp32-0920-aht30-mpu6050\README_接线与使用说明.md`

---

**现在开始：请先执行【阶段 1：接线与供电确认】，做完停下来等我确认。**
