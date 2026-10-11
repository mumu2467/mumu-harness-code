/* ============================================================================
 *  app_config.h —— 本工程「全局配置」头文件（改参数只改这里）
 *  项目：边坡 4G 监测节点（边坡4G监测1007）
 *        AHT30 + MPU6050 --I2C--> ESP32-S3 --UART1--> 银尔达 YED-M100MG-C2 透传DTU --4G--> 服务器
 *        在 esp32-0920-aht30-mpu6050（温湿度 + 姿态 + ST7789 彩屏）基础上扩展 4G 上报与定位。
 * ----------------------------------------------------------------------------
 *  里面分 15 节：
 *    0) 通用日志宏（与 .ino 里的 outLine/statusLine 行为一致）
 *    1) 引脚定义 + ★ 编译期引脚冲突检查（含 4G DTU 引脚）
 *    2) 串口输出开关（保留原有 MPU,/AHT, 数据行，新增 ATT 姿态行）
 *    3) 任务周期（MPU 20Hz / 温湿度 1Hz / 屏幕 20FPS）
 *    4) 姿态解算与滤波参数（含"安装方向补偿"宏）
 *    5) 屏幕 UI 布局 / 配色 / 几何
 *    6) 背光（GPIO42 的 LEDC PWM）
 *    7) 功能开关汇总
 *   ---- 以下是边坡 4G 监测节点新增（全部为"新宏"，不改老工程任何既有宏取值）----
 *    8) 身份与网络（设备 ID / 固件版本 / 服务器地址）        ← PROMPT §7.1-A
 *    9) 4G DTU 串口参数 / 命令超时 / 定位命令参数           ← PROMPT §7.1-B
 *   10) 网络状态 / 上报周期 / 退避与重发
 *   11) 定位有效性判定（GPS 优先、LBS 兜底）               ← PROMPT §7.1-C
 *   12) 扩展传感器预留（雨量 / 土壤 / 裂缝 / 电池 ADC）      ← PROMPT §7.1-E
 *   13) 告警阈值 / 看门狗 / 低功耗预留
 *   14) 传感器与 I2C 总线参数（集中索引，值与原工程完全一致）← PROMPT §7.1-D
 * ----------------------------------------------------------------------------
 *  ★ 注意：屏幕的 SCL/SDA(MOSI)/RES/DC/CS 这几个引脚不在本文件里 #define，
 *    而是由 TFT_eSPI 的编译期宏决定（必须让"库源码"也能看到，否则不生效）：
 *      · PlatformIO → platformio.ini 的 build_flags（-DTFT_SCLK=21 ...）
 *      · Arduino IDE → TFT_eSPI 库里的 User_Setup.h
 *        （内容见同目录 User_Setup_ST7789_ESP32S3.h）
 *    本文件只负责「读取」这些宏做冲突检查，以及定义背光脚 PIN_LCD_BLK。
 * ============================================================================ */

#ifndef APP_CONFIG_H
#define APP_CONFIG_H

#include <Arduino.h>     // Serial / millis 等
#include <stdarg.h>      // va_list（格式化日志）
#include <stdio.h>       // snprintf / vsnprintf
#include <TFT_eSPI.h>    // ★ 为了拿到 TFT_SCLK / TFT_MOSI 等宏（由 build_flags 或 User_Setup.h 提供）

/* ============================================================================
 *  0. 通用日志（供 attitude.cpp / display_st7789.cpp 使用）
 * ----------------------------------------------------------------------------
 *  .ino 里已有 outLine()/statusLine()，但它们定义在 .ino（其它 .cpp 看不到），
 *  所以这里用 inline 提供同一套行为：同时写 USB CDC 与 UART0，
 *  以 '#' 开头的行表示"状态提示，不是数据"（网页仪表盘会忽略它们）。
 * ============================================================================ */
inline void cfgOutLine(const char *text) {
  Serial.println(text);              // USB CDC（原生 USB 口）
#if ARDUINO_USB_CDC_ON_BOOT
  Serial0.println(text);             // UART0（板上 USB 转串口芯片，GPIO43/44）
#endif
}

/* 输出一行状态提示（自动加 '#' 前缀） */
inline void cfgStatusLine(const char *text) {
  char buf[120];
  snprintf(buf, sizeof(buf), "#%s", text);
  cfgOutLine(buf);
}

/* 格式化输出状态提示：cfgStatusf("FPS: %.1f", x) */
inline void cfgStatusf(const char *fmt, ...) {
  char    body[112];
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(body, sizeof(body), fmt, ap);
  va_end(ap);
  cfgStatusLine(body);
}


/* ============================================================================
 *  1. 引脚定义
 * ============================================================================ */

/* ---- I2C 总线（AHT30 + MPU6050 共用，保持原工程接法不变）----
 *  ★ 本工程 I2C 用的是 GPIO8/9，**不是** ESP32 默认的 GPIO21/22，
 *    所以屏幕占用 GPIO21 作为 SPI SCLK 不会冲突（详见 README 第十二节）。 */
#define PIN_I2C_SDA      8        // I2C 数据线 SDA（AHT30 + MPU6050 共用）
#define PIN_I2C_SCL      9        // I2C 时钟线 SCL（AHT30 + MPU6050 共用）

/* ---- ★ PROMPT §7.1-D 里用的是 I2C_SDA / I2C_SCL 这两个名字 ----
 *  这里做「同值别名」，两个名字随便用哪个都一样，真值只有上面两行。
 *  （命名规范：本工程的引脚一律叫 PIN_xxx；PROMPT 名字保留是为了对齐文档） */
#define I2C_SDA          PIN_I2C_SDA   // = 8
#define I2C_SCL          PIN_I2C_SCL   // = 9

/* ---- 屏幕背光（ST7789 的 BLK）：用 LEDC PWM 调光，必须与 -DTFT_BL 一致 ---- */
#define PIN_LCD_BLK      42       // 屏幕 BLK，高电平点亮（TFT_BACKLIGHT_ON = HIGH）

/* ---- 屏幕其余引脚（只用于打印/自检，实际由 TFT_eSPI 宏决定）----
 *    -DTFT_SCLK=21  → 屏 SCL   （SPI 时钟）
 *    -DTFT_MOSI=47  → 屏 SDA   （SPI 数据，只写）
 *    -DTFT_RST =45  → 屏 RES   （★ GPIO45 是 ESP32-S3 的 strapping 脚）
 *    -DTFT_DC  =40  → 屏 DC
 *    -DTFT_CS  =41  → 屏 CS
 *    -DTFT_BL  =42  → 屏 BLK
 *    -DTFT_MISO=-1  → 不接（屏幕只写不读）
 */

/* ---- 串口相关引脚（板载已接好，这里只做冲突检查用）----
 *  GPIO19/20 = 原生 USB D-/D+；GPIO43/44 = UART0 TX/RX，
 *  这三组严禁再分给屏幕或传感器。 */
#define PIN_USB_DP       20       // 原生 USB D+（USB CDC 虚拟串口）
#define PIN_USB_DN       19       // 原生 USB D-
#define PIN_UART0_TX     43       // UART0 TX（板上 USB 转串口芯片）
#define PIN_UART0_RX     44       // UART0 RX

