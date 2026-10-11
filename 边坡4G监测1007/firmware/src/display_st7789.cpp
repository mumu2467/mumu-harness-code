/* ============================================================================
 *  display_st7789.cpp —— ST7789 240x320 显示驱动 + 飞机水平仪 UI 实现
 *  项目：esp32-0920 AHT30 + MPU6050 + ST7789 彩屏
 * ----------------------------------------------------------------------------
 *  ★ 与 TFT_eSPI 配置有关的三个坑（务必先看 README 第十二节）：
 *    1) ESP32-S3 必须在编译宏里加 USE_FSPI_PORT（或 USE_HSPI_PORT），
 *       否则 TFT_eSPI 会把 SPI 寄存器地址算成 0x00~0x98，tft.init() 直接崩。
 *       本工程已写在 platformio.ini / User_Setup_ST7789_ESP32S3.h 里。
 *    2) 引脚/驱动型号必须通过编译宏传给「库源码」，所以要么用 platformio.ini
 *       的 build_flags，要么改 TFT_eSPI 库里的 User_Setup.h（不能只在本文件改）。
 *    3) 背光脚 TFT_eSPI 会在 init() 里先拉高，之后由本文件的 LEDC 接管做 PWM 调光。
 * ----------------------------------------------------------------------------
 *  绘制流程（20FPS，每帧 ≤50ms）：
 *    drawAdiLayer(spr)（天空/地面→地平线→俯仰刻度→横滚刻度→飞机→数值框）
 *      → spr.pushSprite(0,0)（一次 SPI 传输，240x240x2B ≈ 115KB）
 *      → 帧率统计
 * ============================================================================ */

#include "display_st7789.h"
#include "app_config.h"
#include <math.h>

#if UI_ENABLE

/* ============================ 1. 全局对象与状态 ============================ */

static TFT_eSPI  tft = TFT_eSPI();                         // 屏幕对象
#if UI_USE_SPRITE
static TFT_eSprite spr = TFT_eSprite(&tft);                // 离屏画布（240x240）
#endif
static bool      gSpriteReady = false;                     // 离屏画布是否创建成功
static uint8_t   gRotation    = (uint8_t)UI_ROTATION;       // 当前屏幕方向（可用串口 'r' 运行期切换）
static bool      gPixelGrad   = (UI_PIXEL_GRADIENT != 0);   // 天空/地面填充方式（串口 'g' 可切换）
static uint8_t   gBlLevel     = 0;                         // 当前背光占空比 0~255
static bool      gBlInited    = false;                     // LEDC 是否已初始化
static bool      gMpuOk       = false;                     // MPU6050 在线（状态点用）
static bool      gAhtOk       = false;                     // AHT30  在线（状态点用）
static bool      gEnvDrawn    = false;                     // 底部温湿度区静态底图是否画过
static float     gLastTemp    = -999.0f;                   // 上一次显示的温湿度（用于"只变化才重绘"）
static float     gLastHumi    = -999.0f;
static bool      gLastAhtOk   = false;
static float     gFps         = 0.0f;                      // 最近 1 秒实测帧率
static uint32_t  gFpsCnt      = 0;                         // 本秒内帧数
static uint32_t  gFpsStamp    = 0;                         // 本秒起点
static uint32_t  gLastFrameUs = 0;                         // 最近一帧耗时(us)
static uint16_t  gSlowFrames  = 0;                         // 超时帧计数
static uint16_t  gSkyLut[LUT_STEPS];                       // 天空渐变查表（近地平线 → 远端）
static uint16_t  gGndLut[LUT_STEPS];                       // 地面渐变查表

static void drawEnvPanelBase(void);                        // 前置声明（温湿度区静态底图）

/* ============================ 2. 小工具 ============================ */

/* RGB565 线性插值：t=0 取 a，t=1 取 b（用于渐变查表） */
static uint16_t lerp565(uint16_t a, uint16_t b, float t) {
  const int ar = (a >> 11) & 0x1F, ag = (a >> 5) & 0x3F, ab = a & 0x1F;
  const int br = (b >> 11) & 0x1F, bg = (b >> 5) & 0x3F, bb = b & 0x1F;
  const float k = (t < 0.0f) ? 0.0f : ((t > 1.0f) ? 1.0f : t);
  const int r = ar + (int)((br - ar) * k + 0.5f);
  const int g = ag + (int)((bg - ag) * k + 0.5f);
  const int bl = ab + (int)((bb - ab) * k + 0.5f);
  return (uint16_t)((r << 11) | (g << 5) | bl);
}

/* 把"到地平线的距离"换算成渐变表索引（带上下限保护，异常值也不会越界读表） */
static inline int gradIndex(float absDist, float scale) {
  int idx = (int)(absDist * scale);
  if (idx < 0) {
    idx = 0;
  } else if (idx > LUT_STEPS - 1) {
    idx = LUT_STEPS - 1;
  }
  return idx;
}

/* 预算天空/地面渐变表：索引 0 = 贴近地平线（亮），末索引 = 远端（暗）
 * 好处：每帧只做"距离→查表"，省掉几万次浮点插值运算。
 * ★ GRAD_MIX 控制"最深能到多深"：0 = 完全不渐变（天空/地面各一块纯色），
 *   1 = 一直渐变到 C_SKY_FAR/C_GND_FAR 那么深。默认 0.45 → 观感上就是"天蓝 + 棕色两块"，
 *   只在远离地平线的方向稍微变深，不会花。 */
static void lutInit(void) {
  const uint16_t skyFar = lerp565(C_SKY_NEAR, C_SKY_FAR, GRAD_MIX);
  const uint16_t gndFar = lerp565(C_GND_NEAR, C_GND_FAR, GRAD_MIX);

  for (int i = 0; i < LUT_STEPS; i++) {
    const float t = (float)i / (float)(LUT_STEPS - 1);
    gSkyLut[i] = lerp565(C_SKY_NEAR, skyFar, t);
    gGndLut[i] = lerp565(C_GND_NEAR, gndFar, t);
  }
}

