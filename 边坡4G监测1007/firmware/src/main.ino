/* ============================================================================
 *  项目名称 : 边坡 4G 监测节点（边坡4G监测1007）
 *             AHT30 + MPU6050 --I2C--> ESP32-S3 --UART1--> 银尔达 YED-M100MG-C2 透传DTU --4G--> 服务器
 *  主控芯片 : ESP32-S3-DevKitC-1 (ESP32-S3-WROOM-1, Arduino ESP32 框架)
 *  ★ 本文件来源 : 由老工程 esp32-0920-aht30-mpu6050 的 esp32_0920_aht30_mpu6050.ino
 *                 「原样搬入」（PROMPT 阶段 2），只同步了文件头注释，
 *                 传感器 / 姿态 / 屏幕的业务代码一行未改（保证行为与老工程一致）。
 *                 4G DTU 的收发与上报状态机将在【阶段 4】追加到本文件末尾。
 * ----------------------------------------------------------------------------
 *  硬件清单 :
 *    1) ESP32-S3 开发板         x1
 *    2) AHT30 温湿度模块        x1   (I2C 从机地址 0x38)
 *    3) MPU6050 六轴模块        x1   (I2C 从机地址 0x68 / AD0 接 VCC 时为 0x69)
 *    4) ST7789 彩屏 240x320     x1   (SPI，8 针：GND/VCC/SCL/SDA/RES/DC/CS/BLK)
 *    5) 银尔达 YED-M100MG-C2 4G 透传 DTU x1  (★ 独立 3.8V/2A 供电，见 docs/阶段1)
 *    6) 4G 天线 + GPS 天线      x2   (★ 必须接；GPS 必须放室外，室内无法定位)
 *    7) USB 数据线（能传数据） x1
 *    8) 杜邦线若干（I2C 两根模块共用一条总线；屏幕 6 根信号线 + 电源；DTU 4 根 + 共地）
 * ----------------------------------------------------------------------------
 *  功能概述 :
 *    1) 屏幕主画面（竖屏 240x320）：
 *       · 上 240x240 = 航空 ADI 人工地平线：天空(浅蓝)/地面(棕褐)渐变随 roll 旋转、
 *         随 pitch 上下平移，白色地平线、俯仰刻度 ±10/20/30（带数字）、
 *         顶部横滚刻度与指针、中央固定飞机符号、顶部数值框（P / ROLL / 状态点）
 *       · 下 80px = 温湿度：FONT4 大字显示 "TEMP 25.3 C / HUMI 61.2 %"（1 位小数）
 *    2) MPU6050 20Hz：读加速度+陀螺 → 互补滤波解算 pitch/roll → 串口输出 → 屏幕刷新
 *    3) AHT30 1Hz：触发测量 → 等 90ms → 读 7 字节帧(CRC8) → 屏幕温湿度区 + 串口输出
 *    4) 全程 millis() 非阻塞：AHT30 的 90ms 等待由定时器承担，主循环里没有任何 delay()
 *    5) 传感器掉线自动重试（每 2 秒）；I2C 单次事务超时 50ms，不会卡死主循环
 *    6) 背光 GPIO42 用 LEDC PWM 调光（5kHz / 8bit，默认 80%）
 * ----------------------------------------------------------------------------
 *  串口输出格式（115200 8N1，同时写 USB CDC 与 UART0）:
 *    MPU,<millis>,ax,ay,az,gx,gy,gz   每 50ms 一行（20Hz，原始数据，网页仪表盘用）
 *    AHT,<millis>,temperature,humidity 每 1000ms 一行（1Hz）
 *    ATT 姿态行                       每 50ms 一行（20Hz，格式见 app_config.h 的 ATT_LINE_STYLE）
 *    #...                              以 # 开头的是状态/错误/帧率提示行，不是数据
 * ----------------------------------------------------------------------------
 *  依赖库 : TFT_eSPI（显示图形库，仅此一个）
 *           AHT30 与 MPU6050 的寄存器读写、数据帧解析、CRC8 校验仍然全部在本文件内
 *           自行实现，不使用任何第三方传感器库。
 *           ★★★ ESP32-S3 必须给 TFT_eSPI 传 -DUSE_FSPI_PORT=1（已写在 platformio.ini），
 *           否则 tft.init() 会崩、屏幕"背光亮但全黑"，原因见 README 第十二节。
 * ----------------------------------------------------------------------------
 *  引脚说明 :
 *    AHT30   VCC -> 3.3V   GND -> GND   SDA -> GPIO8   SCL -> GPIO9
 *    MPU6050 VCC -> 3.3V（不要接 5V）   GND -> GND
 *            SDA -> GPIO8              SCL -> GPIO9
 *    ST7789  GND -> GND    VCC -> 3V3    MISO 不接
 *            SCL(SCLK) -> GPIO21   SDA(MOSI) -> GPIO47   RES -> GPIO45
 *            DC        -> GPIO40   CS        -> GPIO41   BLK -> GPIO42
 *    ★4G DTU（银尔达 M100MG-C2，透传固件，走 Serial1 / UART1）：
 *            ESP32 GPIO17 (TX) -> DTU 的 RXD   ★ 交叉接
 *            ESP32 GPIO18 (RX) <- DTU 的 TXD   ★ 交叉接
 *            ESP32 GPIO16      -> DTU 的 RST（可选，建议 10k 上拉到 3.3V）
 *            ESP32 GPIO15      <- DTU 的 RDY（可选，3.3V 输出，联网成功为高）
 *            DTU 的 VIN 必须独立 3.8V/2A 供电（★ 绝不能接开发板 3V3），GND 必须共地
 *            DTU 的 1PPS 不接（1.8V 电平）；DTR/BOOT/Relaod 不接
 *    GPIO43/44  UART0 TX/RX（接板上 USB 转串口芯片，程序只写不读）
 *    GPIO19/20  原生 USB D-/D+（USB CDC 虚拟串口用）
 *    GPIO1/4/5/6/7  预留给扩展传感器（电池采样 / 雨量 / RS485 土壤 / 裂缝计），本阶段不用
 *    ★ 引脚宏集中在 app_config.h（含编译期冲突检查），改接线请看那里 + platformio.ini
 * ============================================================================ */

/* ========================= 1. 头文件 ========================= */
#include <Arduino.h>            // Arduino 核心（Serial / millis 等）
#include <Wire.h>               // ESP32 核心自带 I2C 库（AHT30 / MPU6050 用它驱动）
#include <SPI.h>                // SPI 总线（TFT_eSPI 内部使用，显式包含便于排错）
#include <math.h>               // lroundf / atan2f 等
#include <stdarg.h>             // va_list（用于封装格式化输出）
#include "app_config.h"         // ★ 全局配置：引脚 / 周期 / 滤波 / UI / 背光（含冲突检查）
#include "attitude.h"           // 姿态解算模块（安装方向映射 + 互补滤波）
#include "display_st7789.h"     // ST7789 屏幕模块（ADI 姿态仪 + 温湿度区 + 背光）

/* ========================= 2. 引脚与总线速率 =========================
 *  ★ 引脚宏、I2C 速率/超时、器件地址、MPU 量程等全部集中在 app_config.h
 *    （第 1 节 = 引脚 + 冲突检查；第 14 节 = 传感器参数），
 *    这样"参数集中一处"和"编译期引脚冲突检查"才能同时成立。
 *    本文件不再 #define 这些量（阶段 2 从本文件搬走）。 */

/* ========================= 3. 运行参数 =========================
 *  ★ 周期/滤波/亮度/屏幕参数全部在 app_config.h，本文件只保留"传感器协议"相关参数。
 *    常用几个（在 app_config.h）：
 *      MPU_PERIOD_MS = 50   → MPU6050 20Hz（读→解算→串口→屏幕刷新）
 *      AHT_PERIOD_MS = 1000 → AHT30 1Hz（触发后等 AHT_WAIT_MS=90ms 再读）
 *      DISP_PERIOD_MS = 50  → 屏幕姿态层 20FPS
 *      ATT_LINE_STYLE = 1   → 姿态串口行用 "Pitch: 12.3, Roll: -4.5"
 * ------------------------------------------------------------------------- */
/* ---- 串口 ---- */
#define SERIAL_BAUD     115200UL  // 串口波特率，必须与串口监视器/上位机一致

/* ---- 超时 / 重试（I2C_TIMEOUT_MS 已移到 app_config.h 第 14 节）---- */
#define ERR_LIMIT       3         // 连续读失败多少次判为"掉线"
#define RETRY_INTERVAL_MS 2000UL  // 掉线后每 2 秒重试一次

/* ---- I2C 器件地址（7 位）：已移到 app_config.h 第 14 节
 *      AHT30_ADDR = 0x38 / MPU6050_ADDR = 0x68 / MPU6050_ADDR_ALT = 0x69 ---- */

/* ---- 上电等待 ---- */
#define AHT_POWER_ON_MS 500UL     // AHT30 上电后等待时间
#define MPU_SETTLE_MS   50UL      // MPU6050 唤醒后内部稳定时间