/* ---- ★ 新增（边坡 4G 监测节点）：银尔达 YED-M100MG-C2 透传 DTU ----
 *  接法（★ 交叉接）：ESP32 的 TX(GPIO17) -> DTU 的 RXD ；ESP32 的 RX(GPIO18) <- DTU 的 TXD
 *  ★ 为什么选 GPIO17/18：
 *      它们是 ESP32-S3 UART1 的 IO_MUX 原生脚（U1TXD / U1RXD），不必经 GPIO Matrix 交换；
 *      且在 DevKitC-1 的 J1 排针上 15-16-17-18 连续相邻，杜邦线最不容易接错。
 *      不与既有 I2C(8/9)、屏幕(21/47/41/40/45/42)、UART0(43/44)、原生USB(19/20) 冲突，
 *      也不在 Flash/PSRAM 区(26~37)、不是 S3 的 strapping 脚(0/3/45/46)。
 *  ★ 可选脚填 -1 表示"不接"：RST/RDY 不接也能跑（方案 C），代价是无法自动复位 DTU。
 *  ★ DTU 是"透传 DTU"不是 AT 模块：本工程不会向它发任何 AT/联网指令，
 *      只是往 Serial1 写数据，数据由 DTU 透传到服务器。
 *  ★★ 字节级铁律：凡是"以 config 开头、以 \r\n 结尾"的数据会被 DTU 当配置命令拦截，
 *      不进透传通道 —— 所以上报内容里绝不允许出现这种组合（见 PROMPT 第 5 节）。 */
#define PIN_DTU_TX       17       // ESP32 TX -> DTU 的 RXD（★ 交叉接）
#define PIN_DTU_RX       18       // ESP32 RX <- DTU 的 TXD（★ 交叉接）
#define PIN_DTU_RST      16       // DTU 的 RST（建议串 10k 上拉到 3.3V；低有效为推测，待实测）
#define PIN_DTU_RDY      15       // DTU 的 RDY（3.3V 输出，联网成功为高电平）；不接填 -1
#define PIN_DTU_PWR      -1       // DTU 电源高边开关（可选，接 P-MOS 栅极，实现断电重启）；不接填 -1

/* ---- ★ 扩展传感器预留脚（本阶段只定义、不使用；将来加传感器只改这里 + 驱动）----
 *  这些脚现在全部空着，给第 12 节的雨量计 / 土壤 / 裂缝计 / 电池采样用。
 *  ★ ADC 选择说明：ESP32-S3 的 ADC1 = GPIO1~10（与射频互不影响），ADC2 = GPIO11~20。
 *    所以模拟量一律优先放 ADC1，避开 ADC2 在 WiFi 下的已知限制。 */
#define PIN_EXT_RAIN     4        // 预留：翻斗式雨量计脉冲输入（需要外部中断）
#define PIN_EXT_SOIL_TX  5        // 预留：RS485 / 土壤传感器 TX（第二路 UART）
#define PIN_EXT_SOIL_RX  6        // 预留：RS485 / 土壤传感器 RX
#define PIN_EXT_CRACK_ADC 7       // 预留：裂缝计模拟量输入（★ ADC1_CH6）
#define PIN_EXT_BATT_ADC 1        // 预留：电池电压分压采样（★ ADC1_CH0）

/* ============================================================================
 *  1.1 ★ 编译期引脚冲突检查（写错引脚在编译阶段就报错，不用等上电）
 *      用的是 #if + #error：宏在预处理阶段比较，属于"零成本自检"。
 * ============================================================================ */

/* 必须先有 TFT_eSPI 的引脚宏，否则一切自检都没意义 */
#if !defined(TFT_SCLK) || !defined(TFT_MOSI) || !defined(TFT_CS) || !defined(TFT_DC) || !defined(TFT_RST)
  #error "TFT_eSPI pin macros missing! PlatformIO: add -DTFT_SCLK=21 ... to build_flags; Arduino IDE: copy User_Setup_ST7789_ESP32S3.h into TFT_eSPI/User_Setup.h"
#endif

/* 屏幕引脚 与 I2C 引脚 冲突（历史上最容易踩的坑：GPIO21 被当默认 I2C 用） */
#if (TFT_SCLK == PIN_I2C_SDA) || (TFT_SCLK == PIN_I2C_SCL)
  #error "PIN CONFLICT: LCD SCL(TFT_SCLK) shares a pin with I2C SDA/SCL. Move I2C to GPIO25/26 or change the LCD pin (see README section 12)"
#endif
#if (TFT_MOSI == PIN_I2C_SDA) || (TFT_MOSI == PIN_I2C_SCL)
  #error "PIN CONFLICT: LCD SDA(TFT_MOSI) shares a pin with I2C SDA/SCL"
#endif

/* 屏幕引脚 与 串口/USB 引脚 冲突（会直接把串口日志/下载搞坏） */
#if (TFT_SCLK == PIN_UART0_TX) || (TFT_SCLK == PIN_UART0_RX) || (TFT_MOSI == PIN_UART0_TX) || (TFT_MOSI == PIN_UART0_RX) || \
    (TFT_CS == PIN_UART0_TX)   || (TFT_CS == PIN_UART0_RX)   || (TFT_DC == PIN_UART0_TX)   || (TFT_DC == PIN_UART0_RX)   || \
    (TFT_RST == PIN_UART0_TX)  || (TFT_RST == PIN_UART0_RX)  || (PIN_LCD_BLK == PIN_UART0_TX) || (PIN_LCD_BLK == PIN_UART0_RX)
  #error "PIN CONFLICT: LCD uses GPIO43/44 (UART0) -> serial log/flash will break. Please move the LCD pin"
#endif
#if (TFT_SCLK == PIN_USB_DN) || (TFT_SCLK == PIN_USB_DP) || (TFT_MOSI == PIN_USB_DN) || (TFT_MOSI == PIN_USB_DP) || \
    (TFT_CS == PIN_USB_DN)   || (TFT_CS == PIN_USB_DP)   || (TFT_DC == PIN_USB_DN)   || (TFT_DC == PIN_USB_DP)   || \
    (TFT_RST == PIN_USB_DN)  || (TFT_RST == PIN_USB_DP)  || (PIN_LCD_BLK == PIN_USB_DN) || (PIN_LCD_BLK == PIN_USB_DP)
  #error "PIN CONFLICT: LCD uses GPIO19/20 (native USB) -> USB CDC serial/download will break. Please move the LCD pin"
#endif

/* 屏幕引脚内部重复（同一根脚被赋了两个功能） */
#if (TFT_SCLK == TFT_MOSI) || (TFT_SCLK == TFT_CS) || (TFT_SCLK == TFT_DC) || (TFT_SCLK == TFT_RST) || (TFT_SCLK == PIN_LCD_BLK)
  #error "DUPLICATE PIN: TFT_SCLK equals another LCD pin, check build_flags / User_Setup.h"
#endif
#if (TFT_MOSI == TFT_CS) || (TFT_MOSI == TFT_DC) || (TFT_MOSI == TFT_RST) || (TFT_MOSI == PIN_LCD_BLK)
  #error "DUPLICATE PIN: TFT_MOSI equals another LCD pin, check build_flags / User_Setup.h"
#endif
#if (TFT_CS == TFT_DC) || (TFT_CS == TFT_RST) || (TFT_CS == PIN_LCD_BLK)
  #error "DUPLICATE PIN: TFT_CS equals another LCD pin, check build_flags / User_Setup.h"
#endif
#if (TFT_DC == TFT_RST) || (TFT_DC == PIN_LCD_BLK) || (TFT_RST == PIN_LCD_BLK)
  #error "DUPLICATE PIN: TFT_DC / TFT_RST / backlight pin overlap, check build_flags / User_Setup.h"
#endif

/* 背光脚必须与 -DTFT_BL 一致（不一致会导致 LEDC 调光调到别的脚上） */
#if (TFT_BL != PIN_LCD_BLK)
  #error "MISMATCH: -DTFT_BL differs from PIN_LCD_BLK. Make them the same GPIO"
#endif