/* ============================ 3. 背光（LEDC PWM） ============================
 *  GPIO42 = BLK。TFT_eSPI 的 init() 会先把它当普通输出拉高（保证上电就亮），
 *  之后我们用 LEDC 接管同一个引脚做 PWM 调光。
 *  API 兼容性：Arduino-ESP32 core 2.x = ledcSetup + ledcAttachPin + ledcWrite(ch, duty)
 *              Arduino-ESP32 core 3.x = ledcAttach(pin, freq, res) + ledcWrite(pin, duty)
 * ======================================================================== */
static void backlightInit(void) {
  if (gBlInited) {
    return;
  }
#if defined(ESP_ARDUINO_VERSION_MAJOR) && (ESP_ARDUINO_VERSION_MAJOR >= 3)
  ledcAttach(PIN_LCD_BLK, BL_PWM_FREQ, BL_PWM_RES_BITS);
#else
  ledcSetup(BL_PWM_CHANNEL, BL_PWM_FREQ, BL_PWM_RES_BITS);
  ledcAttachPin(PIN_LCD_BLK, BL_PWM_CHANNEL);
#endif
  gBlInited = true;
}

void setBacklight(uint8_t level) {
  backlightInit();
  gBlLevel = level;

  /* 低电平点亮的模组（BL_PWM_INVERT=1）：把占空比取反，
   * 这样对外接口的含义仍然是"level 越大越亮"，用户不用改调用代码 */
  uint32_t duty = BL_PWM_INVERT ? (uint32_t)(255u - level) : (uint32_t)level;

#if defined(ESP_ARDUINO_VERSION_MAJOR) && (ESP_ARDUINO_VERSION_MAJOR >= 3)
  ledcWrite(PIN_LCD_BLK, duty);
#else
  ledcWrite(BL_PWM_CHANNEL, duty);
#endif
}

void setBacklightPercent(uint8_t percent) {
  if (percent > 100) {
    percent = 100;
  }
  /* 255 * percent / 100，用整数避免浮点 */
  setBacklight((uint8_t)(((uint32_t)255 * percent) / 100U));
}

uint8_t getBacklight(void) {
  return gBlLevel;
}

/* ============================ 4. 初始化 ============================ */

bool dispInit(void) {
  /* ---- 4.1 屏驱动初始化 ---- */
  tft.init();                       // ST7789 上电序列（会顺带把 BLK 拉高）
  tft.setRotation(gRotation);       // 0=竖屏 240x320（可用串口 'r' 运行期切换）
  tft.fillScreen(TFT_BLACK);
  tft.setTextWrap(false);
  lutInit();

  /* ---- 4.2 背光 PWM 接管（默认 80%） ---- */
  backlightInit();
  setBacklightPercent(BL_DEFAULT_LEVEL);

  /* ---- 4.3 创建离屏画布 ---- */
#if UI_USE_SPRITE
  spr.setColorDepth(UI_SPRITE_DEPTH);
  void *p = spr.createSprite(ADI_W, ADI_H);
  gSpriteReady = (p != nullptr);
  if (gSpriteReady) {
    spr.fillSprite(TFT_BLACK);
    spr.setTextWrap(false);
  } else {
    cfgStatusf("DISPLAY: sprite alloc failed (%d bytes) -> direct draw mode",
               (int)(ADI_W * ADI_H * (UI_SPRITE_DEPTH / 8)));
  }
#else
  gSpriteReady = false;
#endif

  /* ---- 4.4 底部温湿度区静态底图（先画好，开屏期间底部也是完整的） ---- */
  drawEnvPanelBase();

  return true;
}

bool dispSpriteReady(void) {
  return gSpriteReady;
}

uint32_t dispFreeHeap(void)    { return (uint32_t)ESP.getFreeHeap(); }
uint8_t  dispGetRotation(void) { return gRotation; }

/* 运行期切换屏幕方向（0~3）：设置 → 清屏 → 重画温湿度区底图 →
 * 姿态层下一帧会自己重画；用于串口 'r' 命令现场试方向。 */
/* 天空/地面填充方式切换（串口 'g'）：两种方式逐帧对比，选出看着舒服的那个 */
bool dispGetGradient(void) { return gPixelGrad; }

void dispToggleGradient(void) {
  gPixelGrad = !gPixelGrad;
  cfgStatusf("DISPLAY: sky/ground fill = %s  (0=row based, 1=per pixel)",
             gPixelGrad ? "per-pixel" : "row-based");
}

void dispSetRotation(uint8_t rot) {
  gRotation = (uint8_t)(rot & 0x03);
  tft.setRotation(gRotation);
  tft.fillScreen(TFT_BLACK);

  gEnvDrawn  = false;      // 让温湿度底图按新方向重画
  gLastTemp  = -999.0f;
  gLastHumi  = -999.0f;
  drawEnvPanelBase();

  if (gSpriteReady) {      // 姿态层先清黑，避免残留旧方向的内容
    spr.fillSprite(TFT_BLACK);
  }

  cfgStatusf("DISPLAY: rotation -> %u (0/2=portrait 240x320, 1/3=landscape 320x240)",
             (unsigned)gRotation);
}
float    dispFps(void)         { return gFps; }
uint32_t dispLastFrameUs(void) { return gLastFrameUs; }
uint16_t dispSlowFrames(void)  { return gSlowFrames; }