/* ---- AHT30 命令与状态位 ---- */
#define AHT_CMD_MEASURE_0  0xAC   // 触发测量命令：0xAC 0x33 0x00
#define AHT_CMD_MEASURE_1  0x33
#define AHT_CMD_MEASURE_2  0x00
#define AHT_STATUS_BUSY      0x80 // 状态字 bit7：1 = 忙（转换未完成）
#define AHT_STATUS_READY_MSK 0x18 // 状态字 bit4(CRC标志) + bit3(校准使能)
#define AHT_READ_OK          0    // aht30ReadFrame() 返回值：成功
#define AHT_READ_I2CERR      1    //   I2C 读失败
#define AHT_READ_BUSY        2    //   数据还没转换完
#define AHT_READ_CRCERR      3    //   CRC8 校验不通过

/* ---- MPU6050 寄存器 ---- */
#define MPU_REG_SMPLRT_DIV   0x19 // 采样率分频
#define MPU_REG_CONFIG       0x1A // 数字低通滤波 DLPF
#define MPU_REG_GYRO_CFG     0x1B // 陀螺量程
#define MPU_REG_ACCEL_CFG    0x1C // 加速度量程
#define MPU_REG_PWR_MGMT_1   0x6B // 电源管理 1（bit6=SLEEP）
#define MPU_REG_WHO_AM_I     0x75 // 器件 ID
#define MPU_REG_DATA         0x3B // 数据区首地址（ACCEL_XOUT_H），连读 14 字节

/* ---- MPU6050 量程与灵敏度：已移到 app_config.h 第 14 节
 *      （MPU_ACCEL_FS_SEL / MPU_GYRO_FS_SEL / MPU_ACCEL_LSB_PER_G / MPU_GYRO_LSB_PER_DPS）
 *   改量程时的取值范围提示：
 *      加速度 FS_SEL：0=±2g(16384) 1=±4g(8192) 2=±8g(4096) 3=±16g(2048)     [LSB/g]
 *      陀螺   FS_SEL：0=±250(131.0) 1=±500(65.5) 2=±1000(32.8) 3=±2000(16.4) [LSB/(°/s)] */

/* ========================= 4. 全局变量 ========================= */

/* ---- 传感器数据结构 ---- */
typedef struct {
  bool    ok;       // 本次数据是否有效
  float   ax, ay, az;   // 加速度 g
  float   gx, gy, gz;   // 角速度 °/s
  float   tchip;        // 芯片温度 ℃（非环境温度，仅供参考）
} MpuData;

typedef struct {
  bool    ok;       // 本次数据是否有效（含 CRC 校验通过）
  float   t;        // 温度 ℃
  float   rh;       // 相对湿度 %RH
  uint8_t status;   // 状态字
  bool    crcOk;    // CRC8 是否通过
} AhtData;

/* ---- 运行状态机（所有时间判断都用 millis()） ---- */
enum {
  ST_BOOT_WAIT = 0,   // ① 上电稳定等待
  ST_INIT_MPU,        // ② 初始化 MPU6050
  ST_MPU_SETTLE,      // ③ 等 MPU6050 内部稳定
  ST_INIT_AHT,        // ④ 检查 AHT30 状态字
  ST_AHT_FIX,         // ⑤ AHT30 校准寄存器修复（非阻塞分步）
  ST_CALIB,           // ⑥ 开机静置校准（陀螺零偏 + 姿态零点，非阻塞）
  ST_RUN              // ⑦ 正常运行：MPU 50ms(20Hz) / AHT 1000ms / 屏幕 50ms(20FPS)
};

static uint8_t  appState = ST_BOOT_WAIT;   // 当前状态
static uint32_t stateT0  = 0;              // 进入当前状态的时间戳

/* ---- 传感器在线状态与重试 ---- */
static bool     mpuOnline = false;         // MPU6050 是否在线
static bool     ahtOnline = false;         // AHT30 是否在线
static uint8_t  mpuErrCnt = 0;             // MPU6050 连续读失败计数
static uint8_t  ahtErrCnt = 0;             // AHT30 连续读失败计数
static uint32_t mpuNextMs = 0;             // 下一次 MPU 采样的时刻
static uint32_t ahtNextMs = 0;             // 下一次 AHT 触发的时刻
static uint32_t mpuRetryMs = 0;            // 下一次 MPU 重试的时刻
static uint32_t ahtRetryMs = 0;            // 下一次 AHT 重试的时刻
static uint8_t  mpuAddr = MPU6050_ADDR;    // 实际使用的 MPU6050 地址（0x68 或 0x69）
static uint8_t  mpuWho  = 0;               // WHO_AM_I 读到的值

/* ---- AHT30 的"触发 → 等 90ms → 读"非阻塞流程 ---- */
static bool     ahtWaiting = false;        // true = 已触发测量，正在等转换完成
static uint32_t ahtTrigMs  = 0;            // 触发测量的时刻

/* ---- AHT30 校准寄存器修复（分步执行，见 8.3 节） ---- */
static const uint8_t kAhtFixRegs[3] = {0x1B, 0x1C, 0x1E};  // 需要修复的 3 个寄存器
static bool     ahtNeedFix = false;        // 是否需要走一遍修复流程
static uint8_t  fixIdx = 0;                // 当前修到第几个寄存器(0~2)
static uint8_t  fixStep = 0;               // 当前寄存器做到哪一步(0~2)
static uint8_t  fixRegAddr = 0x1B;         // 当前寄存器地址
static uint8_t  fixRegs[3] = {0, 0, 0};    // 回读到的寄存器内容
static uint8_t  fixRounds = 0;             // 已修复轮数（避免反复修复卡住流程）
static uint32_t fixT0 = 0;                 // 分步计时

/* ---- 姿态解算与屏幕的运行时状态（新增） ---- */
static BodyVec  gBody;                     // 机体坐标量（映射 + 解算的中间结果）
static uint32_t lastImuUs  = 0;            // 上一次 IMU 采样时刻(us)，用于算积分间隔 dt
static uint32_t nextAttMs  = 0;            // 下一次姿态串口输出的时刻
static uint32_t nextDispMs = 0;            // 下一次屏幕刷新的时刻（20FPS）
static uint32_t nextFpsMs  = 0;            // 下一次帧率提示的时刻
static uint32_t imuSamples = 0;            // 累计解算次数（统计用）
static bool     displayOk  = false;        // 屏幕是否初始化成功
static bool     bootDrawn  = false;        // 开机画面是否已画（避免重复刷屏）
static uint8_t  calibPct   = 0;            // 校准进度百分比（只在变化时重画）
static uint32_t calibNextMs = 0;           // 校准期间下一次采样时刻

/* ---- 统计（只用于状态提示，不参与输出格式） ---- */
static uint32_t mpuCount = 0;              // 已输出 MPU 行数
static uint32_t ahtCount = 0;              // 已输出 AHT 行数

/* ---- 排错与交互（新增） ---- */
static MpuData  lastMpu;                   // 最近一帧 MPU 原始数据（自检画面 / #Axes 行用）
static bool     lastMpuOk = false;         // 最近一帧是否有效
static bool     diagMode  = false;         // true = 屏幕显示"方向/轴向自检"画面（串口 'd' 切换）

/* ========================= 5. 函数声明（模块化，便于阅读） ========================= */
/* --- 5.1 串口与格式化 --- */
void initSerial(void);                                   // 初始化串口（USB CDC + UART0 双通路）
void outLine(const char *text);                          // 输出一行（双通路）
void statusLine(const char *text);                       // 输出一行状态提示（自动加 "#" 前缀）
void fmtFixed(char *dst, size_t size, int32_t scaled, uint8_t decimals);  // 定点小数格式化

/* --- 5.2 I2C 基础操作 --- */
void initI2C(void);                                      // 初始化 I2C（含 50ms 超时）
bool i2cWriteCmd(uint8_t addr, const uint8_t *buf, uint8_t len);          // 写原始字节
bool i2cReadBytes(uint8_t addr, uint8_t *buf, uint8_t len);               // 读原始字节
bool i2cWriteReg(uint8_t addr, uint8_t reg, uint8_t value);               // 写单个寄存器
bool i2cReadRegs(uint8_t addr, uint8_t reg, uint8_t *buf, uint8_t len);   // 从寄存器连读

/* --- 5.3 AHT30 模块 --- */
bool    aht30ReadStatus(uint8_t *status);                // 读状态字（1 字节）
bool    aht30TriggerMeasure(void);                       // 触发一次测量
uint8_t aht30ReadFrame(AhtData *out);                    // 读 7 字节数据帧并解析（返回 AHT_READ_xxx）
uint8_t aht30Crc8(const uint8_t *data, uint8_t len);     // CRC8（多项式 0x31，初值 0xFF）
bool    aht30FixRun(void);                               // 校准寄存器修复：推进一步，返回是否已结束

/* --- 5.4 MPU6050 模块 --- */
bool mpuInitDevice(void);                                // 检测 + 配置 MPU6050
bool mpuReadSample(MpuData *out);                        // 读 14 字节并换算物理单位