/* ESP32-S3 的 Flash/PSRAM 专用脚（N8/N16 模块用 GPIO26~32） */
#if (TFT_SCLK >= 26 && TFT_SCLK <= 32) || (TFT_MOSI >= 26 && TFT_MOSI <= 32) || (TFT_CS >= 26 && TFT_CS <= 32) || \
    (TFT_DC >= 26 && TFT_DC <= 32)     || (TFT_RST >= 26 && TFT_RST <= 32)   || (PIN_LCD_BLK >= 26 && PIN_LCD_BLK <= 32)
  #error "INVALID PIN: GPIO26~32 are used by ESP32-S3 Flash/PSRAM, cannot be used as normal IO"
#endif
#if (TFT_SCLK >= 33 && TFT_SCLK <= 37) || (TFT_MOSI >= 33 && TFT_MOSI <= 37) || (TFT_CS >= 33 && TFT_CS <= 37) || \
    (TFT_DC >= 33 && TFT_DC <= 37)     || (TFT_RST >= 33 && TFT_RST <= 37)   || (PIN_LCD_BLK >= 33 && PIN_LCD_BLK <= 37)
  #warning "PIN NOTE: GPIO33~37 are unavailable on modules with Octal PSRAM (e.g. N16R8); fine on the N8 module of this project"
#endif

/* GPIO45 是 strapping 脚（VDD_SPI 电压选择）——编译期给个提醒 */
#if (TFT_RST == 45) || (TFT_DC == 45) || (TFT_CS == 45) || (TFT_SCLK == 45) || (TFT_MOSI == 45) || (PIN_LCD_BLK == 45)
  #warning "WIRING NOTE: GPIO45 is an ESP32-S3 strapping pin (VDD_SPI). If the module pulls this line to 3.3V it may fail to boot; add a 10k pull-down on GPIO45 or move the signal to GPIO38 (README section 12)"
#endif

/* GPIO40/41/42 是 ESP32-S3 的默认 JTAG 脚（MTDO/MTDI/MTMS） */
#if (TFT_RST >= 40 && TFT_RST <= 42) || (TFT_DC >= 40 && TFT_DC <= 42) || (TFT_CS >= 40 && TFT_CS <= 42) || \
    (PIN_LCD_BLK >= 40 && PIN_LCD_BLK <= 42)
  #warning "WIRING NOTE: GPIO40/41/42 are S3 JTAG pins (MTDO/MTDI/MTMS). Using them as GPIO is fine, but an external JTAG probe can no longer be attached"
#endif

/* ============================================================================
 *  1.2 ★ 编译期检查：4G DTU 引脚（阶段 1 方案 A：TX=17 / RX=18 / RST=16 / RDY=15）
 *      用 #if + #error 在编译阶段就拦住"接错脚 / 复用脚"，不用等上电冒烟。
 *      ⚠️ 可选脚填 -1（不接）时，所有"== 某脚"的判断自动为假，不会误报。
 * ============================================================================ */

/* ① TX/RX 是必需脚：不允许 -1，且必须是两个不同的脚 */
#if (PIN_DTU_TX < 0) || (PIN_DTU_RX < 0)
  #error "DTU PIN: PIN_DTU_TX / PIN_DTU_RX are required -> they must not be -1"
#endif
#if (PIN_DTU_TX == PIN_DTU_RX)
  #error "DTU PIN: PIN_DTU_TX and PIN_DTU_RX must be two different GPIOs"
#endif

/* ② 不能与 I2C 冲突（AHT30 / MPU6050 共用一条总线，动了全挂） */
#if (PIN_DTU_TX == PIN_I2C_SDA) || (PIN_DTU_TX == PIN_I2C_SCL) || \
    (PIN_DTU_RX == PIN_I2C_SDA) || (PIN_DTU_RX == PIN_I2C_SCL) || \
    (PIN_DTU_RST == PIN_I2C_SDA) || (PIN_DTU_RST == PIN_I2C_SCL) || \
    (PIN_DTU_RDY == PIN_I2C_SDA) || (PIN_DTU_RDY == PIN_I2C_SCL)
  #error "DTU PIN CONFLICT: a DTU pin shares a GPIO with I2C SDA/SCL"
#endif

/* ③ 不能与屏幕的 6 个脚冲突 */
#if (PIN_DTU_TX == TFT_SCLK) || (PIN_DTU_TX == TFT_MOSI) || (PIN_DTU_TX == TFT_CS) || (PIN_DTU_TX == TFT_DC) || (PIN_DTU_TX == TFT_RST) || (PIN_DTU_TX == PIN_LCD_BLK) || \
    (PIN_DTU_RX == TFT_SCLK) || (PIN_DTU_RX == TFT_MOSI) || (PIN_DTU_RX == TFT_CS) || (PIN_DTU_RX == TFT_DC) || (PIN_DTU_RX == TFT_RST) || (PIN_DTU_RX == PIN_LCD_BLK) || \
    (PIN_DTU_RST == TFT_SCLK) || (PIN_DTU_RST == TFT_MOSI) || (PIN_DTU_RST == TFT_CS) || (PIN_DTU_RST == TFT_DC) || (PIN_DTU_RST == TFT_RST) || (PIN_DTU_RST == PIN_LCD_BLK) || \
    (PIN_DTU_RDY == TFT_SCLK) || (PIN_DTU_RDY == TFT_MOSI) || (PIN_DTU_RDY == TFT_CS) || (PIN_DTU_RDY == TFT_DC) || (PIN_DTU_RDY == TFT_RST) || (PIN_DTU_RDY == PIN_LCD_BLK)
  #error "DTU PIN CONFLICT: a DTU pin shares a GPIO with the ST7789 LCD"
#endif

/* ④ 不能与 UART0（GPIO43/44，日志 + 烧录命脉）或原生 USB（GPIO19/20）冲突 */
#if (PIN_DTU_TX == PIN_UART0_TX) || (PIN_DTU_TX == PIN_UART0_RX) || (PIN_DTU_RX == PIN_UART0_TX) || (PIN_DTU_RX == PIN_UART0_RX) || \
    (PIN_DTU_RST == PIN_UART0_TX) || (PIN_DTU_RST == PIN_UART0_RX) || (PIN_DTU_RDY == PIN_UART0_TX) || (PIN_DTU_RDY == PIN_UART0_RX)
  #error "DTU PIN CONFLICT: a DTU pin uses GPIO43/44 (UART0) -> serial log / flashing will break"
#endif
#if (PIN_DTU_TX == PIN_USB_DN) || (PIN_DTU_TX == PIN_USB_DP) || (PIN_DTU_RX == PIN_USB_DN) || (PIN_DTU_RX == PIN_USB_DP) || \
    (PIN_DTU_RST == PIN_USB_DN) || (PIN_DTU_RST == PIN_USB_DP) || (PIN_DTU_RDY == PIN_USB_DN) || (PIN_DTU_RDY == PIN_USB_DP)
  #error "DTU PIN CONFLICT: a DTU pin uses GPIO19/20 (native USB) -> USB CDC will break"
#endif

/* ⑤ 不能落在 Flash / PSRAM 专用区（GPIO26~32） */
#if (PIN_DTU_TX >= 26 && PIN_DTU_TX <= 32) || (PIN_DTU_RX >= 26 && PIN_DTU_RX <= 32) || \
    (PIN_DTU_RST >= 26 && PIN_DTU_RST <= 32) || (PIN_DTU_RDY >= 26 && PIN_DTU_RDY <= 32)
  #error "DTU PIN: GPIO26~32 are used by ESP32-S3 Flash/PSRAM, cannot be used"