/* ============================ 5. 配置打印（排错第一站） ============================ */
void dispPrintConfig(void) {
  uint16_t w = tft.width(), h = tft.height();

  cfgStatusLine("---------------------------------------------------");
  cfgStatusLine("Display: ST7789 240x320 SPI (portrait) BTW: see README sec.12");
  cfgStatusf("Display: panel %ux%u  rotation=%d  SPI=%dMHz  inversion=%s",
             (unsigned)w, (unsigned)h, (int)gRotation,
             (int)(SPI_FREQUENCY / 1000000UL),
#if defined(TFT_INVERSION_ON)
             "ON"
#else
             "OFF"
#endif
  );
  cfgStatusf("Display: pins SCLK=%d MOSI=%d CS=%d DC=%d RST=%d BL=%d MISO=%d",
             (int)TFT_SCLK, (int)TFT_MOSI, (int)TFT_CS, (int)TFT_DC,
             (int)TFT_RST, (int)PIN_LCD_BLK,
#if defined(TFT_MISO)
             (int)TFT_MISO
#else
             -1
#endif
  );
  cfgStatusf("Display: ADI %dx%d  bottom %d..%d  PX_PER_DEG=%.1f  fps target=%.0f",
             (int)ADI_W, (int)ADI_H, (int)ENV_Y, (int)(ENV_Y + ENV_H - 1),
             (double)PX_PER_DEG, 1000.0 / (double)DISP_PERIOD_MS);
  cfgStatusf("Display: sprite=%s (%d B)  backlight=GPIO%d %d%% (LEDC %dkHz %dbit)",
             gSpriteReady ? "ON" : "OFF(direct draw)",
             (int)(ADI_W * ADI_H * (UI_SPRITE_DEPTH / 8)),
             (int)PIN_LCD_BLK, (int)BL_DEFAULT_LEVEL,
             (int)(BL_PWM_FREQ / 1000), (int)BL_PWM_RES_BITS);
  cfgStatusf("Display: free heap=%u B", (unsigned)dispFreeHeap());
  cfgStatusLine("---------------------------------------------------");
}

/* ============================ 6. 开机画面（含屏幕方向标记） ============================
 *  画面里刻意放了方向标记，方便一眼看出屏幕方向对不对：
 *    · 大号 "UP" 必须出现在**你看到的正上方**；四角有 1(左上) 2(右上) 3(左下) 4(右下) 编号；
 *    · "UP" 不在上面 / 编号顺序不对 → 改 app_config.h 的 UI_ROTATION，或串口敲 'r' 现场试。
 *  只画姿态仪区（0..239），底部温湿度区由 dispInit() 预先画好，不会被擦掉。
 * ============================================================================ */
void dispDrawBoot(void) {
  char buf[44];

  tft.fillRect(0, 0, ADI_W, ADI_H, TFT_BLACK);   // 只清姿态仪区

  /* ---- 方向标记 ---- */
  tft.setTextDatum(MC_DATUM);
  tft.setTextFont(FONT_BIG);
  tft.setTextColor(C_ACCENT, TFT_BLACK);
  tft.drawString("UP", SCR_W / 2, 30);

  tft.setTextFont(1);
  tft.setTextColor(C_DIM, TFT_BLACK);
  tft.setTextDatum(TL_DATUM); tft.drawString("1", 6, 6);
  tft.setTextDatum(TR_DATUM); tft.drawString("2", SCR_W - 6, 6);
  tft.setTextDatum(BL_DATUM); tft.drawString("3", 6, 236);
  tft.setTextDatum(BR_DATUM); tft.drawString("4", SCR_W - 6, 236);

  /* ---- 参数与提示 ---- */
  tft.setTextDatum(MC_DATUM);
  tft.setTextFont(FONT_SMALL);
  snprintf(buf, sizeof(buf), "rotation=%u  (UI_ROTATION)", (unsigned)gRotation);
  tft.setTextColor(C_TEXT, TFT_BLACK);
  tft.drawString(buf, SCR_W / 2, 58);

  tft.setTextColor(C_DIM, TFT_BLACK);
  tft.drawString("ST7789 240x320 ADI + AHT30", SCR_W / 2, 80);
  tft.drawString("I2C  SDA=8 SCL=9", SCR_W / 2, 98);
  tft.drawString("LCD  SCLK=21 MOSI=47", SCR_W / 2, 116);
  tft.drawString("     CS=41 DC=40 RST=45", SCR_W / 2, 134);

  tft.setTextColor(C_OK, TFT_BLACK);
  tft.drawString("display ok, init sensors ...", SCR_W / 2, 156);
  tft.setTextColor(C_DIM, TFT_BLACK);
  tft.drawString("keep still for calibration", SCR_W / 2, 176);

  tft.setTextColor(C_ERR, TFT_BLACK);
  tft.drawString("UP not on top / 1-2-3-4 wrong?", SCR_W / 2, 200);
  tft.drawString("-> UI_ROTATION 0<->2 (or 1/3)", SCR_W / 2, 218);

  tft.setTextDatum(TL_DATUM);
}

/* ============================ 7. 校准画面（非阻塞，可反复调用） ============================
 *  .ino 在 ST_CALIB 状态里每 ~100ms 调一次，画进度条与提示，期间主循环照常跑（无 delay）。
 *  画面只覆盖姿态仪区（0..239）：校准一结束就会被第一帧姿态仪画面覆盖掉，
 *  底部温湿度区（240..319）始终保留，不会被"擦掉"。
 * ============================================================================ */
void dispDrawCalib(uint8_t percent, float spanDps) {
  static uint8_t lastPct  = 255;
  static bool    cleared  = false;
  char buf[40];

  if (percent > 100) {
    percent = 100;
  }

  /* 第一次进入：把姿态仪区刷黑，避免与开机画面文字重叠 */
  if (!cleared) {
    cleared = true;
    tft.fillRect(0, 0, ADI_W, ADI_H, TFT_BLACK);
    cfgStatusLine("CALIB  : on screen - progress bar + gyro span");
  }

  if (percent != lastPct) {
    lastPct = percent;

    /* 标题 + 进度条 */
    tft.setTextDatum(MC_DATUM);
    tft.setTextFont(FONT_SMALL);
    tft.setTextColor(C_TEXT, TFT_BLACK);
    snprintf(buf, sizeof(buf), "CALIBRATING %u%%", (unsigned)percent);
    tft.drawString(buf, SCR_W / 2, 150);

    const int bx = 30, by = 172, bw = SCR_W - 60, bh = 14;
    tft.drawRect(bx, by, bw, bh, C_BORDER);
    const int fill = (bw - 2) * (int)percent / 100;
    tft.fillRect(bx + 1, by + 1, fill, bh - 2, C_ACCENT);
    tft.fillRect(bx + 1 + fill, by + 1, (bw - 2) - fill, bh - 2, C_PANEL);
    tft.setTextDatum(TL_DATUM);
  }

  /* 实时提示（角速度波动值），让用户知道"有没有在动" */
  tft.fillRect(0, 196, SCR_W, 20, TFT_BLACK);
  tft.setTextFont(FONT_SMALL);
  tft.setTextColor((spanDps < CALIB_MAX_SPAN_DPS) ? C_OK : C_ERR, TFT_BLACK);
  snprintf(buf, sizeof(buf), "gyro span %.2f dps - keep still", (double)spanDps);
  tft.setTextDatum(MC_DATUM);
  tft.drawString(buf, SCR_W / 2, 204);
  tft.setTextDatum(TL_DATUM);
  tft.setTextColor(C_TEXT);
}