/* --- 5.5 输出与状态 --- */
void printMpuLine(const MpuData *d, uint32_t ms);        // MPU,<ms>,ax,ay,az,gx,gy,gz
void printAhtLine(const AhtData *d, uint32_t ms);        // AHT,<ms>,temperature,humidity
void printAttLine(uint32_t ms, float pitch, float roll); // 姿态行（CSV 或可读格式，见 ATT_LINE_STYLE）
void printEnvHumanLine(uint32_t ms, float t, float rh);  // Temp: 25.3 C, Humi: 61.2 %
void printFpsLine(uint32_t now);                         // #FPS / #SLOW 提示
void printAxesLine(uint32_t now);                        // #Axes 轴向核对行（1Hz，改方向时看它）
void printCmdHelp(void);                                 // 串口命令帮助
void printBanner(void);                                  // 启动横幅
void printSensorState(void);                             // 打印两个传感器在线状态
void cfgPinRuntimeCheck(void);                           // 运行期引脚自检（打印 #WARN 提示）
void pollSerialCommands(uint32_t now);                   // 串口命令（d/m/r/b/B/c/h，见 app_config.h）

/* --- 5.6 运行调度（全部 millis() 非阻塞） --- */
void taskAttitude20Hz(uint32_t now);                     // 每 50ms：读 MPU → 解算 → 串口（含 MPU 行）+ 请求刷屏
void taskTempHumi1Hz(uint32_t now);                      // 每 1000ms：AHT30 触发 + 90ms 后读取 → 屏幕 + 串口
void taskDisplay20Fps(uint32_t now);                     // 每 50ms：重绘姿态层（20FPS）
void taskRetry(uint32_t now);                            // 掉线重试任务

/* ========================= 6. 初始化 setup() =========================
 * setup() 里只做"立刻能完成"的事（串口、I2C、横幅），没有任何长等待；
 * 需要等待的初始化（上电稳定、校准、MPU 稳定）全部交给 loop() 的状态机。
 * ---------------------------------------------------------------------------- */
void setup() {
  initSerial();                 // 串口（同时打开 USB CDC 与 UART0）
  printBanner();                // 启动横幅
  cfgPinRuntimeCheck();         // 运行期引脚自检（与 app_config.h 的编译期检查互补）

  displayOk = dispInit();       // 屏幕：TFT 初始化 + LEDC 背光(80%) + 创建离屏画布
  if (displayOk) {
    dispPrintConfig();          // 打印"实际生效"的屏幕配置（驱动/引脚/SPI/Sprite/内存）
    dispSetSensorState(false, false);
  }

  initI2C();                    // I2C 总线 + 50ms 事务超时
  attReset();                   // 姿态模块复位（滤波 + 校准状态）
  printSensorState();           // 打印周期/超时等参数，便于核对
  printCmdHelp();               // 串口命令帮助（d/m/r/b/B/c/h）

  lastImuUs = micros();
  stateT0   = millis();
  appState  = ST_BOOT_WAIT;     // 进入"上电稳定等待"
}

/* ========================= 7. 主循环 loop()（全程非阻塞状态机） =========================
 * 状态流转：
 *   ① 上电等待 500ms（并画一次开机画面）→ ② 初始化 MPU6050 → ③ 等 50ms 稳定
 *   → ③.5 开机静置校准（可选，CALIB_ENABLE=1，非阻塞）→ ④ 检查 AHT30 状态字
 *   → ⑤ 需要时修复 AHT30 校准寄存器（分步，不阻塞）→ ⑦ 运行
 *
 * 运行阶段（ST_RUN）由几个任务函数组成，各自用 millis() 判断"到点了吗"：
 *   taskAttitude20Hz()：每 50ms 读一次 MPU6050 → 互补滤波解算 → 输出 MPU,行 + 姿态行
 *   taskDisplay20Fps()：每 50ms 重绘一次姿态层（Sprite 离屏绘制 + 一次推送，20FPS）
 *   taskTempHumi1Hz() ：每 1000ms 触发 AHT30 测量，90ms 后再来读并刷新屏幕温湿度区
 *                       （90ms 等待用定时器实现，绝不在主循环里 delay）
 *   taskRetry()       ：掉线的传感器每 2 秒重试一次（重新初始化）
 * 任何一个传感器不在线，另外的照常工作，主循环不会被卡住。
 * ---------------------------------------------------------------------------- */
void loop() {
  uint32_t now = millis();

  switch (appState) {

    /* ---- ① 上电稳定等待（器件上电后需要一点时间才能收命令） ---- */
    case ST_BOOT_WAIT:
      if (!bootDrawn) {                       // 开机画面只画一次
        bootDrawn = true;
        if (displayOk) {
          dispDrawBoot();
        }
      }
      if (now - stateT0 >= AHT_POWER_ON_MS + BOOT_EXTRA_MS) {
        stateT0  = now;
        appState = ST_INIT_MPU;
      }
      break;

    /* ---- ② 初始化 MPU6050（只写寄存器，不需要等待） ---- */
    case ST_INIT_MPU:
      mpuOnline = mpuInitDevice();
      dispSetSensorState(mpuOnline, false);
      if (!mpuOnline) {
        mpuRetryMs = now + RETRY_INTERVAL_MS;
        statusLine("MPU6050: not found on 0x68/0x69 -> retry every 2s");
      }
      stateT0  = now;
      appState = ST_MPU_SETTLE;
      break;

    /* ---- ③ 等 MPU6050 内部稳定后再开始采样 ---- */
    case ST_MPU_SETTLE:
      if (now - stateT0 >= MPU_SETTLE_MS) {
        stateT0 = now;
#if CALIB_ENABLE
        attCalibBegin();                    // 开始"陀螺零偏 + 姿态零点"标定
        calibNextMs = now;
        calibPct    = 0;
        statusLine("CALIB  : keep the board STILL (gyro bias + level zero)");
        appState    = ST_CALIB;
#else
        appState    = ST_INIT_AHT;          // 不做标定：直接用重力绝对角
#endif
      }
      break;

    /* ---- ③.5 开机静置校准（非阻塞：每 50ms 采一个样本，时间到就结算） ----
     * 为什么放在这里：MPU6050 刚配置完、AHT30 还没开始跑，正好用这 1.2 秒采一批
     * 静止样本算出"陀螺零偏"和"姿态零点"。整个过程中主循环照常运转（无 delay），
     * 屏幕显示进度条；如果这期间传感器掉线，就直接跳过校准继续走。 */
    case ST_CALIB: {
      MpuData cd;

      if ((int32_t)(now - calibNextMs) >= 0) {
        calibNextMs = now + MPU_PERIOD_MS;   // 与正式解算同频（50ms）

        if (mpuOnline && mpuReadSample(&cd) && cd.ok) {
          attMapAxes(cd.ax, cd.ay, cd.az, cd.gx, cd.gy, cd.gz, &gBody);
          attCalibAccumulate(&gBody);
          mpuErrCnt = 0;
        } else if (++mpuErrCnt >= ERR_LIMIT) {
          mpuOnline  = false;
          mpuErrCnt  = 0;
          mpuRetryMs = now + RETRY_INTERVAL_MS;
          statusLine("MPU6050: lost during calibration -> skip calib, retry every 2s");
          dispSetSensorState(false, ahtOnline);
          stateT0  = now;
          appState = ST_INIT_AHT;
          break;
        }

        /* 进度条：只在百分比变化时重画 */
        uint8_t pct = (uint8_t)(((now - stateT0) * 100UL) / CALIB_MS);
        if (pct > 100) {
          pct = 100;
        }
        if (pct != calibPct) {
          calibPct = pct;
          if (displayOk) {
            dispDrawCalib(pct, attCalibSpanDps());
          }
        }
      }

      if (now - stateT0 >= CALIB_MS) {
        char cb[112], s1[12], s2[12], s3[12], s4[12], s5[12];
        bool still = attCalibFinish();

        fmtFixed(s1, sizeof(s1), (int32_t)lroundf(attCalibSpanDps()  * 100.0f), 2);
        fmtFixed(s2, sizeof(s2), (int32_t)lroundf(attBiasRollDps()   * 100.0f), 2);
        fmtFixed(s3, sizeof(s3), (int32_t)lroundf(attBiasPitchDps()  * 100.0f), 2);
        fmtFixed(s4, sizeof(s4), (int32_t)lroundf(attZeroPitch()     * 100.0f), 2);
        fmtFixed(s5, sizeof(s5), (int32_t)lroundf(attZeroRoll()      * 100.0f), 2);
        snprintf(cb, sizeof(cb), "CALIB  : done n=%u span=%sdps bias=%s/%s zero=%s/%s",
                 (unsigned)attCalibSamples(), s1, s2, s3, s4, s5);
        statusLine(cb);
        if (!still) {
          statusLine("CALIB  : warning - movement detected, bias/zero may be off (reboot to redo)");
        }

        if (displayOk) {
          dispDrawCalib(100, attCalibSpanDps());
        }

        lastImuUs = micros();
        stateT0   = now;
        appState  = ST_INIT_AHT;
      }
      break;
    }

    /* ---- ④ 检查 AHT30 状态字：bit4/bit3 都是 1 才算就绪 ---- */
    case ST_INIT_AHT: {
      uint8_t status = 0;
      char    buf[88];

      if (!aht30ReadStatus(&status)) {
        ahtOnline  = false;
        ahtRetryMs = now + RETRY_INTERVAL_MS;
        dispSetSensorState(mpuOnline, false);
        statusLine("AHT30  : not found on 0x38 -> retry every 2s");
        stateT0  = now;
        appState = ST_RUN;
      } else if ((status & AHT_STATUS_READY_MSK) == AHT_STATUS_READY_MSK) {
        snprintf(buf, sizeof(buf), "AHT30  : ok (status 0x%02X)", status);
        statusLine(buf);
        ahtOnline = true;
        dispSetSensorState(mpuOnline, true);
        stateT0   = now;
        appState  = ST_RUN;
      } else if (fixRounds < 1) {
        fixRounds++;
        snprintf(buf, sizeof(buf), "AHT30  : status 0x%02X not ready -> repairing cal regs", status);
        statusLine(buf);
        ahtNeedFix = true;
        fixIdx     = 0;
        fixStep    = 0;
        fixRegAddr = kAhtFixRegs[0];
        appState   = ST_AHT_FIX;
      } else {
        /* 修复过一轮仍不理想：不再纠缠，按"可用"继续（多数情况下数据依然有效） */
        snprintf(buf, sizeof(buf), "AHT30  : status 0x%02X still not ready -> continue anyway", status);
        statusLine(buf);
        ahtOnline = true;
        stateT0   = now;
        appState  = ST_RUN;
      }
      break;
    }

    /* ---- ⑤ AHT30 校准寄存器修复：每次 loop 只推进一步，绝不阻塞 ---- */
    case ST_AHT_FIX:
      if (aht30FixRun()) {
        ahtNeedFix = false;
        stateT0    = millis();
        appState   = ST_INIT_AHT;   // 修完再复查一次状态字（由 fixRounds 兜底，不会死循环）
      }
      break;

    /* ---- ⑦ 正常运行：各任务互不阻塞 ---- */
    case ST_RUN:
      pollSerialCommands(now); // 串口命令：d=自检画面 m=换方向 r=换旋转 b/B=亮度 c=重新校准
      taskAttitude20Hz(now);   // MPU6050：每 50ms 读 + 解算 + 串口输出（20Hz）
      taskTempHumi1Hz(now);    // AHT30  ：每 1000ms 触发 + 90ms 后读取（1Hz）
      taskDisplay20Fps(now);   // 屏幕   ：每 50ms 重绘姿态层（20FPS）或自检画面
      taskRetry(now);          // 掉线重试：每 2s
      printFpsLine(now);       // 帧率提示：每 1s 一行（#FPS）
      printAxesLine(now);      // 轴向核对：每 1s 一行（#Axes）
      if (ahtNeedFix) {        // 掉线重连后若发现未就绪，继续分步修复
        if (aht30FixRun()) {
          ahtNeedFix = false;
        }
      }
      break;

    /* ---- 兜底：回到上电等待 ---- */
    default:
      appState = ST_BOOT_WAIT;
      stateT0  = now;
      break;
  }
}