#endif
/* GPIO33~37：N16R8（八线 PSRAM）模块上不可用 —— 本机是 N8 可用，所以只给提醒 */
#if (PIN_DTU_TX >= 33 && PIN_DTU_TX <= 37) || (PIN_DTU_RX >= 33 && PIN_DTU_RX <= 37) || \
    (PIN_DTU_RST >= 33 && PIN_DTU_RST <= 37) || (PIN_DTU_RDY >= 33 && PIN_DTU_RDY <= 37)
  #warning "DTU PIN NOTE: GPIO33~37 are unavailable on Octal-PSRAM modules (N16R8); fine on this project's N8"
#endif

/* ⑥ 不能是 ESP32-S3 的 strapping 脚（GPIO0 / GPIO3 / GPIO45 / GPIO46） */
#if (PIN_DTU_TX == 0) || (PIN_DTU_TX == 3) || (PIN_DTU_TX == 45) || (PIN_DTU_TX == 46) || \
    (PIN_DTU_RX == 0) || (PIN_DTU_RX == 3) || (PIN_DTU_RX == 45) || (PIN_DTU_RX == 46) || \
    (PIN_DTU_RST == 0) || (PIN_DTU_RST == 3) || (PIN_DTU_RST == 45) || (PIN_DTU_RST == 46) || \
    (PIN_DTU_RDY == 0) || (PIN_DTU_RDY == 3) || (PIN_DTU_RDY == 45) || (PIN_DTU_RDY == 46)
  #error "DTU PIN: GPIO0/3/45/46 are ESP32-S3 strapping pins -> do NOT use them for the DTU"
#endif

/* ⑦ RST 与 RDY 不能是同一根脚 */
#if (PIN_DTU_RST >= 0) && (PIN_DTU_RST == PIN_DTU_RDY)
  #error "DTU PIN: PIN_DTU_RST and PIN_DTU_RDY cannot be the same GPIO"
#endif

/* ⑧ 扩展预留脚之间、以及与"已用脚"不能撞 */
#if (PIN_EXT_RAIN == PIN_EXT_SOIL_TX) || (PIN_EXT_RAIN == PIN_EXT_SOIL_RX) || (PIN_EXT_RAIN == PIN_EXT_CRACK_ADC) || (PIN_EXT_RAIN == PIN_EXT_BATT_ADC) || \
    (PIN_EXT_SOIL_TX == PIN_EXT_SOIL_RX) || (PIN_EXT_SOIL_TX == PIN_EXT_CRACK_ADC) || (PIN_EXT_SOIL_TX == PIN_EXT_BATT_ADC) || \
    (PIN_EXT_SOIL_RX == PIN_EXT_CRACK_ADC) || (PIN_EXT_SOIL_RX == PIN_EXT_BATT_ADC) || (PIN_EXT_CRACK_ADC == PIN_EXT_BATT_ADC)
  #error "EXT PIN: the reserved extension pins (PIN_EXT_*) are not unique"
#endif
#if (PIN_EXT_RAIN == PIN_I2C_SDA) || (PIN_EXT_RAIN == PIN_I2C_SCL) || (PIN_EXT_SOIL_TX == PIN_I2C_SDA) || (PIN_EXT_SOIL_TX == PIN_I2C_SCL) || \
    (PIN_EXT_SOIL_RX == PIN_I2C_SDA) || (PIN_EXT_SOIL_RX == PIN_I2C_SCL) || (PIN_EXT_CRACK_ADC == PIN_I2C_SDA) || (PIN_EXT_CRACK_ADC == PIN_I2C_SCL) || \
    (PIN_EXT_BATT_ADC == PIN_I2C_SDA) || (PIN_EXT_BATT_ADC == PIN_I2C_SCL)
  #error "EXT PIN CONFLICT: a reserved extension pin shares a GPIO with I2C"
#endif
#if (PIN_EXT_RAIN == PIN_DTU_TX) || (PIN_EXT_RAIN == PIN_DTU_RX) || (PIN_EXT_SOIL_TX == PIN_DTU_TX) || (PIN_EXT_SOIL_TX == PIN_DTU_RX) || \
    (PIN_EXT_SOIL_RX == PIN_DTU_TX) || (PIN_EXT_SOIL_RX == PIN_DTU_RX) || (PIN_EXT_CRACK_ADC == PIN_DTU_TX) || (PIN_EXT_CRACK_ADC == PIN_DTU_RX) || \
    (PIN_EXT_BATT_ADC == PIN_DTU_TX) || (PIN_EXT_BATT_ADC == PIN_DTU_RX)
  #error "EXT PIN CONFLICT: a reserved extension pin shares a GPIO with the DTU"
#endif
#if (PIN_EXT_RAIN >= 26 && PIN_EXT_RAIN <= 37) || (PIN_EXT_SOIL_TX >= 26 && PIN_EXT_SOIL_TX <= 37) || \
    (PIN_EXT_SOIL_RX >= 26 && PIN_EXT_SOIL_RX <= 37) || (PIN_EXT_CRACK_ADC >= 26 && PIN_EXT_CRACK_ADC <= 37) || \
    (PIN_EXT_BATT_ADC >= 26 && PIN_EXT_BATT_ADC <= 37)
  #error "EXT PIN: GPIO26~37 are Flash/PSRAM related -> do NOT use them for extension sensors"
#endif

/* ⑨ 模拟量建议放 ADC1（GPIO1~10）；落在 45 这种 strapping 脚只提醒不报错 */
#if (PIN_EXT_CRACK_ADC == 45) || (PIN_EXT_BATT_ADC == 45)
  #warning "EXT PIN NOTE: GPIO45 is a strapping pin; prefer ADC1 (GPIO1~10) for analog inputs"
#endif

/* ============================================================================
 *  2. 串口输出开关 / 格式
 * ----------------------------------------------------------------------------
 *  原有数据行一律保留（网页仪表盘 web/index.html 靠它们画曲线）：
 *      MPU,<ms>,ax,ay,az,gx,gy,gz      20Hz（本工程 MPU_PERIOD_MS = 50）
 *      AHT,<ms>,temperature,humidity   1Hz
 *  新增：
 *      ATT 姿态行（20Hz，格式见 ATT_LINE_STYLE）
 *      可选的人类可读温湿度行（1Hz，AHT_LINE_HUMAN）
 *      屏幕帧率提示行（1Hz，FPS_LINE_ENABLE，'#' 开头属状态行）
 *  ★ 小提示：USB CDC 在"电脑没打开串口"时写满缓冲区会短暂阻塞，
 *    所以这些"可选行"都留了开关，掉帧/卡顿时可关掉。
 * ============================================================================ */
#define ATT_LINE_STYLE   1        // 0=CSV: ATT,<ms>,pitch,roll ；1=可读: Pitch: 12.3, Roll: -4.5 ；2=两种都发
#define AHT_LINE_HUMAN   1        // 1=额外输出 "Temp: 25.3 C, Humi: 61.2 %"；0=关
#define FPS_LINE_ENABLE  1        // 1=每秒输出 "#FPS: 19.8 / 20.0"（排查掉帧用）；0=关

/* ============================================================================
 *  3. 任务周期（全程 millis() 非阻塞，禁止 delay）
 * ============================================================================ */