/* ============================ 8. 文字格式化小工具（不用 %f） ============================
 *  .ino 里已有 fmtFixed()（把"放大 10^n 倍的整数"插小数点），这里给屏幕用两个简化版，
 *  好处：不依赖 %f 浮点 printf，显示位数绝对可控。
 * ==================================================================================== */

/* 带符号小数：v10 = 实际值×10，例如 -123 → "-12.3"，56 → "+5.6" */
static void fmtSigned1(char *dst, size_t size, int32_t v10) {
  const char c = (v10 < 0) ? '-' : '+';
  int32_t    a = (v10 < 0) ? -v10 : v10;
  snprintf(dst, size, "%c%ld.%01ld", c, (long)(a / 10), (long)(a % 10));
}

/* 无符号前缀小数：v10 = 实际值×10，例如 253 → "25.3"，-50 → "-5.0" */
static void fmtPlain1(char *dst, size_t size, int32_t v10) {
  const bool neg = (v10 < 0);
  int32_t    a   = neg ? -v10 : v10;
  snprintf(dst, size, "%s%ld.%01ld", neg ? "-" : "", (long)(a / 10), (long)(a % 10));
}

/* 带符号 2 位小数：v100 = 实际值×100，例如 99 → "+0.99"（自检画面看加速度用） */
static void fmtSigned2(char *dst, size_t size, int32_t v100) {
  const char c = (v100 < 0) ? '-' : '+';
  int32_t    a = (v100 < 0) ? -v100 : v100;
  snprintf(dst, size, "%c%ld.%02ld", c, (long)(a / 100), (long)(a % 100));
}

/* ============================ 9. 姿态仪绘制（核心） ============================
 *  坐标数学（公式写清楚，方便写报告/答辩）：
 *    roll = φ（右倾为正）、pitch = θ（抬头为正）
 *    地平线「法向量」（由地平线指向地面一侧；屏幕坐标 y 向下）：
 *        n = ( sin φ ,  cos φ )
 *    地平线上一点（含俯仰平移；抬头时地平线整体下移，形成"飞机不动、世界动"的观感）：
 *        P0 = 中心 + θ · PX_PER_DEG · n
 *    地平线方向（与 n 垂直的单位向量）：
 *        t = ( cos φ , -sin φ )
 *    任意像素到地平线的有符号距离：
 *        d = (x - P0x)·nx + (y - P0y)·ny      d > 0 → 地面侧；d < 0 → 天空侧
 *    俯仰刻度线（±10/20/30°）画在距地平线 d = 刻度值·PX_PER_DEG 处（抬头刻度在 -n 一侧）
 *  实现要点（v2，已消除"条带/方块"）：
 *    · 天空/地面**逐像素**计算颜色并直接写入 Sprite 帧缓冲（16bpp）→ 渐变连续、地平线边缘
 *      是干净的斜线，左右摆动时不会再出现方块/横条；
 *    · 若 Sprite 不可用（内存不足）或色深不是 16bpp，退回"逐行分段"填色（分段数随 roll 自适应）；
 *    · 其余元素（地平线/刻度/飞机符号/数值框）用正常绘制 API 画在渐变之上；
 *    · 全部先画在 Sprite 上，最后一次性 pushSprite，避免闪烁。
 * ============================================================================ */

/* ---- 9.1 天空/地面：逐像素填充（Sprite 专用，最快也最平滑）
 *  颜色只取决于"该像素到地平线的有符号距离" d，而 d 沿 x 方向是线性变化的
 *  （每向右 1 像素增加 nx），所以内层循环只做一次加法就能递推，开销极小。 */
static void fillSkyGroundPixels(float nx, float ny, float hx, float hy, float scale) {
#if (UI_SPRITE_DEPTH == 16)
  uint16_t *buf = (uint16_t *)spr.getPointer();
  if (buf == nullptr) {
    return;
  }
  for (int y = 0; y < ADI_H; y++) {
    const float dy = ((float)y + 0.5f) - hy;
    float d = (0.5f - hx) * nx + dy * ny;          // x=0 处的有符号距离
    uint16_t *row = buf + (size_t)y * (size_t)ADI_W;

    for (int x = 0; x < ADI_W; x++, d += nx) {
      const int idx = gradIndex(fabsf(d), scale);  // 距离 → 渐变表索引（带保护）
      row[x] = (d >= 0.0f) ? gGndLut[idx] : gSkyLut[idx];
    }
  }
#else
  (void)nx; (void)ny; (void)hx; (void)hy; (void)scale;   // 8bpp 时不用这条路径
#endif
}

/* ---- 9.2 天空/地面：逐行分段填充（直接绘制 / 非 16bpp 时的回退）
 *  分段宽度随 |sin(roll)| 自适应：roll=0 时整行同色（1 段），roll 越大横向色差越快 → 分得越细；
 *  如果某一段正好被地平线切开，就按线性插值求出交叉像素，分成两段分别填色（边缘不会锯齿成方块）。 */