/* ========================= 8. 函数实现 ========================= */

/* ---------- 8.1 串口与格式化 ---------- */

/* 初始化串口：同时打开两条通路，保证插哪个 USB 口都能看到数据
 *   A) UART0 (GPIO43/44)：板上 USB 转串口芯片那一路，始终可用
 *   B) USB CDC（原生 USB）：需要编译宏 ARDUINO_USB_CDC_ON_BOOT=1
 *      （Arduino IDE 里是【工具 → USB CDC On Boot → Enabled】） */
void initSerial(void) {
  Serial.begin(SERIAL_BAUD);          // 波特率 115200，8 数据位、无校验、1 停止位
#if ARDUINO_USB_CDC_ON_BOOT
  Serial0.begin(SERIAL_BAUD);         // 再显式打开 UART0
#endif

  /* 等待串口就绪：USB CDC 在电脑打开串口前不会"连接"，最多等 1500ms，
   * 超时也继续跑（只走 UART0 的场景不会被卡住）。
   * 这里用 millis() + yield() 轮询，不用 delay()。 */
  unsigned long t0 = millis();
  while (!Serial && (millis() - t0 < 1500)) {
    yield();
  }
}

/* 输出一行（同时写 USB CDC 与 UART0） */
void outLine(const char *text) {
  Serial.println(text);
#if ARDUINO_USB_CDC_ON_BOOT
  Serial0.println(text);
#endif
}

/* 输出一行"状态提示"：自动加 # 前缀
 * 约定：以 # 开头的行不是数据，上位机可以放心忽略（本工程的网页仪表盘就是这么做的） */
void statusLine(const char *text) {
  char buf[96];
  snprintf(buf, sizeof(buf), "#%s", text);
  outLine(buf);
}

/* 把"放大 10^decimals 倍的整数"格式化成定点小数字符串
 * 例：fmtFixed(buf, n, -1234, 2) → "-12.34"
 * 说明：不用 printf 的 %f，而是先放大成整数再自己插小数点，
 *       这样无论核心/编译器对浮点 printf 的支持如何，小数位数都稳定可控。 */
void fmtFixed(char *dst, size_t size, int32_t scaled, uint8_t decimals) {
  int32_t div = 1;
  for (uint8_t i = 0; i < decimals; i++) {
    div *= 10;
  }
  bool        neg   = (scaled < 0);
  int32_t     absV  = neg ? -scaled : scaled;
  int32_t     whole = absV / div;
  int32_t     frac  = absV % div;
  const char *sign  = neg ? "-" : "";

  if (decimals == 0) {
    snprintf(dst, size, "%s%ld", sign, (long)whole);
  } else if (decimals == 1) {
    snprintf(dst, size, "%s%ld.%01ld", sign, (long)whole, (long)frac);
  } else if (decimals == 2) {
    snprintf(dst, size, "%s%ld.%02ld", sign, (long)whole, (long)frac);
  } else {
    snprintf(dst, size, "%s%ld.%03ld", sign, (long)whole, (long)frac);
  }
}

/* ---------- 8.2 I2C 基础操作（AHT30 与 MPU6050 共用） ---------- */

/* 初始化 I2C：SDA=GPIO8 / SCL=GPIO9 / 400kHz，并把单次事务超时设为 50ms
 * 超时的作用：传感器没插、或者总线被拉死时，读写会很快失败返回，
 * 而不是无限等待把主循环卡住。 */
void initI2C(void) {
  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL, (uint32_t)I2C_CLOCK_HZ);
  Wire.setTimeOut(I2C_TIMEOUT_MS);

  char buf[96];
  snprintf(buf, sizeof(buf), "I2C    : ready (SDA=GPIO%d SCL=GPIO%d %luHz timeout=%dms)",
           (int)PIN_I2C_SDA, (int)PIN_I2C_SCL, (unsigned long)I2C_CLOCK_HZ, (int)I2C_TIMEOUT_MS);
  statusLine(buf);
}

/* 写原始字节流，成功（收到 ACK）返回 true */
bool i2cWriteCmd(uint8_t addr, const uint8_t *buf, uint8_t len) {
  Wire.beginTransmission(addr);
  for (uint8_t i = 0; i < len; i++) {
    Wire.write(buf[i]);
  }
  return (Wire.endTransmission() == 0);
}

/* 读原始字节流，长度不足返回 false */
bool i2cReadBytes(uint8_t addr, uint8_t *buf, uint8_t len) {
  if (Wire.requestFrom((uint8_t)addr, (uint8_t)len) != len) {
    return false;
  }
  for (uint8_t i = 0; i < len; i++) {
    buf[i] = (uint8_t)Wire.read();
  }
  return true;
}

/* 写一个寄存器（寄存器地址 + 1 字节数据） */
bool i2cWriteReg(uint8_t addr, uint8_t reg, uint8_t value) {
  Wire.beginTransmission(addr);
  Wire.write(reg);
  Wire.write(value);
  return (Wire.endTransmission() == 0);
}

/* 从指定寄存器开始连读 len 字节（先写寄存器指针，再用重复起始条件转读） */
bool i2cReadRegs(uint8_t addr, uint8_t reg, uint8_t *buf, uint8_t len) {
  Wire.beginTransmission(addr);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) {   // false = 不发停止位，紧接着读
    return false;
  }
  return i2cReadBytes(addr, buf, len);
}

/* ---------- 8.3 AHT30 温湿度模块（地址 0x38） ---------- */

/* 读状态字（1 字节）。它同时也是 7 字节数据帧的第 1 个字节 */
bool aht30ReadStatus(uint8_t *status) {
  return i2cReadBytes(AHT30_ADDR, status, 1);
}

/* 触发一次测量：0xAC 0x33 0x00（发完要等约 80~90ms 才能取数据） */
bool aht30TriggerMeasure(void) {
  const uint8_t cmd[3] = {AHT_CMD_MEASURE_0, AHT_CMD_MEASURE_1, AHT_CMD_MEASURE_2};
  return i2cWriteCmd(AHT30_ADDR, cmd, 3);
}