#define MPU_PERIOD_MS    50UL     // ★ MPU6050：50ms = 20Hz（读取→解算→串口→屏幕刷新一条线走完）
#define ATT_PERIOD_MS    50UL     // 姿态串口行：20Hz（与 MPU 同步；想省串口可改成 100/200）
#define AHT_PERIOD_MS    1000UL   // AHT30：1000ms = 1Hz 触发一次测量
#define AHT_WAIT_MS      90UL     // AHT30 触发后等待转换完成（数据手册 80ms，留余量 90ms）
#define DISP_PERIOD_MS   50UL     // 屏幕姿态层刷新：50ms = 20FPS
#define FPS_REPORT_MS    1000UL   // 帧率统计/上报周期 1Hz
#define UI_TASK_LIMIT_MS 45UL     // 单帧绘制耗时警戒线(ms)：超过就打印提示，便于排查掉帧
#define BOOT_EXTRA_MS    2500UL   // 「屏幕方向自检」停留时间：开机画面多显示这么久，
                                  //   方便你判断屏幕方向对不对（见 README 12.9）
#define AXES_REPORT_MS   1000UL   // 1Hz 打印一行 "#Axes ..."（原始轴/机体轴/角度），
                                  //   用来核对"安装方向"是否正确

/* ---- 串口命令（在串口监视器里直接敲一个字符 + 回车）----
 *   仅用 Serial(USB CDC) 收命令，不影响数据输出；用不着就把 CMD_ENABLE 设为 0
 *   命令表：d=开/关"方向+轴向自检"画面  m=循环安装方向  r=循环屏幕旋转
 *          b=亮度 +10%  B=亮度 -10%  c=重新静置校准  h=打印帮助 */
#define CMD_ENABLE       1

/* ============================================================================
 *  4. 姿态解算与滤波（pitch 俯仰 / roll 横滚，单位：度）
 * ============================================================================ */
/* ---- 互补滤波时间常数 ----
 *  原理：角度 = α·(上一角度 + 陀螺角速度·dt) + (1-α)·(加速度计绝对角)，α = τ/(τ+dt)。
 *        τ 越大越信任陀螺（更平滑、跟随更慢）；τ→0 就是"纯加速度计"。
 *        陀螺有零偏 b 时稳态误差 ≈ τ·b，所以开机先标定零偏（见下面 CALIB_*）。 */
#define CF_TAU_S         0.35f    // 互补滤波时间常数(s)：0.1~1.0 之间调（越大越平滑）
#define DISP_TAU_S       0.20f    // 显示级一阶低通时间常数(s)：越大画面越"丝滑"（0=不平滑）
                                  //   ★ 觉得画面抖 → 调大（0.25~0.35）；觉得反应慢 → 调小

/* ---- 开机静置校准（陀螺零偏 + 姿态零点；非阻塞，占用 ST_CALIB 状态）---- */
#define CALIB_ENABLE     1        // 1=开机静置校准（推荐）；0=跳过（用固件内零偏 0）
#define CALIB_MS         1200UL   // 校准采样时长(ms)，期间请保持板子静止
#define CALIB_LEVEL_ZERO 1        // 1=把开机姿态当 0° 基准（放平即显示 0.0°）；0=显示重力绝对角
#define CALIB_MAX_SPAN_DPS 3.0f   // 校准期间角速度波动超过该值(°/s)就提示"设备在动"

/* ---- 安装方向补偿（改这几个宏即可适配装机方向，不用改代码）
 *  默认 XFWD：模块平放、芯片朝上（+Z 朝天）时，
 *            芯片 +X 指向机头（屏幕上方）、+Y 指向屏幕右侧、+Z 朝天。
 *  ★ 这个默认值与网页仪表盘 web/index.html 的「模块方向 = X 轴朝前」一致，
 *    两边看到的姿态应当是相同的。
 *  四个预设（芯片朝上时，各"物理轴"对应的传感器轴与符号）：
 *      X 朝机头 : fwd=+ax  right=-ay  up=+az   ← 默认
 *      X 朝右   : fwd=+ay  right=+ax  up=+az
 *      X 朝机尾 : fwd=-ax  right=+ay  up=+az
 *      X 朝左   : fwd=-ay  right=-ax  up=+az
 *  ★ 装反了不用重新烧录：串口敲 'm' 就能循环切换（见 README 12.9），
 *    试出正确的一组后把下面 IMU_MOUNT / IMU_CHIP_UP 改成同值即可固化。 */
#define IMU_MOUNT_XFWD   0        // +X 朝机头（屏幕上方）← 默认
#define IMU_MOUNT_XRIGHT 1        // +X 朝屏幕右侧
#define IMU_MOUNT_XBACK  2        // +X 朝机尾（屏幕下方）
#define IMU_MOUNT_XLEFT  3        // +X 朝屏幕左侧
#define IMU_MOUNT        IMU_MOUNT_XFWD
#define IMU_CHIP_UP      1        // 1=芯片朝上（+Z 朝天）；0=倒扣安装（+Z 朝地）
#define IMU_FLIP_PITCH   0        // 1=俯仰方向反了（角度与角速度一起反）
#define IMU_FLIP_ROLL    0        // 1=横滚方向反了

#define PITCH_LIMIT_DEG  90.0f    // 俯仰限幅（±90° 之外没有意义，避免抖动）

/* ============================================================================
 *  5. 屏幕 UI（ST7789 240x320 竖屏：上方 240x240 姿态仪 + 下方 80px 温湿度区）
 * ============================================================================ */
#define SCR_W            240      // 屏幕宽（竖屏方向）
#define SCR_H            320      // 屏幕高（竖屏方向）
#define UI_ROTATION      0        // 0/2=竖屏(240x320)，1/3=横屏；画面倒过来就改 2
#define UI_X_OFFSET      0        // 姿态层水平微调（个别模组有 1~2px 偏移时用）
#define UI_Y_OFFSET      0        // 姿态层垂直微调

/* ---- 姿态仪（ADI：Attitude Indicator）几何 ---- */
#define ADI_W            240      // 姿态仪区域宽
#define ADI_H            240      // 姿态仪区域高
#define ADI_CX           120.0f   // 姿态仪中心 X（旋转/平移的基准点）
#define ADI_CY           120.0f   // 姿态仪中心 Y
#define PX_PER_DEG       3.0f     // 俯仰比例：1° = 3 像素（±30° 约 ±90px，正好落在 240 内）
#define GRAD_MAX_DIST    150.0f   // 渐变计算的最大距离(px)：超过它统一用"远端色"
#define LUT_STEPS        128      // 天空/地面渐变级数：128 级 ≈ 每 1.2px 换一档 → 看不到"条带"
#define GRAD_MIX         0.30f    // ★渐变强度：0=完全不用远端色（天空/地面就是两块纯色），
                                  //   1=一直渐变到最深的远端色（色差最大、看着最"花"）
                                  //   默认 0.30 → 远处只比地平线处深一点点，观感就是
                                  //   "一块天蓝 + 一块棕色"，不会象彩虹。
                                  //   ★ 觉得还是花 → 设 0.0（纯两块色）；想立体一点 → 0.5~0.8
#define LADDER_10_HALF   12       // 俯仰刻度 ±10° 的半长(px)
#define LADDER_20_HALF   18       // ±20° 的半长(px)
#define LADDER_30_HALF   24       // ±30° 的半长(px)
#define FONT_SMALL       2        // 小字字体(16px)：角标/状态/刻度数字
#define FONT_BIG         4        // 大字字体(26px)：温湿度数值

/* ---- 底部温湿度区 ---- */
#define ENV_Y            240      // 温湿度区起始 y
#define ENV_H            80       // 温湿度区高度

/* ---- 配色（用 24bit RGB 自动折算成 RGB565，避免手算十六进制出错）---- */
#define RGB565(r, g, b)  ((uint16_t)((((r) & 0xF8) << 8) | (((g) & 0xFC) << 3) | ((b) >> 3)))