template <typename G>
static void fillSkyGroundRows(G &g, float nx, float ny, float hx, float hy, float scale) {
  const float anx = fabsf(nx);
  const int   segW = (anx > 0.25f) ? 8 : ((anx > 0.08f) ? 16 : ADI_W);
  const int   idxMax = LUT_STEPS - 1;

  for (int y = 0; y < ADI_H; y++) {
    const float dy = ((float)y + 0.5f) - hy;

    for (int sx = 0; sx < ADI_W; sx += segW) {
      int ex = sx + segW - 1;
      if (ex > ADI_W - 1) {
        ex = ADI_W - 1;
      }

      const float ds = ((float)sx + 0.5f - hx) * nx + dy * ny;
      const float de = ((float)ex + 0.5f - hx) * nx + dy * ny;

      if ((ds < 0.0f) != (de < 0.0f)) {
        /* 被地平线切开 → 求交叉像素 xci，左右两半各自填色 */
        const float denom = ds - de;
        int xci = (fabsf(denom) > 1e-6f)
                    ? (int)lroundf((float)sx + (float)(ex - sx) * (ds / denom))
                    : ((sx + ex) >> 1);
        if (xci < sx) xci = sx;
        if (xci > ex) xci = ex;

        const float dm = ((float)((sx + xci) >> 1) + 0.5f - hx) * nx + dy * ny;
        const int   i1 = gradIndex(fabsf(dm), scale);
        if (xci > sx) {
          g.drawFastHLine(sx, y, xci - sx, (dm >= 0.0f) ? gGndLut[i1] : gSkyLut[i1]);
        }

        const float dn = ((float)((xci + ex) >> 1) + 0.5f - hx) * nx + dy * ny;
        const int   i2 = gradIndex(fabsf(dn), scale);
        g.drawFastHLine(xci, y, ex - xci + 1, (dn >= 0.0f) ? gGndLut[i2] : gSkyLut[i2]);
      } else {
        const float dm = ((float)((sx + ex) >> 1) + 0.5f - hx) * nx + dy * ny;
        const int   idx = gradIndex(fabsf(dm), scale);
        g.drawFastHLine(sx, y, ex - sx + 1, (dm >= 0.0f) ? gGndLut[idx] : gSkyLut[idx]);
      }
    }
  }
}

/* ---- 9.25 地平线几何（两个路径共用，避免重复算三角函数） ---- */
static void adiGeometry(float pitchDeg, float rollDeg,
                        float *nx, float *ny, float *hx, float *hy, float *scale) {
  const float rr = rollDeg * DEG_TO_RAD;
  *nx = sinf(rr);                                      // 法向 X
  *ny = cosf(rr);                                      // 法向 Y
  *hx = ADI_CX + pitchDeg * PX_PER_DEG * (*nx);        // 地平线上一点
  *hy = ADI_CY + pitchDeg * PX_PER_DEG * (*ny);
  *scale = (float)(LUT_STEPS - 1) / GRAD_MAX_DIST;     // 距离 → 渐变表索引
}

/* ---- 9.3 姿态仪其余元素（地平线 / 俯仰刻度 / 横滚刻度 / 飞机符号） ---- */
template <typename G>
static void drawAdiOverlay(G &g, float pitchDeg, float rollDeg) {
  const float rr = rollDeg * DEG_TO_RAD;
  const float nx = sinf(rr);          // 法向分量（指向地面）
  const float ny = cosf(rr);
  const float tx = cosf(rr);          // 地平线方向分量
  const float ty = -sinf(rr);
  const float hx = ADI_CX + pitchDeg * PX_PER_DEG * nx;   // 地平线上一点 P0
  const float hy = ADI_CY + pitchDeg * PX_PER_DEG * ny;

  /* ---- ② 白色地平线（画两条，形成 2px 粗线） ---- */
  const float half = (float)(ADI_W + ADI_H);
  for (int k = 0; k < 2; k++) {
    const float ox = (float)k * nx;
    const float oy = (float)k * ny;
    g.drawLine((int)lroundf(hx + ox - tx * half), (int)lroundf(hy + oy - ty * half),
               (int)lroundf(hx + ox + tx * half), (int)lroundf(hy + oy + ty * half),
               C_HORIZON);
  }

  /* ---- ③ 俯仰刻度：每 10° 一条短横线 + 两端数字（±10/20/30） ---- */
  static const int   kDeg[6]  = {-30, -20, -10, 10, 20, 30};
  static const float kHalf[6] = {(float)LADDER_30_HALF, (float)LADDER_20_HALF, (float)LADDER_10_HALF,
                                 (float)LADDER_10_HALF, (float)LADDER_20_HALF, (float)LADDER_30_HALF};
  g.setTextFont(FONT_SMALL);
  g.setTextDatum(MC_DATUM);

  for (int i = 0; i < 6; i++) {
    const float d  = (float)kDeg[i];
    const float mx = hx - d * PX_PER_DEG * nx;    // 该刻度线中点（抬头刻度在地平线上方）
    const float my = hy - d * PX_PER_DEG * ny;

    g.drawLine((int)lroundf(mx - tx * kHalf[i]), (int)lroundf(my - ty * kHalf[i]),
               (int)lroundf(mx + tx * kHalf[i]), (int)lroundf(my + ty * kHalf[i]), C_LADDER);

    /* 数字画在刻度两端外侧；字保持直立（更易读），位置随姿态一起旋转/平移 */
    char nb[8];
    snprintf(nb, sizeof(nb), "%d", (kDeg[i] < 0) ? -kDeg[i] : kDeg[i]);
    for (int e = 0; e < 2; e++) {
      const float sH = e ? 1.0f : -1.0f;
      const float px = mx + sH * (kHalf[i] + 10.0f) * tx;
      const float py = my + sH * (kHalf[i] + 10.0f) * ty;
      const int   ix = (int)lroundf(px);
      const int   iy = (int)lroundf(py);

      g.setTextColor(C_PANEL);                     // 先画 1px 深色阴影（天空/地面上都看得清）
      g.drawString(nb, ix + 1, iy + 1);
      g.setTextColor(C_LADDER);
      g.drawString(nb, ix, iy);
    }
  }

  /* ---- ④ 顶部横滚刻度 + 随 roll 转动的指针 ---- */
  static const int kBank[7] = {-30, -20, -10, 0, 10, 20, 30};
  for (int i = 0; i < 7; i++) {
    const float a   = (-90.0f + (float)kBank[i]) * DEG_TO_RAD;
    const float c   = cosf(a);
    const float s2  = sinf(a);
    const bool  big = (kBank[i] == 0) || (kBank[i] == 30) || (kBank[i] == -30);
    const float rIn = big ? 100.0f : 107.0f;
    g.drawLine((int)lroundf(ADI_CX + c * rIn),   (int)lroundf(ADI_CY + s2 * rIn),
               (int)lroundf(ADI_CX + c * 116.0f), (int)lroundf(ADI_CY + s2 * 116.0f),
               big ? C_SCALE : C_BORDER);
  }

  /* 指针：三角形，尖端指向圆心；角度 = -90° + roll（右倾时指针向右偏） */
  {
    const float pa = (-90.0f + rollDeg) * DEG_TO_RAD;
    const float px = cosf(pa);
    const float py = sinf(pa);
    const float ax = ADI_CX + px * 99.0f;         // 尖端
    const float ay = ADI_CY + py * 99.0f;
    const float bx = ADI_CX + px * 116.0f;        // 底边中心
    const float by = ADI_CY + py * 116.0f;
    const float ux = -py;                         // 底边方向（与指向垂直）
    const float uy = px;
    g.fillTriangle((int)lroundf(ax), (int)lroundf(ay),
                   (int)lroundf(bx + ux * 7.0f), (int)lroundf(by + uy * 7.0f),
                   (int)lroundf(bx - ux * 7.0f), (int)lroundf(by - uy * 7.0f), C_ACCENT);
  }

  /* ---- ⑤ 固定飞机符号（琥珀色，不随姿态移动） ---- */
  {
    const int cx = (int)ADI_CX;
    const int cy = (int)ADI_CY;
    const int wing = 44, root = 11, drop = 10;
    g.fillRect(cx - wing,     cy - 2, wing - root, 4, C_AIRCRAFT);   // 左机翼
    g.fillRect(cx + root,     cy - 2, wing - root, 4, C_AIRCRAFT);   // 右机翼
    g.fillRect(cx - root,     cy - 2, 4, drop, C_AIRCRAFT);          // 左翼根下折
    g.fillRect(cx + root - 4, cy - 2, 4, drop, C_AIRCRAFT);          // 右翼根下折
    g.fillCircle(cx, cy + 4, 3, C_AIRCRAFT);                         // 中心点
  }
}