/* CRC8：多项式 0x31、初值 0xFF（与奥松官方驱动一致） */
uint8_t aht30Crc8(const uint8_t *data, uint8_t len) {
  uint8_t crc = 0xFF;
  for (uint8_t i = 0; i < len; i++) {
    crc ^= data[i];
    for (uint8_t bit = 0; bit < 8; bit++) {
      crc = (crc & 0x80) ? (uint8_t)((crc << 1) ^ 0x31) : (uint8_t)(crc << 1);
    }
  }
  return crc;
}

/* 读取 7 字节数据帧并解析温湿度
 * ---------------------------------------------------------------------------
 * 帧格式（AHT30 数据手册）：
 *   buf[0]    状态字：bit7=忙  bit4=CRC 标志  bit3=校准使能
 *   buf[1..3] 湿度原始值 20 位：rawH = ((buf1<<16) | (buf2<<8) | buf3) >> 4
 *   buf[3..5] 温度原始值 20 位：rawT = ((buf3<<16) | (buf4<<8) | buf5) & 0xFFFFF
 *             ★ buf[3] 被两个量共用：高 4 位属于湿度，低 4 位属于温度
 *   buf[6]    CRC8：对 buf[0..5] 计算，多项式 0x31、初值 0xFF
 * 换算（2^20 = 1048576）：
 *   温度(℃)   = rawT / 1048576 * 200 - 50
 *   湿度(%RH) = rawH / 1048576 * 100
 * 返回：AHT_READ_OK / AHT_READ_I2CERR / AHT_READ_BUSY / AHT_READ_CRCERR
 * ------------------------------------------------------------------------- */
uint8_t aht30ReadFrame(AhtData *out) {
  uint8_t buf[7] = {0};
  uint32_t rawH, rawT;

  out->ok    = false;
  out->crcOk = false;

  if (!i2cReadBytes(AHT30_ADDR, buf, 7)) {
    return AHT_READ_I2CERR;
  }

  out->status = buf[0];
  out->crcOk  = (aht30Crc8(buf, 6) == buf[6]);

  if (buf[0] & AHT_STATUS_BUSY) {
    return AHT_READ_BUSY;           // 转换还没完成
  }
  if (!out->crcOk) {
    return AHT_READ_CRCERR;         // 传输出错，这一帧丢弃
  }

  rawH  = (((uint32_t)buf[1] << 16) | ((uint32_t)buf[2] << 8) | (uint32_t)buf[3]) >> 4;
  rawT  = ((uint32_t)buf[3] << 16) | ((uint32_t)buf[4] << 8) | (uint32_t)buf[5];
  rawT &= 0xFFFFF;                  // 只保留低 20 位

  out->rh = (float)rawH / 1048576.0f * 100.0f;
  out->t  = (float)rawT / 1048576.0f * 200.0f - 50.0f;
  out->ok = true;
  return AHT_READ_OK;
}

/* 校准寄存器修复（奥松官方驱动里的序列，用于状态字 bit4/bit3 没置位的情况）
 * ---------------------------------------------------------------------------
 * 对 0x1B / 0x1C / 0x1E 三个寄存器各做一遍：
 *   步骤 0：写 [寄存器地址, 0x00, 0x00]
 *   步骤 1：等 5ms，回读 3 字节
 *   步骤 2：等 10ms，写回 [0xB0|寄存器地址, 回读值1, 回读值2] → 处理下一个
 * ★ 本函数每次调用只推进一步，靠 millis() 判断"时间到了吗"，
 *   绝不会停在那里等，因此放在主循环里也不会影响 100ms 的采样节奏。
 * 返回 true 表示三个寄存器都处理完了。
 * ------------------------------------------------------------------------- */
bool aht30FixRun(void) {
  uint32_t now = millis();

  switch (fixStep) {
    case 0: {
      const uint8_t cmd[3] = {fixRegAddr, 0x00, 0x00};
      i2cWriteCmd(AHT30_ADDR, cmd, 3);
      fixStep = 1;
      fixT0   = now;
      break;
    }

    case 1:
      if (now - fixT0 >= 5) {
        if (!i2cReadBytes(AHT30_ADDR, fixRegs, 3)) {   // 回读失败按 0 处理
          fixRegs[0] = 0;
          fixRegs[1] = 0;
          fixRegs[2] = 0;
        }
        fixStep = 2;
        fixT0   = now;
      }
      break;

    case 2:
      if (now - fixT0 >= 10) {
        const uint8_t cmd[3] = {(uint8_t)(0xB0 | fixRegAddr), fixRegs[1], fixRegs[2]};
        i2cWriteCmd(AHT30_ADDR, cmd, 3);
        fixIdx++;
        if (fixIdx < 3) {
          fixRegAddr = kAhtFixRegs[fixIdx];            // 继续下一个寄存器
          fixStep    = 0;
        } else {
          return true;                                 // 三个都处理完
        }
      }
      break;

    default:
      fixStep = 0;
      break;
  }
  return false;
}

/* ---------- 8.4 MPU6050 六轴模块（地址 0x68 / 0x69） ---------- */

/* 检测 + 配置 MPU6050，返回 true 表示在线且配置写好了
 * 注意：本函数只写寄存器、不做任何等待（"内部稳定等待"由状态机 ST_MPU_SETTLE 负责） */
bool mpuInitDevice(void) {
  uint8_t who = 0;
  char    buf[88];

  mpuAddr = MPU6050_ADDR;                                        // 先试 0x68
  if (!i2cReadRegs(mpuAddr, MPU_REG_WHO_AM_I, &who, 1)) {
    mpuAddr = MPU6050_ADDR_ALT;                                  // 再试 0x69
    if (!i2cReadRegs(mpuAddr, MPU_REG_WHO_AM_I, &who, 1)) {
      return false;                                              // 两个地址都不应答
    }
  }
  mpuWho = who;

  snprintf(buf, sizeof(buf), "MPU6050: ok (addr 0x%02X WHO_AM_I=0x%02X)", mpuAddr, who);
  statusLine(buf);
  /* WHO_AM_I 正常是 0x68；有些兼容芯片（MPU6500/9250 等）为 0x70/0x71/0x73，
   * 寄存器与数据格式兼容，所以只提示、不判失败 */
  if (who != 0x68) {
    statusLine("MPU6050: WHO_AM_I != 0x68 (compatible chip?) -> continue anyway");
  }

  i2cWriteReg(mpuAddr, MPU_REG_PWR_MGMT_1, 0x01);                // 解除休眠 + 时钟源=X轴陀螺PLL
  i2cWriteReg(mpuAddr, MPU_REG_SMPLRT_DIV, 0x09);                // 内部采样率 1000/(1+9)=100Hz
  i2cWriteReg(mpuAddr, MPU_REG_CONFIG, 0x03);                    // DLPF：加速度44Hz/陀螺42Hz
  i2cWriteReg(mpuAddr, MPU_REG_ACCEL_CFG, (uint8_t)(MPU_ACCEL_FS_SEL << 3));  // 加速度量程
  i2cWriteReg(mpuAddr, MPU_REG_GYRO_CFG, (uint8_t)(MPU_GYRO_FS_SEL << 3));    // 陀螺量程
  return true;
}

/* 读 14 字节数据区并换算成物理单位
 * ---------------------------------------------------------------------------
 *   0x3B~0x40：加速度 X/Y/Z（大端有符号 16 位）
 *   0x41~0x42：芯片温度
 *   0x43~0x48：角速度 X/Y/Z（大端有符号 16 位）
 * 换算：
 *   加速度(g)   = 原始值 / MPU_ACCEL_LSB_PER_G    （±2g 时 16384 LSB/g）
 *   角速度(°/s) = 原始值 / MPU_GYRO_LSB_PER_DPS   （±250°/s 时 131.0 LSB/(°/s)）
 *   芯片温度(℃) = 原始值 / 340 + 36.53
 * ------------------------------------------------------------------------- */
bool mpuReadSample(MpuData *out) {
  uint8_t raw[14] = {0};
  int16_t ax, ay, az, temp, gx, gy, gz;

  out->ok = false;
  if (!i2cReadRegs(mpuAddr, MPU_REG_DATA, raw, 14)) {
    return false;
  }

  ax   = (int16_t)(((uint16_t)raw[0] << 8) | raw[1]);
  ay   = (int16_t)(((uint16_t)raw[2] << 8) | raw[3]);
  az   = (int16_t)(((uint16_t)raw[4] << 8) | raw[5]);
  temp = (int16_t)(((uint16_t)raw[6] << 8) | raw[7]);
  gx   = (int16_t)(((uint16_t)raw[8] << 8) | raw[9]);
  gy   = (int16_t)(((uint16_t)raw[10] << 8) | raw[11]);
  gz   = (int16_t)(((uint16_t)raw[12] << 8) | raw[13]);

  out->ax    = (float)ax / MPU_ACCEL_LSB_PER_G;
  out->ay    = (float)ay / MPU_ACCEL_LSB_PER_G;
  out->az    = (float)az / MPU_ACCEL_LSB_PER_G;
  out->gx    = (float)gx / MPU_GYRO_LSB_PER_DPS;
  out->gy    = (float)gy / MPU_GYRO_LSB_PER_DPS;
  out->gz    = (float)gz / MPU_GYRO_LSB_PER_DPS;
  out->tchip = (float)temp / 340.0f + 36.53f;
  out->ok    = true;
  return true;
}