#define C_SKY_NEAR    RGB565( 79, 168, 224)   // 天空近地平线：浅蓝
#define C_SKY_FAR     RGB565( 12,  45,  82)   // 天空远端：深蓝
#define C_GND_NEAR    RGB565(168, 117,  46)   // 地面近地平线：棕褐
#define C_GND_FAR     RGB565( 42,  27,  12)   // 地面远端：暗褐
#define C_HORIZON     RGB565(242, 247, 255)   // 地平线：近白
#define C_LADDER      RGB565(226, 236, 248)   // 俯仰刻度线
#define C_SCALE       RGB565(170, 200, 230)   // 横滚刻度
#define C_AIRCRAFT    RGB565(255, 200,  87)   // 飞机符号：琥珀色（经典姿态仪配色）
#define C_TEXT        RGB565(236, 244, 255)   // 主文字
#define C_DIM         RGB565(126, 142, 166)   // 次要文字
#define C_ACCENT      RGB565( 34, 211, 238)   // 强调青（顶部指针 / 进度条）
#define C_OK          RGB565( 52, 211, 153)   // 正常（绿）
#define C_ERR         RGB565(255, 107, 107)   // 异常（红）
#define C_PANEL       RGB565( 14,  23,  41)   // 底部面板底色
#define C_BORDER      RGB565( 30,  58,  95)   // 面板描边
#define C_ICON_T      RGB565(255, 138,  92)   // 温度图标（橙红）
#define C_ICON_H      RGB565( 92, 200, 255)   // 湿度图标（蓝）

/* ============================================================================
 *  6. 背光（GPIO42，LEDC PWM 调光）
 * ============================================================================ */
#define BL_PWM_CHANNEL   1        // LEDC 通道（避开通道 0：核心板载 RGB 灯默认用它）
#define BL_PWM_FREQ      5000     // PWM 频率 5kHz（远高于 200Hz，肉眼看不到闪烁）
#define BL_PWM_RES_BITS  8        // 8 位分辨率：占空比 0~255
#define BL_DEFAULT_LEVEL 80       // 默认亮度百分比（0~100）
#define BL_PWM_INVERT    0        // 1=背光"低电平点亮"（模块 BLK 反向）：占空比取反；
                                  //   此时应同时把 -DTFT_BACKLIGHT_ON 改成 LOW

/* ============================================================================
 *  7. 功能开关汇总
 * ============================================================================ */
#define UI_ENABLE        1        // 1=启用 ST7789 屏幕；0=完全关闭屏幕代码（回到"纯传感器"版本）
#define UI_USE_SPRITE    1        // 1=用 TFT_eSprite 离屏绘制（无闪烁，推荐）；0=直接画到屏幕
#define UI_SPRITE_DEPTH  16       // Sprite 色深：16=RGB565（115KB 内存，颜色最直观）；8=256 色调色板（57.6KB）
#define UI_PIXEL_GRADIENT 0       // 天空/地面填充方式：
                                  //   0 = 逐行分段填色（默认，颜色与旧版观感一致，稳）
                                  //   1 = 逐像素填色（更细腻）
                                  //   ★ 运行期可用串口命令 'g' 在两者之间切换，现场对比哪个好看

/* ============================================================================
 *  8. ★ 身份与网络（PROMPT §7.1-A）
 * ----------------------------------------------------------------------------
 *  ★ 先看清本项目的上报链路：ESP32 → Serial1 →「透传 DTU」→ 服务器。
 *    也就是说 HTTP 的 URL / 端口 / 请求头 / 协议全部由 **DTU 侧**决定，
 *    固件不组 HTTP 报文（透传模式下也发不出去）。
 *    所以下面这几个宏的真正作用是：
 *      ① 作为「服务器地址的唯一书面记录」，与 DTU 里的配置对得上号；
 *      ② 日志 / README / 答辩材料引用同一份值，避免两处写得不一致；
 *      ③ 将来若改成「DTU 自己定时上报」的方案，这几个宏可直接复用。
 *  ⚠ 待确认（阶段 4 之前必须定）：DTU 侧 HTTP 通道参数的配置方式（平台 or 串口命令），
 *    见 docs/阶段1_引脚与供电方案.md 第 5.1 节。
 * ============================================================================ */
#define DEVICE_ID            "slope-001"     // 设备唯一 ID（上报字段与数据库主键；多节点逐个改）
#define DEVICE_MODEL         "M100MG-C2"     // 4G 模组型号（写日志 / README 用）
#define FW_VERSION           "1.0.0"         // 固件版本（随 JSON 上报，便于服务器分辨固件）
#define SERVER_HOST          "192.168.1.100" // 服务器 IP / 域名（★ 仅记录，固件本身不发 HTTP）
#define SERVER_PORT          8000            // 服务器端口（★ 仅记录；DTU 里配的必须与它一致）
#define POST_PATH            "/api/report"   // 上报路径（★ 仅记录；DTU 里配的必须与它一致）
#define HTTP_TIMEOUT_MS      10000UL         // 一次上报的最长等待（透传时＝等服务器回包的时间）
#define UPLOAD_BUF_SLOTS     10              // 失败缓存槽位数（10 槽 × 60s ≈ 可缓存 10 分钟数据）
/* ★ 与「上报节奏 / 重发」有关的宏不看这里，看下一节
 *   （9. 网络状态 / 上报周期 / 退避与重发）：
 *    NET_ENABLE、UPLOAD_PERIOD_MS、UPLOAD_JITTER_MS、UPLOAD_RETRY_MAX、UPLOAD_BACKOFF_MS ...
 *   这些宏的消费方 net_dtu.cpp 到【阶段 4】才写，现在先做成一张"要改只改这里"的总表。 */

/* ============================================================================
 *  9. ★ 4G DTU 串口参数 / 命令超时 / 定位命令参数（银尔达 M100MG-C2，透传固件）
 * ----------------------------------------------------------------------------
 *  ★ 本 DTU 是"透传 DTU"：ESP32 不发任何 AT / 联网指令，也不做联网握手，
 *    只是把数据写进 Serial1，DTU 自动把它透传到服务器 URL。
 *  ★★ 字节级铁律：以 "config" 开头、以 "\r\n" 结尾的数据会被 DTU 当配置命令拦截，
 *    不进透传通道 —— 所以上报内容里绝不允许出现这种组合（见 PROMPT 第 5 节）。
 * ============================================================================ */
#define DTU_UART_NUM         1        // 用 UART1（UART0 归日志，UART2 预留给 RS485 土壤传感器）
#define DTU_BAUD             115200UL // DTU 主串口波特率（★ 官方文档只写支持 1200~460800，
                                      //   未写默认值 → 待实测；不通就依次试 9600/57600/230400）
#define DTU_BAUD_FALLBACK    9600UL   // 备选波特率（实测 115200 不通时改用它）
#define DTU_RX_BUF           512      // 接收环形缓冲字节数（DTU 会回显命令结果，512 足够）
#define DTU_TX_MAX           380      // 单帧上报最大字节（★ 必须 < DTU_TX_BUF，防止被截断）
#define DTU_TX_BUF           1024     // Serial1 发送缓冲区（整帧一次写完，避免半帧发出去）
#define DTU_CMD_TIMEOUT_MS   3000UL   // 等 DTU 回一到两行应答的最长时间（★ PROMPT §7.1-B 与官方均建议 3s）
#define DTU_RESET_PULSE_MS   100UL    // RST 拉低时长（低有效为推测 → 待实测）
#define DTU_RESET_HOLD_MS    3000UL   // 释放 RST 后等 DTU 重新联网的时间
#define DTU_RDY_ACTIVE_HIGH  1        // 1=RDY 高电平表示已联网（据 PROMPT，待实测）
#define DTU_ECHO_ENABLE      1        // 1=把 DTU 回发的内容原样打到日志（调试期必须开）
#define DTU_ALLOW_CONFIG_CMD 1        // 1=允许用"只读"的 config,get,xxx 查询 DTU 状态；
                                      //   0=连查询也不发（完全不用 config 通道）