/* ============================ 10. 顶部数值框（不随姿态旋转） ============================
 *  左：俯仰角（P ±xx.x）；中：横滚角（ROLL ±xx.x）；右：传感器状态点（绿=在线 红=离线）
 *  用"圆角实心框 + 描边"做底，保证在天空/地面上都清晰可读。
 *  说明：内置字体只有 ASCII，所以用 "ROLL -12.3" 而不是 "ROLL -12.3°"，详见 README。
 * ============================================================================ */
template <typename G>
static void drawTopBoxes(G &g, float pitchDeg, float rollDeg) {
  char vb[16];
  char sb[24];

  g.setTextFont(FONT_SMALL);
  g.setTextDatum(MC_DATUM);
  g.setTextColor(C_TEXT, C_PANEL);

  /* ---- 左：PITCH ---- */
  g.fillRoundRect(4, 20, 70, 20, 5, C_PANEL);
  g.drawRoundRect(4, 20, 70, 20, 5, C_BORDER);
  fmtSigned1(vb, sizeof(vb), (int32_t)lroundf(pitchDeg * 10.0f));
  snprintf(sb, sizeof(sb), "P %s", vb);
  g.drawString(sb, 4 + 35, 30);

  /* ---- 中：ROLL ---- */
  g.fillRoundRect(78, 20, 100, 20, 5, C_PANEL);
  g.drawRoundRect(78, 20, 100, 20, 5, C_BORDER);
  fmtSigned1(vb, sizeof(vb), (int32_t)lroundf(rollDeg * 10.0f));
  snprintf(sb, sizeof(sb), "ROLL %s", vb);
  g.drawString(sb, 78 + 50, 30);

  /* ---- 右：MPU / AHT 状态点 ---- */
  g.fillRoundRect(182, 20, 54, 20, 5, C_PANEL);
  g.drawRoundRect(182, 20, 54, 20, 5, C_BORDER);
  g.setTextColor(C_DIM, C_PANEL);
  g.drawString("M", 194, 30);
  g.drawString("A", 220, 30);
  g.fillCircle(204, 30, 4, gMpuOk ? C_OK : C_ERR);
  g.fillCircle(230, 30, 4, gAhtOk ? C_OK : C_ERR);
}

/* ============================ 11. 姿态仪一帧（20FPS 调它） ============================ */
void dispSetSensorState(bool mpuOk, bool ahtOk) {
  gMpuOk = mpuOk;
  gAhtOk = ahtOk;
}

void dispDrawAttitude(float pitchDeg, float rollDeg) {
  const uint32_t t0 = micros();
  float nx, ny, hx, hy, scale;
  adiGeometry(pitchDeg, rollDeg, &nx, &ny, &hx, &hy, &scale);

  if (gSpriteReady) {
#if (UI_SPRITE_DEPTH == 16)
    if (gPixelGrad) {
      fillSkyGroundPixels(nx, ny, hx, hy, scale);   // ①-A 逐像素渐变（更细腻）
    } else {
      fillSkyGroundRows(spr, nx, ny, hx, hy, scale);// ①-B 逐行分段（默认，观感更"平"）
    }
#else
    (void)gPixelGrad;
    fillSkyGroundRows(spr, nx, ny, hx, hy, scale);  // ① 8bpp：只能走逐行分段
#endif
    drawAdiOverlay(spr, pitchDeg, rollDeg);      // ② 地平线 / 刻度 / 飞机符号
    drawTopBoxes(spr, pitchDeg, rollDeg);        // ③ 顶部数值框
    spr.pushSprite(UI_X_OFFSET, UI_Y_OFFSET);    // ④ 一次 SPI 传输上屏（无闪烁）
  } else {
    fillSkyGroundRows(tft, nx, ny, hx, hy, scale);// 退化模式：直接画（可能有轻微撕裂）
    drawAdiOverlay(tft, pitchDeg, rollDeg);
    drawTopBoxes(tft, pitchDeg, rollDeg);
  }

  /* ---- 帧率与耗时统计（掉帧排查用） ---- */
  gLastFrameUs = micros() - t0;
  if (gLastFrameUs > (uint32_t)UI_TASK_LIMIT_MS * 1000UL) {
    gSlowFrames++;
  }

  gFpsCnt++;
  const uint32_t now = millis();
  if (now - gFpsStamp >= FPS_REPORT_MS) {
    const uint32_t span = now - gFpsStamp;
    gFps      = (float)gFpsCnt * 1000.0f / (float)span;
    gFpsCnt   = 0;
    gFpsStamp = now;
  }
}