/* ---------- 8.5 输出：严格按约定格式打印 ---------- */

/* MPU6050 数据行：MPU,<millis>,ax,ay,az,gx,gy,gz
 * 小数位：加速度 3 位、角速度 2 位 */
void printMpuLine(const MpuData *d, uint32_t ms) {
  char ax[12], ay[12], az[12], gx[12], gy[12], gz[12], line[96];

  fmtFixed(ax, sizeof(ax), (int32_t)lroundf(d->ax * 1000.0f), 3);
  fmtFixed(ay, sizeof(ay), (int32_t)lroundf(d->ay * 1000.0f), 3);
  fmtFixed(az, sizeof(az), (int32_t)lroundf(d->az * 1000.0f), 3);
  fmtFixed(gx, sizeof(gx), (int32_t)lroundf(d->gx * 100.0f), 2);
  fmtFixed(gy, sizeof(gy), (int32_t)lroundf(d->gy * 100.0f), 2);
  fmtFixed(gz, sizeof(gz), (int32_t)lroundf(d->gz * 100.0f), 2);

  snprintf(line, sizeof(line), "MPU,%lu,%s,%s,%s,%s,%s,%s",
           (unsigned long)ms, ax, ay, az, gx, gy, gz);
  outLine(line);
  mpuCount++;
}

/* AHT30 数据行：AHT,<millis>,temperature,humidity（均 2 位小数） */
void printAhtLine(const AhtData *d, uint32_t ms) {
  char t[12], rh[12], line[64];

  fmtFixed(t,  sizeof(t),  (int32_t)lroundf(d->t * 100.0f),  2);
  fmtFixed(rh, sizeof(rh), (int32_t)lroundf(d->rh * 100.0f), 2);

  snprintf(line, sizeof(line), "AHT,%lu,%s,%s", (unsigned long)ms, t, rh);
  outLine(line);
  ahtCount++;
}

/* 姿态行（20Hz）：格式由 app_config.h 的 ATT_LINE_STYLE 决定
 *   0 = CSV       ：ATT,<ms>,pitch,roll      （与 MPU,/AHT, 同风格，便于脚本解析）
 *   1 = 人类可读  ：Pitch: 12.3, Roll: -4.5  （默认，肉眼在串口监视器里最直观）
 *   2 = 两种都发
 * 说明：这里输出的是"显示角"（已扣开机零点、已做显示低通），与屏幕上看到的一致。 */
void printAttLine(uint32_t ms, float pitch, float roll) {
  char p[12], r[12], line[80];

  fmtFixed(p, sizeof(p), (int32_t)lroundf(pitch * 10.0f), 1);
  fmtFixed(r, sizeof(r), (int32_t)lroundf(roll  * 10.0f), 1);

#if (ATT_LINE_STYLE == 0) || (ATT_LINE_STYLE == 2)
  snprintf(line, sizeof(line), "ATT,%lu,%s,%s", (unsigned long)ms, p, r);
  outLine(line);
#endif
#if (ATT_LINE_STYLE == 1) || (ATT_LINE_STYLE == 2)
  snprintf(line, sizeof(line), "Pitch: %s, Roll: %s", p, r);
  outLine(line);
#endif
}

/* 人类可读温湿度行（1Hz）：Temp: 25.3 C, Humi: 61.2 %
 * 用 %s 拼接定点字符串（不用 %f），保证小数位数稳定可控 */
void printEnvHumanLine(uint32_t ms, float t, float rh) {
  char tb[12], rb[12], line[80];

  (void)ms;                                    // 该行按要求不带时间戳
  fmtFixed(tb, sizeof(tb), (int32_t)lroundf(t  * 10.0f), 1);
  fmtFixed(rb, sizeof(rb), (int32_t)lroundf(rh * 10.0f), 1);
  snprintf(line, sizeof(line), "Temp: %s C, Humi: %s %%", tb, rb);
  outLine(line);
}

/* 帧率提示行（1Hz，'#' 开头属状态行，网页仪表盘会忽略）：
 *   例：#FPS   : 19.8/20  frame=31.4ms  slow=0  heap=180KB  n=1234
 *   frame = 最近一帧「绘制 + 推送」耗时；slow = 超过 UI_TASK_LIMIT_MS 的帧数；
 *   heap = 空闲内存（Sprite 占用 115KB，可用来确认内存是否紧张） */
void printFpsLine(uint32_t now) {
#if FPS_LINE_ENABLE
  static uint32_t nextMs = 0;
  char s1[12], s2[12], line[112];

  if ((int32_t)(now - nextMs) < 0) {
    return;
  }
  nextMs += FPS_REPORT_MS;
  if ((int32_t)(now - nextMs) > 0) {
    nextMs = now + FPS_REPORT_MS;
  }

  fmtFixed(s1, sizeof(s1), (int32_t)lroundf(dispFps() * 10.0f), 1);
  fmtFixed(s2, sizeof(s2), (int32_t)lroundf((float)dispLastFrameUs() / 1000.0f), 1);
  snprintf(line, sizeof(line), "#FPS   : %s/%d  frame=%sms  slow=%u  heap=%uKB  n=%lu",
           s1, (int)(1000UL / DISP_PERIOD_MS), s2,
           (unsigned)dispSlowFrames(), (unsigned)(dispFreeHeap() / 1024UL),
           (unsigned long)imuSamples);
  statusLine(line);
#else
  (void)now;
#endif
}

/* 启动横幅（纯 ASCII，避免个别串口工具把中文显示成乱码；
 * 以 # 开头的行都是状态提示，不是数据） */
void printBanner(void) {
  outLine("");
  statusLine("============= esp-0920 aht30 + mpu6050 + st7789 =============");
  statusLine("Board  : ESP32-S3-DevKitC-1 (Arduino ESP32 core)");
  statusLine("Bus    : I2C SDA=GPIO8 SCL=GPIO9 400kHz (AHT30 0x38 + MPU6050 0x68)");
  statusLine("LCD    : ST7789 240x320 SPI  SCLK=21 MOSI=47 CS=41 DC=40 RST=45 BL=42");
  statusLine("Data   : MPU,<ms>,ax,ay,az,gx,gy,gz    every 50ms   (20Hz)");
  statusLine("         AHT,<ms>,temperature,humidity every 1000ms (1Hz)");
  statusLine("         ATT / Pitch: , Roll:          every 50ms   (20Hz)");
  statusLine("Note   : lines starting with '#' are status, not data");
  statusLine("Library: TFT_eSPI 2.5.43 (AHT30/MPU6050 use core Wire.h only)");
  statusLine("------------------------------------------------------------");
}

/* 打印静态配置（周期/滤波/安装方向等），便于一眼核对参数 */
void printSensorState(void) {
  char buf[120];

  snprintf(buf, sizeof(buf),
           "Config : MPU period=%lums (%luHz)  AHT period=%lums wait=%lums  disp=%lums (%luFPS)",
           (unsigned long)MPU_PERIOD_MS, (unsigned long)(1000UL / MPU_PERIOD_MS),
           (unsigned long)AHT_PERIOD_MS, (unsigned long)AHT_WAIT_MS,
           (unsigned long)DISP_PERIOD_MS, (unsigned long)(1000UL / DISP_PERIOD_MS));
  statusLine(buf);

  snprintf(buf, sizeof(buf), "Limits : i2c timeout=%dms  offline retry=%lums  err limit=%d",
           (int)I2C_TIMEOUT_MS, (unsigned long)RETRY_INTERVAL_MS, (int)ERR_LIMIT);
  statusLine(buf);

  snprintf(buf, sizeof(buf), "Filter : complementary tau=%dms  display lpf tau=%dms  calib=%s %lums levelzero=%d",
           (int)(CF_TAU_S * 1000.0f), (int)(DISP_TAU_S * 1000.0f),
           CALIB_ENABLE ? "on" : "off", (unsigned long)CALIB_MS, (int)CALIB_LEVEL_ZERO);
  statusLine(buf);

  snprintf(buf, sizeof(buf), "Mount  : %s  chipup=%d  flipP=%d  flipR=%d  line style=%d",
           attMountName(attGetMount()), (int)attGetChipUp(),
           (int)IMU_FLIP_PITCH, (int)IMU_FLIP_ROLL, (int)ATT_LINE_STYLE);
  statusLine(buf);
}

/* 运行期引脚自检：把"实际编译进固件"的引脚打印出来，并提示三个已知的坑。
 * app_config.h 里已经做了编译期 #error/#warning 检查，这里是给现场排错用的。 */