/* ---- ★ DTU 命令 / 定位参数（PROMPT §7.1-B）
 *  本工程只会用到"只读"的查询命令（字面量在 net_dtu.cpp 里，阶段 4 写）：
 *    config,get,lbsloc / config,get,gps / config,get,gpsext / config,get,nettime / config,get,location
 *  ⚠ 下面 DTU_LOC_* 三个值在官方文档里属"DTU 侧配置项"，用串口命令能不能读/写【尚未确认】
 *    → 阶段 4 定形前一律按"只读参考值"对待，不主动去改 DTU（见 docs 第 5.1 节）。 */
#define DTU_LBS_TIMEOUT_MS   60000UL  // 基站定位最长等待：官方明确建议 60s（室内/弱信号会很慢）
#define DTU_LOC_TYPE         2        // 定位方式：1=LBS 基站定位，2=GPS 定位（本项目优先 GPS=2）
#define DTU_LOC_PERIOD_S     60       // location 数据刷新周期(s)（只读参考，不改 DTU 配置）
#define DTU_LOC_REPORT_TYPE  0        // DTU 主动上报格式：0=不上报（由 MCU 主动查）★本项目用 0
#define DTU_PAID_MODE        0        // 定位服务模式：0=免费（单基站），1=付费（多基站 + WiFi）
#define DTU_DOWNLINK_ENABLE  1        // 1=解析透传通道的"下行"内容（服务器回包 / 下发的命令）
#define DTU_AT_BOOT_RETRY    5        // 开机后与 DTU 通信的失败重试次数（超过则只报警不阻塞）

/* ============================================================================
 * 10. ★ 网络状态判定 / 上报周期 / 退避与重发
 * ----------------------------------------------------------------------------
 *  ★ 周期基数用宏；以后要改成 30s / 5min 只改这里，四处代码自动跟着变。
 * ============================================================================ */
#define NET_ENABLE           1        // 0=彻底关掉 4G 相关代码（只留本地显示，便于对比测试）
#define UPLOAD_PERIOD_MS     60000UL  // 上报周期 60s（1 分钟一条）
#define UPLOAD_JITTER_MS     3000UL   // 周期抖动 ±3s，避免多节点同时上报（对基站也友好）
#define UPLOAD_RETRY_MAX     3        // 一帧最多重发次数
#define UPLOAD_RETRY_GAP_MS  5000UL   // 两次重发之间的间隔
#define UPLOAD_BACKOFF_MS    15000UL  // 连续失败后的退避基数（按失败轮数递增）
#define UPLOAD_BACKOFF_MAX_MS 120000UL // 退避上限 2 分钟
#define NET_OFFLINE_LIMIT    3        // 连续失败 3 次判定"离线"（屏幕/日志转红）
#define DTU_BOOT_GRACE_MS    20000UL  // 上电后给 DTU 的联网宽限期（期间失败不计入离线计数）
#define GPS_PERIOD_MS        300000UL // 定位查询周期 5min（★ 定位是本地串口查询，不产生流量）
#define NETTIME_PERIOD_MS    3600000UL // 网络时间同步周期 1h（config,get,nettime）
#define STATUS_LINE_ENABLE   1        // 1=每秒输出 "#NET ..." 状态行（'#' 行不算数据）

/* ============================================================================
 * 11. ★ 定位有效性判定（GPS 优先、LBS 基站定位兜底）    ← PROMPT §7.1-C
 * ----------------------------------------------------------------------------
 *  ★ 官方原文："GPS需要在室外，空旷的地方定位，室内无法定位" —— 所以必须有超时降级。
 *  ★ 定位命令（config,get,xxx）是"本地串口查询"，不产生 4G 流量。
 * ============================================================================ */
#define GPS_FIX_TIMEOUT_MS   120000UL // 单次 GPS 固定超时：2 分钟（室内永远定不上 → 降级）
#define GPS_FIX_MAX_AGE_MIN  30       // 绝对上限：定位数据超过 30 分钟一律视为"陈旧"（stale）
#define GPS_STALE_FACTOR     3        // ★ PROMPT §7.1-C：超过 3×定位周期(GPS_PERIOD_MS)未更新 → stale=1
#define GPS_MIN_SATS         4        // ★ 最少卫星数才算有效（gpsext 是否返回 sats 待实测）
#define GPS_HDOP_MAX         5.0f     // HDOP 大于 5.0 认为精度差 → gps_valid = 0
#define GEO_FALLBACK_ENABLE  1        // 1=GPS 无效时自动降级用 LBS（config,get,lbsloc）
#define GPS_ALLOW_LBS_FALLBACK GEO_FALLBACK_ENABLE
                                      // ★ PROMPT §7.1-C 用的是这个名字；本工程规范名是上一行的
                                      //   GEO_FALLBACK_ENABLE，此处做"同值别名"，只留一个真值来源
#define GPS_ALT_VALID        1        // 1=上报表海拔 alt（gpsext 取得到才发；取不到则该字段传 null）
/* ★ 与 PROMPT §7.1-C 的一处取值差异（有意为之，已记录在 docs/阶段2 文档）：
 *   PROMPT 写 GPS_FIX_TIMEOUT_MS = 300000UL，本工程用 120000UL（2min）——
 *   室内 5 分钟才降级会让"无定位"这条路径长时间不可达，2min 更利于现场演示与调试。 */
#define GEO_SOURCE_GPS       0        // geo_source 字段：0 = GPS
#define GEO_SOURCE_LBS       1        // geo_source 字段：1 = LBS（基站定位，精度差）
#define GEO_SOURCE_NONE      2        // geo_source 字段：2 = 无定位（经纬度字段传 null）
#define LED_STATUS_ENABLE    0        // 1=用 GPIO48 板载 RGB 指示联网/上报（★ 是否可用待核对）

/* ============================================================================
 * 12. ★ 扩展传感器预留（本阶段只留宏，业务代码为 0；将来加传感器只改这里 + 驱动）
 * ----------------------------------------------------------------------------
 *  引脚见第 1 节的 PIN_EXT_*（GPIO1/4/5/6/7），全部是现在空着、预留出来的脚。
 * ============================================================================ */
#define EXT_RAIN_ENABLE      0        // 雨量计（翻斗式脉冲计数，GPIO4 外部中断）
#define EXT_SOIL_ENABLE      0        // 土壤传感器（RS485 / 第二路 UART，GPIO5/6）
#define EXT_CRACK_ENABLE     0        // 裂缝计（模拟量，GPIO7 → ADC1_CH6）
#define EXT_BATT_ENABLE      0        // 电池电压采样（GPIO1 → ADC1_CH0，需外部分压）
#define EXT_RAIN_TIP_MM      0.2794f  // 翻斗式雨量计每斗 0.2794mm（常见规格，按实物改）
#define EXT_BATT_DIV_RATIO   2.0f     // 电池分压比（例：100k/100k → 2.0）
#define EXT_CRACK_ADC_MAX    4095.0f  // ESP32-S3 ADC 满量程（12 位）