/* ============================ 12. 底部温湿度区（80px，1Hz） ============================
 *  数据来自 AHT30（.ino 里的 aht30ReadFrame），显示 1 位小数；
 *  为了"1 秒更新一次、且不闪"，策略是：
 *    · 静态底图（底色/分隔线/标签）只在第一次画；
 *    · 数值只在「四舍五入到 0.1 之后发生变化」时才重画（先填底色再写字，避免残影）。
 * ============================================================================ */
/* 温湿度区「静态底图」：面板底色 + 分隔线 + TEMP/HUMI 标签 + 初始占位值 + 提示
 * dispInit() 会先调用一次，这样开机画面/校准进度条期间底部区域也是完整的；
 * 之后 dispDrawEnv() 只重绘数值区（并在数值变化时才画），所以既每秒更新又不会闪。 */
static void drawEnvPanelBase(void) {
  gEnvDrawn = true;

  tft.fillRect(0, ENV_Y, SCR_W, ENV_H, C_PANEL);
  tft.drawFastHLine(0, ENV_Y, SCR_W, C_BORDER);
  tft.drawFastHLine(0, ENV_Y + 1, SCR_W, C_BORDER);
  tft.drawFastVLine(SCR_W / 2, ENV_Y + 8, ENV_H - 16, C_BORDER);

  tft.setTextDatum(TL_DATUM);
  tft.setTextFont(FONT_SMALL);
  tft.setTextColor(C_ICON_T, C_PANEL);
  tft.drawString("TEMP", 10, ENV_Y + 8);
  tft.setTextColor(C_ICON_H, C_PANEL);
  tft.drawString("HUMI", SCR_W / 2 + 10, ENV_Y + 8);

  /* 还没读到数据时先显示占位值（AHT30 第一次读数前最多 1 秒） */
  tft.setTextFont(FONT_BIG);
  tft.setTextColor(C_DIM, C_PANEL);
  tft.drawString("--.- C", 10, ENV_Y + 30);
  tft.drawString("--.- %", SCR_W / 2 + 10, ENV_Y + 30);

  tft.setTextFont(1);
  tft.setTextColor(C_DIM, C_PANEL);
  tft.drawString("waiting for AHT30 data ...", 20, ENV_Y + ENV_H - 14);
}

void dispDrawEnv(float tempC, float humiPct, bool ahtOk) {
  const int32_t t10 = (int32_t)lroundf(tempC * 10.0f);
  const int32_t h10 = (int32_t)lroundf(humiPct * 10.0f);

  /* ---- 12.1 静态底图（dispInit() 通常已经画过；没画过就在这里补上） ---- */
  if (!gEnvDrawn) {
    drawEnvPanelBase();
    gLastTemp  = -999.0f;      // 强制重画数值
    gLastHumi  = -999.0f;
    gLastAhtOk = !ahtOk;
  }

  /* ---- 12.2 数值没变就跳过（省 SPI、避免闪烁） ---- */
  if (((int32_t)lroundf(gLastTemp * 10.0f) == t10) &&
      ((int32_t)lroundf(gLastHumi * 10.0f) == h10) &&
      (gLastAhtOk == ahtOk)) {
    return;
  }
  gLastTemp  = tempC;
  gLastHumi  = humiPct;
  gLastAhtOk = ahtOk;

  char buf[24];

  /* ---- 12.3 温度（左半） ---- */
  tft.fillRect(4, ENV_Y + 28, SCR_W / 2 - 8, 34, C_PANEL);
  tft.setTextDatum(TL_DATUM);
  tft.setTextFont(FONT_BIG);
  tft.setTextColor(ahtOk ? C_TEXT : C_ERR, C_PANEL);
  if (ahtOk) {
    fmtPlain1(buf, sizeof(buf), t10);
    char t2[28];
    snprintf(t2, sizeof(t2), "%s C", buf);
    tft.drawString(t2, 10, ENV_Y + 30);
  } else {
    tft.drawString("--.- C", 10, ENV_Y + 30);
  }

  /* ---- 12.4 湿度（右半） ---- */
  tft.fillRect(SCR_W / 2 + 4, ENV_Y + 28, SCR_W / 2 - 8, 34, C_PANEL);
  tft.setTextColor(ahtOk ? C_TEXT : C_ERR, C_PANEL);
  if (ahtOk) {
    fmtPlain1(buf, sizeof(buf), h10);
    char h2[28];
    snprintf(h2, sizeof(h2), "%s %%", buf);
    tft.drawString(h2, SCR_W / 2 + 10, ENV_Y + 30);
  } else {
    tft.drawString("--.- %", SCR_W / 2 + 10, ENV_Y + 30);
  }

  /* ---- 12.5 底部状态行（在线绿点 / 离线红点 + 文字） ---- */
  tft.fillRect(0, ENV_Y + ENV_H - 18, SCR_W, 18, C_PANEL);
  tft.fillCircle(10, ENV_Y + ENV_H - 9, 4, ahtOk ? C_OK : C_ERR);
  tft.setTextFont(1);
  tft.setTextColor(ahtOk ? C_DIM : C_ERR, C_PANEL);
  tft.drawString(ahtOk ? "AHT30 online  1Hz" : "AHT30 OFFLINE - retry every 2s",
                 20, ENV_Y + ENV_H - 14);
}

/* ============================ 13. 方向 / 轴向自检画面（排错用） ============================
 *  什么时候用：
 *    · 屏幕方向可疑（"UP" 不在正上方、四角编号顺序不对）；
 *    · 左右摆动却显示上下（姿态 X/Y 看起来反了）→ 在这里核对轴向并现场切换安装方向。
 *  显示内容：UP + 四角编号（判断屏幕方向）；AX/AY/AZ（原始轴）；FWD/RIGHT/UP（机体轴）；
 *            PITCH/ROLL（解算角）；当前安装方向名（串口 'm' 循环切换）。
 *  正确性判据：向右滚（右侧压低）→ ROLL 变大；抬头 → PITCH 变大。
 *  开关方式：串口敲 'd'。
 * ============================================================================ */