void cfgPinRuntimeCheck(void) {
  char buf[120];

  cfgStatusLine("PinChk : I2C SDA=GPIO8 SCL=GPIO9  |  LCD SCLK=21 MOSI=47 CS=41 DC=40 RST=45 BL=42");
  cfgStatusLine("PinChk : no conflict: LCD SCLK(GPIO21) != I2C pins (I2C uses GPIO8/9)");

#if (TFT_RST == 45) || (TFT_DC == 45) || (TFT_CS == 45) || (TFT_SCLK == 45) || (TFT_MOSI == 45) || (PIN_LCD_BLK == 45)
  cfgStatusLine("PinChk : NOTE GPIO45 = ESP32-S3 strapping pin (VDD_SPI select)");
  cfgStatusLine("PinChk :   if board fails to boot: add 10k pull-down on GPIO45 or move to GPIO38");
#endif
#if (TFT_RST >= 40 && TFT_RST <= 42) || (TFT_DC >= 40 && TFT_DC <= 42) || (TFT_CS >= 40 && TFT_CS <= 42) || (PIN_LCD_BLK >= 40 && PIN_LCD_BLK <= 42)
  cfgStatusLine("PinChk : NOTE GPIO40/41/42 = S3 JTAG pins: GPIO use is OK,");
  cfgStatusLine("PinChk :   but an external JTAG debugger can no longer use them");
#endif

  snprintf(buf, sizeof(buf), "PinChk : TFT_SCLK=%d TFT_MOSI=%d TFT_CS=%d TFT_DC=%d TFT_RST=%d TFT_BL=%d",
           (int)TFT_SCLK, (int)TFT_MOSI, (int)TFT_CS, (int)TFT_DC, (int)TFT_RST, (int)TFT_BL);
  cfgStatusLine(buf);
}

/* ---------- 8.6 运行调度：互不阻塞的任务 ---------- */

/* taskAttitude20Hz()：每 MPU_PERIOD_MS(50ms) = 20Hz
 * ---------------------------------------------------------------------------
 * 一次做完四件事（"读→解算→串口"一条线，屏幕刷新由 taskDisplay20Fps 负责）：
 *   ① mpuReadSample()  读 14 字节（加速度 + 温度 + 陀螺）
 *   ② attMapAxes()     安装方向映射（传感器轴 → 机体"前/右/下"）
 *   ③ attUpdate()      互补滤波解算 pitch/roll；attFilterDisplay() 再做显示低通
 *   ④ printMpuLine() + printAttLine()  输出 MPU, 行（网页仪表盘用）与姿态行
 *
 * 时间判断写成 (int32_t)(now - next) >= 0，这样即使 millis() 回绕也不会出错。
 * 周期用"累加"推进（长期更准），但若发现已经落后超过一个周期（刚初始化、
 * 或主循环被屏幕刷新短暂占用），就重新对齐到当前时刻，避免"连续补采样"的爆发。
 *
 * dt（积分间隔）用 micros() 实测差计算：屏幕推送会带来几毫秒抖动，
 * 用实测 dt 代替固定 50ms，互补滤波与低通的结果依然稳定。
 * ------------------------------------------------------------------------- */
void taskAttitude20Hz(uint32_t now) {
  MpuData d;

  if (!mpuOnline) {
    return;                                   // 掉线时不读，交给 taskRetry 重试
  }
  if ((int32_t)(now - mpuNextMs) < 0) {
    return;                                   // 还没到 50ms
  }

  mpuNextMs += MPU_PERIOD_MS;
  if ((int32_t)(now - mpuNextMs) > 0) {
    mpuNextMs = now + MPU_PERIOD_MS;          // 落后太多 → 重新对齐
  }

  if (mpuReadSample(&d) && d.ok) {
    /* ---- ① 实测 dt（秒）---- */
    const uint32_t nowUs = micros();
    float dt = (float)(nowUs - lastImuUs) / 1000000.0f;
    lastImuUs = nowUs;
    if (dt <= 0.0f || dt > 0.5f) {            // 首次/回绕/被长时间阻塞 → 退回理论周期
      dt = (float)MPU_PERIOD_MS / 1000.0f;
    }

    /* ---- ②③ 映射 + 互补滤波 + 显示低通 ---- */
    attMapAxes(d.ax, d.ay, d.az, d.gx, d.gy, d.gz, &gBody);
    attUpdate(&gBody, dt);
    attFilterDisplay(dt);
    imuSamples++;

    /* ---- ④ 串口：MPU 原始行（20Hz）+ 姿态行（20Hz）---- */
    printMpuLine(&d, millis());

    lastMpu   = d;                            // 供自检画面 / #Axes 行使用
    lastMpuOk = true;

    if ((int32_t)(now - nextAttMs) >= 0) {
      nextAttMs += ATT_PERIOD_MS;
      if ((int32_t)(now - nextAttMs) > 0) {
        nextAttMs = now + ATT_PERIOD_MS;
      }
      printAttLine(millis(), attPitchDisp(), attRollDisp());
    }

    mpuErrCnt = 0;
  } else if (++mpuErrCnt >= ERR_LIMIT) {
    mpuOnline  = false;
    mpuErrCnt  = 0;
    mpuRetryMs = now + RETRY_INTERVAL_MS;
    attReset();                              // 恢复后重新用加速度计初始化滤波
    dispSetSensorState(false, ahtOnline);
    statusLine("MPU6050: read failed -> offline, retry every 2s");
  }
}

/* taskDisplay20Fps()：每 DISP_PERIOD_MS(50ms) 重绘姿态层 = 20FPS
 * ---------------------------------------------------------------------------
 * 只负责"画一帧"：姿态角由 taskAttitude20Hz 算好后存在 attitude 模块里，
 * 这里读出来画到 Sprite 再一次推送（无闪烁）。若 Sprite 分配失败，
 * display 模块会自动降级为直接绘制（见 display_st7789.cpp）。
 * ------------------------------------------------------------------------- */
void taskDisplay20Fps(uint32_t now) {
  if (!displayOk) {
    return;
  }
  if ((int32_t)(now - nextDispMs) < 0) {
    return;                                   // 还没到 50ms
  }

  nextDispMs += DISP_PERIOD_MS;
  if ((int32_t)(now - nextDispMs) > 0) {
    nextDispMs = now + DISP_PERIOD_MS;        // 落后太多 → 重新对齐
  }

  if (diagMode) {
    /* "方向 / 轴向自检"画面：同时给出原始轴、机体轴、角度与当前安装方向 */
    dispDrawDiag(attMountName(attGetMount()), attGetChipUp(),
                 lastMpu.ax, lastMpu.ay, lastMpu.az,
                 gBody.fwd, gBody.right, -gBody.down,     // 机体的"上" = -down
                 attPitch(), attRoll());
    return;
  }

  dispDrawAttitude(attPitchDisp(), attRollDisp());
}

/* taskTempHumi1Hz()：每 AHT_PERIOD_MS(1000ms) 触发一次，等 AHT_WAIT_MS(90ms) 后读取
 * ---------------------------------------------------------------------------
 * 关键点：90ms 的转换等待**不在原地等**，而是记下触发时刻 ahtTrigMs，
 * 下次进 loop 时再判断"90ms 到了吗"。这样这 90ms 里主循环照常完成
 * MPU6050 的 50ms 采样与 20FPS 刷屏，几个任务互不干扰（这就是"非阻塞"的落地方式）。
 *
 * 读到有效数据后做两件事：
 *   · 串口：AHT,<ms>,t,rh（保留原有 CSV 行）+ 可选 "Temp: .. C, Humi: .. %"
 *   · 屏幕：刷新底部温湿度区（display 模块内部会判断"数值没变就不重绘"，
 *           所以这里 1Hz 调用即可，既满足"每秒更新一次"又不会闪）
 * ------------------------------------------------------------------------- */
void taskTempHumi1Hz(uint32_t now) {
  AhtData d;
  uint8_t r;

  if (!ahtOnline) {
    return;
  }

  /* ---- 阶段 2：转换完成 → 读取 → 输出 ---- */
  if (ahtWaiting) {
    if (now - ahtTrigMs < AHT_WAIT_MS) {
      return;                                 // 还没到 90ms，先让主循环去干别的
    }
    ahtWaiting = false;
    r = aht30ReadFrame(&d);

    if (r == AHT_READ_OK) {
      ahtErrCnt = 0;
      printAhtLine(&d, millis());                 // AHT,<ms>,temperature,humidity（保留原格式）
#if AHT_LINE_HUMAN
      printEnvHumanLine(millis(), d.t, d.rh);     // 人类可读行（可关闭）
#endif
      if (displayOk) {
        dispDrawEnv(d.t, d.rh, true);             // 屏幕底部温湿度区（数值变化才重绘）
      }
      dispSetSensorState(mpuOnline, true);
    } else {
      if (r == AHT_READ_CRCERR) {
        statusLine("AHT30  : crc error -> skip this frame");
      } else if (r == AHT_READ_BUSY) {
        statusLine("AHT30  : still busy -> skip this frame");
      }
      /* "忙"只是转换慢了，不算通信故障；其它情况才计入掉线计数 */
      if (r != AHT_READ_BUSY && ++ahtErrCnt >= ERR_LIMIT) {
        ahtOnline  = false;
        ahtErrCnt  = 0;
        ahtRetryMs = now + RETRY_INTERVAL_MS;
        dispSetSensorState(mpuOnline, false);
        if (displayOk) {
          dispDrawEnv(0.0f, 0.0f, false);         // 屏幕改显示 "--.-" 并标红
        }
        statusLine("AHT30  : read failed -> offline, retry every 2s");
      }
    }
    return;
  }

  /* ---- 阶段 1：到 1 秒了 → 触发一次测量 ---- */
  if ((int32_t)(now - ahtNextMs) < 0) {
    return;
  }
  ahtNextMs += AHT_PERIOD_MS;
  if ((int32_t)(now - ahtNextMs) > 0) {
    ahtNextMs = now + AHT_PERIOD_MS;
  }

  if (aht30TriggerMeasure()) {
    ahtWaiting = true;
    ahtTrigMs  = now;
    ahtErrCnt  = 0;
  } else if (++ahtErrCnt >= ERR_LIMIT) {
    ahtOnline  = false;
    ahtErrCnt  = 0;
    ahtRetryMs = now + RETRY_INTERVAL_MS;
    dispSetSensorState(mpuOnline, false);
    if (displayOk) {
      dispDrawEnv(0.0f, 0.0f, false);
    }
    statusLine("AHT30  : trigger failed -> offline, retry every 2s");
  }
}