/* ---- ★ PROMPT §7.1-E 逐项对照（同值别名 + 占位宏；全部为 0 = 未启用，不参与任何逻辑）----
 *  PROMPT 给每个预留传感器列了「类型 + 引脚/地址 + 周期 + 量程」四类宏，这里把缺的名字补齐：
 *   · 引脚类：直接指向第 1 节的 PIN_EXT_*（只留一个真值来源，改脚只改第 1 节）
 *   · 周期/量程类：本工程新增的占位宏，取值与 PROMPT 一致
 *  ★ 将来真加一个传感器要改的地方（对应 PROMPT 第 11 节第 9 条，答辩会问）：
 *      ① 本节 EXT_xxx_ENABLE 改 1
 *      ② 第 1 节 PIN_EXT_xxx 引脚确认（或改成本节里的地址/周期）
 *      ③ 新增 sensor_xxx.h/.cpp + data_model.h 加字段（JSON 自动跟着变） */
#define EXT_TILT2_ENABLE        0        // 第二路倾角（深部位移，I2C 或第二路 MPU6050）；未启用
#define EXT_RAIN_PIN            PIN_EXT_RAIN        // = GPIO4（外部中断）
#define EXT_RAIN_PERIOD_MS      60000UL  // 雨量计读取周期 60s
#define EXT_RAIN_MM_PER_TIP     EXT_RAIN_TIP_MM     // 与上方的 EXT_RAIN_TIP_MM 同值（0.2794mm/斗）
#define EXT_SOIL_ADDR           -1       // RS485/Modbus 从机地址；-1 = 未接
#define EXT_SOIL_PERIOD_MS      300000UL // 土壤含水率读取周期 5min
#define EXT_CRACK_PIN           PIN_EXT_CRACK_ADC   // = GPIO7（★ ADC1_CH6）
#define EXT_CRACK_PERIOD_MS     60000UL  // 裂缝位移读取周期 60s
#define EXT_CRACK_MM_PER_V      1.0f     // 裂缝计换算系数：1 mm/V（按实物标定后再改）
#define EXT_BATT_ADC_PIN        PIN_EXT_BATT_ADC    // = GPIO1（★ ADC1_CH0）
#define EXT_BATT_DIV_R1         100000.0f // 电池分压上臂电阻(Ω)
#define EXT_BATT_DIV_R2         100000.0f // 电池分压下臂电阻(Ω) → 与 EXT_BATT_DIV_RATIO = 2.0 对应

/* ============================================================================
 * 13. ★ 告警阈值 / 看门狗 / 低功耗预留
 * ============================================================================ */
#define WDT_ENABLE           0        // 1=启用任务看门狗（超时未喂狗即重启）
                                      // ★ 阶段 2 保持 0：本工程还没有任何喂狗代码（已 grep 确认无人引用），
                                      //   置 1 会造成"看门狗已开"的误解；阶段 4/8 实现后再改 1（= PROMPT §7.1-E 取值）
#define WDT_TIMEOUT_S        10       // 看门狗超时(s)（★ 必须大于屏幕单帧最坏耗时；
                                      //   PROMPT 写 30s，本工程取 10s 的理由见 docs/阶段2 第 6 节）
#define ALARM_PITCH_DEG      3.0f     // 倾角告警：|pitch| 或 |roll| 超过 3° 置 alarm
#define ALARM_TEMP_HI_C      45.0f    // 高温告警
#define ALARM_TEMP_LO_C      -10.0f   // 低温告警
#define ALARM_HUMI_HI_PCT    95.0f    // 高湿告警
#define ALARM_LOWPOWER_V     3.3f     // 电池低压告警(V)（按实际电池类型改）
#define SLEEP_ENABLE         0        // 1=启用 deep-sleep 省电（★ 与屏幕/姿态显示互斥）
#define SLEEP_PERIOD_S       600      // 睡眠周期 600s = 10min（官方实测约 2.4mA 平均电流）
#define SLEEP_WAKE_GPIO      PIN_DTU_RDY // 唤醒引脚（RDY 变化即唤醒）；-1 = 仅定时唤醒

/* ---- ★ PROMPT §7.1-E 逐项对照（同值别名 + 占位宏；本阶段全部不参与逻辑）---- */
#define ALARM_ENABLE         0        // 告警总开关：0 = 只计算不动作（预留）；1 = 触发后上报/屏幕告警
#define ALARM_TILT_DEG       ALARM_PITCH_DEG       // ★ PROMPT §7.1-E 名字（= 3.0f）
#define ALARM_TEMP_HIGH_C    ALARM_TEMP_HI_C       // = 45.0f
#define ALARM_TEMP_LOW_C     ALARM_TEMP_LO_C       // = -10.0f
#define ALARM_HUMI_HIGH_PCT  ALARM_HUMI_HI_PCT     // = 95.0f
#define ALARM_BATT_LOW_MV    3300     // 电池低压告警(mV)，与 ALARM_LOWPOWER_V(3.3V) 同义
                                      // ★ 与 PROMPT 写的 3400 差 100mV：本工程以既有 3.3V 为准
                                      //   （告警尚未启用，不影响任何行为，已记录在 docs/阶段2 文档）
#define PWR_SAVE_ENABLE      SLEEP_ENABLE          // ★ PROMPT §7.1-E 名字（= SLEEP_ENABLE = 0）
#define PWR_SLEEP_AFTER_MS   0        // 空闲多久进休眠(ms)；0 = 不自动睡
#define PWR_GPS_OFF_WHEN_IDLE 0       // 空闲时是否给 GPS 断电（官方命令 GpsSetPower）
#define PWR_LED_OFF_ENABLE   0        // 是否关掉板载 LED（官方命令 PerSetLedSta）
#define DTU_RST_ON_HANG_ENABLE 0      // 1=长时间无网络自动复位 DTU（阶段 4 才可能启用）
#define DTU_HANG_TIMEOUT_MS  600000UL // 判定「DTU 卡死」的时长：10 分钟

/* ============================================================================
 * 14. ★ 传感器与 I2C 总线参数（PROMPT §7.1-D 要求的"集中在此"）
 * ----------------------------------------------------------------------------
 *  这些宏原来写在 main.ino 的「2. 引脚定义 / 3. 运行参数」里，
 *  阶段 2 统一搬到这里。**只搬家、不改值**，保证行为与原工程完全一致。
 *  ★ 命名对照：PROMPT §7.1-D 写的是 I2C_SDA / I2C_SCL，
 *    本工程沿用老工程名 PIN_I2C_SDA / PIN_I2C_SCL（见第 1 节），语义完全相同。
 *  ★ 仍留在 main.ino 的（属"驱动内部常量"，不是"会变的量"）：
 *    SERIAL_BAUD、AHT30 命令字/状态位、MPU6050 寄存器地址、上电稳定时间、重试次数。
 * ============================================================================ */
#define I2C_CLOCK_HZ         400000UL // I2C 速率 400kHz（AHT30 与 MPU6050 都支持快速模式）
#define I2C_TIMEOUT_MS       50       // I2C 单次事务超时(ms)：器件不在线时不会死等
#define AHT30_ADDR           0x38     // AHT30 固定地址（7 位）
#define MPU6050_ADDR         0x68     // MPU6050 的 AD0 接地时为 0x68（最常见）
#define MPU6050_ADDR_ALT     0x69     // MPU6050 的 AD0 接 VCC 时为 0x69（程序自动试）
#define MPU_ACCEL_FS_SEL     0        // 加速度量程：0=±2g 1=±4g 2=±8g 3=±16g
#define MPU_GYRO_FS_SEL      0        // 陀螺量程：0=±250°/s 1=±500 2=±1000 3=±2000
#define MPU_ACCEL_LSB_PER_G  16384.0f // 灵敏度，对应 FS_SEL=0（±2g）
#define MPU_GYRO_LSB_PER_DPS 131.0f   // 灵敏度，对应 FS_SEL=0（±250°/s）

#endif /* APP_CONFIG_H */