void dispDrawDiag(const char *mountName, bool chipUp,
                  float ax, float ay, float az,
                  float fwd, float right, float up,
                  float pitch, float roll) {
  char l1[34], l2[34], l3[34], l4[34], b1[14], b2[14];

  tft.fillRect(0, 0, ADI_W, ADI_H, TFT_BLACK);

  /* ---- 方向标记（判断屏幕方向） ---- */
  tft.setTextDatum(MC_DATUM);
  tft.setTextFont(FONT_BIG);
  tft.setTextColor(C_ACCENT, TFT_BLACK);
  tft.drawString("UP", SCR_W / 2, 26);

  tft.setTextFont(1);
  tft.setTextColor(C_DIM, TFT_BLACK);
  tft.setTextDatum(TL_DATUM); tft.drawString("1", 6, 6);
  tft.setTextDatum(TR_DATUM); tft.drawString("2", SCR_W - 6, 6);
  tft.setTextDatum(BL_DATUM); tft.drawString("3", 6, 236);
  tft.setTextDatum(BR_DATUM); tft.drawString("4", SCR_W - 6, 236);

  /* ---- 判读提示 ---- */
  tft.setTextFont(FONT_SMALL);
  tft.setTextDatum(MC_DATUM);
  tft.setTextColor(C_TEXT, TFT_BLACK);
  tft.drawString("AXIS / DIR SELF TEST", SCR_W / 2, 56);
  tft.setTextColor(C_DIM, TFT_BLACK);
  tft.drawString("roll right -> ROLL must rise", SCR_W / 2, 78);
  tft.drawString("pitch up   -> PITCH must rise", SCR_W / 2, 96);
  tft.drawString("serial: m d g r b c h", SCR_W / 2, 114);

  /* ---- 颜色自检：8 个色块，从左到右依次是
   *      浅蓝(天空近) / 深蓝(天空远) / 浅棕(地面近) / 深棕(地面远) / 白 / 琥珀 / 青 / 绿
   *      如果这些色块看起来不是这个顺序/颜色，说明是"颜色通道"问题，把这张图拍给我即可。 */
  {
    static const uint16_t kSw[8] = {C_SKY_NEAR, C_SKY_FAR, C_GND_NEAR, C_GND_FAR,
                                    C_HORIZON, C_AIRCRAFT, C_ACCENT, C_OK};
    for (int i = 0; i < 8; i++) {
      tft.fillRect(8 + i * 28, 122, 26, 16, kSw[i]);
    }
  }

  /* ---- 数值（左对齐，方便左右对照） ---- */
  fmtSigned2(b1, sizeof(b1), (int32_t)lroundf(ax * 100.0f));
  fmtSigned2(b2, sizeof(b2), (int32_t)lroundf(ay * 100.0f));
  snprintf(l1, sizeof(l1), "AX %s AY %s", b1, b2);
  fmtSigned2(b1, sizeof(b1), (int32_t)lroundf(az * 100.0f));
  snprintf(l2, sizeof(l2), "AZ %s", b1);
  fmtSigned2(b1, sizeof(b1), (int32_t)lroundf(fwd * 100.0f));
  fmtSigned2(b2, sizeof(b2), (int32_t)lroundf(right * 100.0f));
  snprintf(l3, sizeof(l3), "FWD %s RIGHT %s", b1, b2);
  fmtSigned2(b1, sizeof(b1), (int32_t)lroundf(up * 100.0f));
  fmtSigned1(b2, sizeof(b2), (int32_t)lroundf(pitch * 10.0f));
  snprintf(l4, sizeof(l4), "UP %s PITCH %s", b1, b2);

  fmtSigned1(b1, sizeof(b1), (int32_t)lroundf(roll * 10.0f));

  tft.setTextDatum(TL_DATUM);
  tft.setTextColor(C_TEXT, TFT_BLACK);
  tft.drawString(l1, 6, 140);
  tft.drawString(l2, 6, 158);
  tft.drawString(l3, 6, 176);
  tft.drawString(l4, 6, 194);

  char l5[34];
  snprintf(l5, sizeof(l5), "ROLL %s  %s cu=%d", b1, mountName, (int)chipUp);
  tft.setTextColor(C_ACCENT, TFT_BLACK);
  tft.drawString(l5, 6, 214);
}

#else  /* ===== UI_ENABLE == 0：完全关闭屏幕代码（回到"纯传感器"版本，省 Flash/内存） ===== */
bool     dispInit(void)                       { return false; }
void     dispPrintConfig(void)                { }
bool     dispSpriteReady(void)                { return false; }
void     setBacklight(uint8_t level)          { (void)level; }
void     setBacklightPercent(uint8_t percent) { (void)percent; }
uint8_t  getBacklight(void)                   { return 0; }
void     dispDrawBoot(void)                   { }
void     dispDrawCalib(uint8_t percent, float spanDps) { (void)percent; (void)spanDps; }
void     dispDrawAttitude(float pitchDeg, float rollDeg) { (void)pitchDeg; (void)rollDeg; }
void     dispDrawEnv(float tempC, float humiPct, bool ahtOk) { (void)tempC; (void)humiPct; (void)ahtOk; }
void     dispSetSensorState(bool mpuOk, bool ahtOk) { (void)mpuOk; (void)ahtOk; }
void     dispDrawDiag(const char *mountName, bool chipUp, float ax, float ay, float az,
                      float fwd, float right, float up, float pitch, float roll) {
  (void)mountName; (void)chipUp; (void)ax; (void)ay; (void)az;
  (void)fwd; (void)right; (void)up; (void)pitch; (void)roll;
}
void     dispSetRotation(uint8_t rot) { (void)rot; }
uint8_t  dispGetRotation(void) { return 0; }
void     dispToggleGradient(void) { }
bool     dispGetGradient(void) { return false; }
float    dispFps(void)                        { return 0.0f; }
uint32_t dispLastFrameUs(void)                { return 0; }
uint16_t dispSlowFrames(void)                 { return 0; }
uint32_t dispFreeHeap(void)                   { return (uint32_t)ESP.getFreeHeap(); }
#endif /* UI_ENABLE */