/* 掉线重试：每 RETRY_INTERVAL_MS(2s) 试一次
 *   MPU6050：重新检测 WHO_AM_I + 重写配置
 *   AHT30  ：重新读状态字；就绪则恢复输出，未就绪则安排一次校准寄存器修复
 * 说明：重试期间另一个传感器完全不受影响，两边各自独立。 */
void taskRetry(uint32_t now) {
  char buf[80];

  /* ---- MPU6050 重试 ---- */
  if (!mpuOnline && (int32_t)(now - mpuRetryMs) >= 0) {
    mpuRetryMs = now + RETRY_INTERVAL_MS;
    if (mpuInitDevice()) {
      mpuOnline = true;
      mpuErrCnt = 0;
      mpuNextMs = now;                        // 立刻开始新一轮采样（20Hz）
      attReset();                             // 重新用加速度计初始化滤波，避免角度跳变
      lastImuUs = micros();
      dispSetSensorState(true, ahtOnline);
      statusLine("MPU6050: recovered -> resume 20Hz sampling (50ms)");
    }
  }

  /* ---- AHT30 重试 ---- */
  if (!ahtOnline && (int32_t)(now - ahtRetryMs) >= 0) {
    uint8_t st = 0;
    ahtRetryMs = now + RETRY_INTERVAL_MS;

    if (aht30ReadStatus(&st)) {
      ahtOnline  = true;
      ahtErrCnt  = 0;
      ahtWaiting = false;
      ahtNextMs  = now;                       // 立刻触发第一次测量
      dispSetSensorState(mpuOnline, true);
      snprintf(buf, sizeof(buf), "AHT30  : recovered (status 0x%02X)", st);
      statusLine(buf);
      if ((st & AHT_STATUS_READY_MSK) != AHT_STATUS_READY_MSK) {
        /* 未就绪：交给 aht30FixRun() 分步修复（每次 loop 只推进一步） */
        fixIdx     = 0;
        fixStep    = 0;
        fixRegAddr = kAhtFixRegs[0];
        ahtNeedFix = true;
      }
    }
  }
}

/* ---------- 8.7 排错与交互：轴向核对行 / 串口命令 ---------- */

/* printAxesLine()：每秒两行"轴向核对"信息（以 # 开头，属状态行，网页会忽略）
 * 用途：判断"安装方向"对不对。正确判据：
 *   · 把板子向右滚（右侧压低）→ ROLL 应向正方向变大；
 *   · 把机头（屏幕上方）抬高   → PITCH 应向正方向变大。
 * 若"左右摆动却显示上下"，就用串口敲 'm' 循环安装方向，直到上面的判据成立。 */
void printAxesLine(uint32_t now) {
  static uint32_t nextMs = 0;
  char r1[12], r2[12], r3[12], r4[12], r5[12], r6[12], p[12], rl[12], line[120];

  if ((int32_t)(now - nextMs) < 0) {
    return;
  }
  nextMs = now + AXES_REPORT_MS;

  if (!lastMpuOk) {
    statusLine("Axes  : no MPU6050 data yet (check sensor / wiring)");
    return;
  }

  fmtFixed(r1, sizeof(r1), (int32_t)lroundf(lastMpu.ax  * 100.0f), 2);
  fmtFixed(r2, sizeof(r2), (int32_t)lroundf(lastMpu.ay  * 100.0f), 2);
  fmtFixed(r3, sizeof(r3), (int32_t)lroundf(lastMpu.az  * 100.0f), 2);
  fmtFixed(r4, sizeof(r4), (int32_t)lroundf(gBody.fwd   * 100.0f), 2);
  fmtFixed(r5, sizeof(r5), (int32_t)lroundf(gBody.right * 100.0f), 2);
  fmtFixed(r6, sizeof(r6), (int32_t)lroundf(-gBody.down * 100.0f), 2);   // 机体的"上"

  snprintf(line, sizeof(line), "Axes  : raw AX %s AY %s AZ %s  |  body FWD %s RIGHT %s UP %s",
           r1, r2, r3, r4, r5, r6);
  statusLine(line);

  fmtFixed(p,  sizeof(p),  (int32_t)lroundf(attPitch() * 10.0f), 1);
  fmtFixed(rl, sizeof(rl), (int32_t)lroundf(attRoll()  * 10.0f), 1);
  snprintf(line, sizeof(line), "Axes  : %s chipup=%d  PITCH %s ROLL %s  (roll right -> ROLL +)",
           attMountName(attGetMount()), (int)attGetChipUp(), p, rl);
  statusLine(line);
}

/* printCmdHelp()：串口命令帮助（在串口监视器里敲一个字符 + 回车即可） */
void printCmdHelp(void) {
#if CMD_ENABLE
  statusLine("Cmd    : d = toggle AXIS/DIR self-test screen");
  statusLine("Cmd    : m = cycle IMU mount (X-fwd/X-right/X-back/X-left/chip-down)");
  statusLine("Cmd    : g = toggle sky/ground fill (row-based <-> per-pixel)");
  statusLine("Cmd    : r = cycle LCD rotation  b/B = backlight +/-10%");
  statusLine("Cmd    : c = redo still calibration   h = this help");
#endif
}

/* pollSerialCommands()：解析串口命令（只读 Serial=USB CDC，不碰 UART0 的数据流）
 * 为什么放在 ST_RUN 里：命令只影响"运行期参数"，不参与初始化流程，逻辑最简单。 */
void pollSerialCommands(uint32_t now) {
#if CMD_ENABLE
  while (Serial.available() > 0) {
    const int ci = Serial.read();
    const char c = (char)ci;

    switch (c) {
      case 'd':
      case 'D':
        diagMode = !diagMode;
        statusLine(diagMode ? "Cmd    : self-test screen ON  (d=exit, m=mount)"
                            : "Cmd    : self-test screen OFF (attitude UI resumed)");
        break;

      case 'm':
      case 'M': {
        char b[80];
        attCycleMount();
        snprintf(b, sizeof(b), "Cmd    : mount -> %s chipup=%d  (check: roll right -> ROLL +)",
                 attMountName(attGetMount()), (int)attGetChipUp());
        statusLine(b);
        break;
      }

      case 'r':
      case 'R':
        if (displayOk) {
          dispSetRotation((uint8_t)((dispGetRotation() + 1) & 0x03));
        } else {
          statusLine("Cmd    : display disabled (UI_ENABLE=0)");
        }
        break;

      case 'g':
      case 'G':
        /* 天空/地面填充方式切换：逐行分段 ↔ 逐像素（现场对比哪种植观感更好） */
        if (displayOk) {
          dispToggleGradient();
        } else {
          statusLine("Cmd    : display disabled (UI_ENABLE=0)");
        }
        break;

      case 'b':
      case 'B':
        if (displayOk) {
          int lv = (int)getBacklight() + ((c == 'b') ? 26 : -26);
          if (lv > 255) lv = 255;
          if (lv < 0)   lv = 0;
          setBacklight((uint8_t)lv);
          {
            char b[48];
            snprintf(b, sizeof(b), "Cmd    : backlight %u/255 (~%u%%)",
                     (unsigned)getBacklight(), (unsigned)((getBacklight() * 100U) / 255U));
            statusLine(b);
          }
        }
        break;

      case 'c':
      case 'C':
#if CALIB_ENABLE
        attCalibBegin();
        calibNextMs = now;
        calibPct    = 0;
        stateT0     = now;
        appState    = ST_CALIB;
        statusLine("Cmd    : redo calibration - keep the board STILL (1.2s)");
#else
        statusLine("Cmd    : calibration disabled (CALIB_ENABLE=0)");
#endif
        break;

      case 'h':
      case 'H':
      case '?':
        printCmdHelp();
        break;

      default:
        break;              // 回车/换行/未知字符直接忽略
    }
  }
#else
  (void)now;
#endif
}






