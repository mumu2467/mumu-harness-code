// ============================================================================
//  User_Setup_ST7789_ESP32S3.h
//  TFT_eSPI 配置参考文件（ESP32-S3 + ST7789 240x320 SPI 彩屏，竖屏）
//  项目：esp32-0920-aht30-mpu6050（AHT30 + MPU6050 + 飞机水平仪 ADI UI）
// ----------------------------------------------------------------------------
//  【什么时候需要这个文件】
//    · 用 PlatformIO（VSCode）→ **不需要**！platformio.ini 的 build_flags 里已经
//      配好了下面这一整套宏，直接 pio run 即可。
//    · 用 Arduino IDE → **必须**：Arduino IDE 拿不到 build_flags，TFT_eSPI 的
//      "驱动型号 + 引脚" 必须在编译"库源码"时就能看到，所以只能改库里的 User_Setup.h。
//
//  【Arduino IDE 用法（3 步）】
//    1) 打开库目录：
//         Windows: 文档\Arduino\libraries\TFT_eSPI\
//         macOS  : ~/Documents/Arduino/libraries/TFT_eSPI/
//       （没装库就在这里装：库管理器搜索 "TFT_eSPI" → 安装 2.5.43）
//    2) 把原来的 User_Setup.h 改名备份为 User_Setup.h.bak
//    3) 新建（或覆盖）User_Setup.h，把下面「内容开始 ~ 内容结束」之间的内容
//       全部复制进去 → 保存 → 重新编译上传
//
//  【本工程实际接线（与 README 第十二节一致）】
//     ST7789        ESP32-S3        说明
//     GND           GND
//     VCC           3V3             必须是 3.3V
//     SCL / SCK     GPIO21          SPI 时钟   ★ 注意：GPIO21 不是本工程的 I2C
//     SDA / MOSI    GPIO47          SPI 数据（只写）   （本工程 I2C 用 GPIO8/9）
//     RES / RST     GPIO45          复位（GPIO45 是 strapping 脚，见文末提醒）
//     DC / RS       GPIO40          命令/数据选择
//     CS            GPIO41          片选
//     BLK / LED     GPIO42          背光，高电平点亮（程序用 LEDC PWM 调光）
//     MISO          ——不接          本工程不读屏
// ============================================================================


// ==================== 内容开始（全部复制到 User_Setup.h）====================

#define USER_SETUP_INFO "ST7789 240x320 ESP32-S3 (SCLK21 MOSI47 CS41 DC40 RST45 BL42)"

// ① 驱动与分辨率
#define ST7789_DRIVER          // ST7789 驱动（2.0"/1.9" 240x320 IPS）
//#define ILI9341_DRIVER       // 若你的屏其实是 ILI9341：注释上面一行，打开这一行
#define TFT_WIDTH  240         // 竖屏宽
#define TFT_HEIGHT 320         // 竖屏高

// ② 引脚映射（严格对应上面的接线表）
#define TFT_MISO -1            // 不读屏，不接 MISO（填 -1 最省事）
#define TFT_MOSI 47            // 屏 SDA / MOSI
#define TFT_SCLK 21            // 屏 SCL / SCK
#define TFT_CS   41            // 屏 CS（无 CS 的 6 线模组改成 -1）
#define TFT_DC   40            // 屏 DC / RS
#define TFT_RST  45            // 屏 RES / RST

// ③ 背光（GPIO42，高电平点亮）
//    说明：TFT_eSPI 初始化时会把它拉高（保证上电就亮），之后程序用 LEDC PWM 接管调光
#define TFT_BL   42
#define TFT_BACKLIGHT_ON HIGH

// ④ ★★★ ESP32-S3 必须加这一行 ★★★
//    原因：ESP32-S3 的 soc.h 里 REG_SPI_BASE(i) 只有 i>=2 才是有效基址（GPIO 矩阵的
//    GPSPI2/GPSPI3），而 TFT_eSPI 2.5.43 在 S3 上默认把端口写成 FSPI(=1)，
//    于是所有 SPI 寄存器地址退化成 0x00/0x10/0x1C/0x98 → tft.init() 第一次写寄存器就
//    Guru Meditation (StoreProhibited, EXCVADDR=0x10)，表现为"背光亮、屏全黑"。
//    定义 USE_FSPI_PORT 后端口固定为 2(SPI2)，寄存器基址恢复成 0x60024000，与
//    Arduino 的 SPI 对象一致。（等价写法：改成 #define USE_HSPI_PORT，走 SPI3）
#define USE_FSPI_PORT

// ⑤ 字体（按需开启，少开省 Flash）
#define LOAD_GLCD             // 8px  基础字体（本工程用于状态行）
#define LOAD_FONT2            // 16px 字体（角标/刻度数字/状态）
#define LOAD_FONT4            // 26px 字体（温湿度大数字）
//#define LOAD_GFXFF          // 不需要 FreeFont 就别开（省 Flash）
//#define SMOOTH_FONT         // 不需要平滑字体就别开

// ⑥ SPI 速率：ST7789 一般能稳跑 40MHz；花屏/闪屏/噪点就降到 27000000
#define SPI_FREQUENCY       40000000
#define SPI_READ_FREQUENCY  20000000

// ⑦ 颜色顺序与反显
#define TFT_INVERSION_ON      // 颜色像"照片底片"时保留；正常就注释掉
//#define TFT_RGB_ORDER TFT_BGR   // 红蓝互换时打开（默认 TFT_RGB）

// ==================== 内容结束 ====================


// ----------------------------------------------------------------------------
//  【排错备忘录】
//    1. 背光亮、屏全黑 → 99% 是缺 USE_FSPI_PORT（上面 ④），或 SCL/MOSI 接反、
//       DC/RST/CS 漏接错位（按板子丝印逐根核对）。若串口出现
//       "Guru Meditation ... EXCVADDR: 0x00000010" 就是没加 USE_FSPI_PORT。
//    2. 花屏/闪烁/有条纹 → SPI_FREQUENCY 降到 27000000，杜邦线尽量短并共地。
//    3. 颜色反相（黑变白/发灰）→ 去掉/加上 TFT_INVERSION_ON。
//    4. 红蓝互换 → 打开 TFT_RGB_ORDER TFT_BGR。
//    5. 上半屏/下半屏错位 1~2px → 用 tft.setViewport() 微调，或工程里改
//       UI_X_OFFSET / UI_Y_OFFSET（app_config.h）。
//    6. 背光不亮 → 确认 BLK 接在 GPIO42；若模块是**低电平点亮**，把
//       TFT_BACKLIGHT_ON 改成 LOW，并把 app_config.h 的 BL_PWM_INVERT 设为 1。
//    7. 上电不启动 / 反复重启 / 烧录失败 → GPIO45 是 S3 strapping 脚（VDD_SPI 选择），
//       若屏模块在这根线上带了 3.3V 上拉就会把 VDD_SPI 选成 1.8V；处理办法：
//       ① 在 GPIO45 与 GND 之间加 10kΩ 下拉；② 把 RES 改到 GPIO38；
//       ③ 或把 TFT_RST 设为 -1 不接 RES（用软复位）。
//    8. ESP32-S3 用 FSPI(SPI2) 控制器，不需要定义 USE_HSPI_PORT（除非上面 ④ 用了它）。
// ----------------------------------------------------------------------------
