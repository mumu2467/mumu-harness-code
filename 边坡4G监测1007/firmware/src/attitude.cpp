/* ============================================================================
 *  attitude.cpp —— 姿态解算实现（安装方向映射 / 互补滤波 / 显示低通 / 开机校准）
 *  项目：esp32-0920 AHT30 + MPU6050 + ST7789 彩屏
 * ----------------------------------------------------------------------------
 *  算法总览（20Hz 调用）：
 *    ① attMapAxes()        把"传感器轴"的 ax/ay/az/gx/gy/gz 映射成"机体轴"前/右/下
 *    ② 加速度计绝对角       pitch=atan2(fwd,√(right²+down²))、roll=atan2(-right,-down)
 *    ③ 互补滤波            角度 = α(角度 + 陀螺率·dt) + (1-α) 加速度计角，α = τ/(τ+dt)
 *                          —— 陀螺管"短时间准"，加速度计管"长时间不漂"
 *    ④ 显示低通            再叠一级一阶低通（τ=DISP_TAU_S），让地平线运动柔和
 * ============================================================================ */

#include "attitude.h"
#include "app_config.h"
#include <math.h>

/* ============================ 1. 模块内部状态 ============================ */

/* ---- 互补滤波输出（重力绝对角，单位度；未扣零点） ---- */
static float gPitch = 0.0f;      // 俯仰角
static float gRoll  = 0.0f;      // 横滚角
static float gYaw   = 0.0f;      // 偏航角（只有陀螺积分，会漂，仅参考、不上屏）
static bool  gInit  = false;     // 滤波是否已用第一个样本初始化

/* ---- 显示用角度（扣掉开机零点 + 低通） ---- */
static float gPitchDisp = 0.0f;
static float gRollDisp  = 0.0f;

/* ---- 开机校准结果 ---- */
static float gBiasRoll  = 0.0f;  // 横滚率零偏(°/s)
static float gBiasPitch = 0.0f;  // 俯仰率零偏(°/s)
static float gBiasYaw   = 0.0f;  // 偏航率零偏(°/s)
static float gZeroPitch = 0.0f;  // 俯仰零点(°)：安装姿态造成的常量偏移
static float gZeroRoll  = 0.0f;  // 横滚零点(°)

/* ---- 运行期安装方向（初值来自 app_config.h 的宏；可用串口命令 'm' 临时切换） ---- */
static uint8_t gMount  = (uint8_t)IMU_MOUNT;
static bool    gChipUp = (IMU_CHIP_UP != 0);
static bool    gFlipP  = (IMU_FLIP_PITCH != 0);
static bool    gFlipR  = (IMU_FLIP_ROLL != 0);

/* ---- 校准累加器（用 double 累加，避免 1200ms 内 float 精度损失） ---- */
static uint16_t gCalN = 0;
static double   gSumWR = 0, gSumWP = 0, gSumWY = 0;      // 角速度累加
static double   gSumF = 0, gSumR = 0, gSumD = 0;         // 加速度累加
static float    gSpanWR = 0, gSpanWP = 0, gSpanWY = 0;   // 角速度最大波动(°/s)
static float    gMinWR = 0, gMinWP = 0, gMinWY = 0;
static float    gMaxWR = 0, gMaxWP = 0, gMaxWY = 0;

/* ============================ 2. 初始化 / 复位 ============================ */

static void calibClear(void);      // 前置声明（清空校准累加器）
static void resetFusionState(void); // 前置声明（复位互补滤波 + 显示低通）

void attReset(void) {
  gPitch = gRoll = gYaw = 0.0f;
  gPitchDisp = gRollDisp = 0.0f;
  gInit = false;
  calibClear();
}

/* 复位互补滤波与显示低通：让下一次 attUpdate() 直接用加速度计结果初始化，
 * 避免从 0° 慢慢收敛（开机或传感器掉线恢复后调用） */
static void resetFusionState(void) {
  gInit = false;
  gPitch = gRoll = gYaw = 0.0f;
  gPitchDisp = gRollDisp = 0.0f;
}

/* 内部小工具：清空校准累加器（attCalibBegin / attReset 共用） */
static void calibClear(void) {
  gCalN = 0;
  gSumWR = gSumWP = gSumWY = 0;
  gSumF = gSumR = gSumD = 0;
  gSpanWR = gSpanWP = gSpanWY = 0;
  gMinWR = gMinWP = gMinWY = 0;
  gMaxWR = gMaxWP = gMaxWY = 0;
}

/* ============================ 3. 安装方向映射 ============================
 *  把"传感器自身坐标(ax,ay,az / gx,gy,gz)"换算到"机体坐标(fwd/right/down)"。
 *  换方向只改 app_config.h 里的 IMU_MOUNT / IMU_CHIP_UP / IMU_FLIP_*，本函数自动生效。
 * ---------------------------------------------------------------------------
 *  原理：三个物理轴（前/右/上）在传感器三轴里各对应一根轴，且可能反号；
 *        于是用"索引 + 符号"的方式表达映射，避免写一堆 if-else 的公式。
 *        倒扣安装（芯片朝下）= 绕机头轴再翻 180°：前不变、右和上反号。
 * ======================================================================== */
void attMapAxes(float ax, float ay, float az, float gx, float gy, float gz, BodyVec *out) {
  int8_t fIdx, rIdx, uIdx;      // 该物理轴对应哪个传感器轴（0=ax/gx, 1=ay/gy, 2=az/gz）
  int8_t fSg, rSg, uSg;         // 对应符号（±1）

  switch (gMount) {
    case IMU_MOUNT_XFWD:               // +X 朝机头：fwd=+ax  right=-ay  up=+az
      fIdx = 0; fSg = +1; rIdx = 1; rSg = -1; uIdx = 2; uSg = +1; break;
    case IMU_MOUNT_XRIGHT:             // +X 朝屏幕右侧：fwd=+ay  right=+ax  up=+az
      fIdx = 1; fSg = +1; rIdx = 0; rSg = +1; uIdx = 2; uSg = +1; break;
    case IMU_MOUNT_XBACK:              // +X 朝机尾：fwd=-ax  right=+ay  up=+az
      fIdx = 0; fSg = -1; rIdx = 1; rSg = +1; uIdx = 2; uSg = +1; break;
    default:                           // IMU_MOUNT_XLEFT：+X 朝屏幕左侧
      fIdx = 1; fSg = -1; rIdx = 0; rSg = -1; uIdx = 2; uSg = +1; break;
  }
  if (!gChipUp) {                    // 倒扣安装：右、上反号
    rSg = -rSg;
    uSg = -uSg;
  }

  const float a[3] = {ax, ay, az};
  const float w[3] = {gx, gy, gz};

  out->fwd   = a[fIdx] * fSg;
  out->right = a[rIdx] * rSg;
  out->down  = -(a[uIdx] * uSg);      // down = -up（重力向下为正，水平时 down≈+1g）

  /* 角速度也做同样的轴映射：绕哪根轴转，就用哪根轴的角速度
   *   wRoll  绕机头轴(前轴) → 横滚角速度
   *   wPitch 绕右翼轴(右轴) → 俯仰角速度
   *   wYaw   绕向下轴 = -绕向上轴 → 偏航角速度 */
  out->wRoll  = w[fIdx] * fSg;
  out->wPitch = w[rIdx] * rSg;
  out->wYaw   = -(w[uIdx] * uSg);

  /* 方向翻转开关：角度和角速度必须"一起反"，否则互补滤波会互相打架 */
  if (gFlipR) {
    out->wRoll = -out->wRoll;
    out->right = -out->right;          // 注意：翻转 roll 也等价于把右轴取反
  }
  if (gFlipP) {
    out->wPitch = -out->wPitch;
    out->fwd    = -out->fwd;
  }
}

/* ============================ 3.1 运行期方向切换（串口命令 'm'） ============================
 *  作用：不用重新烧录就能试出正确的安装方向。
 *  试法（配合屏幕上的自检画面或串口 #Axes 行）：
 *    · 让板子"向右滚"（右侧压低）→ 屏幕上 ROLL 应朝正方向变大；
 *    · 让板子"抬头"（机头抬高）      → 屏幕上 PITCH 应朝正方向变大。
 *  哪个方向符合就保持哪个；把 app_config.h 的 IMU_MOUNT 宏改成同一个名字再编译即可固化。 */
void attSetMount(uint8_t mountIdx, bool chipUp) {
  if (mountIdx > IMU_MOUNT_XLEFT) {
    mountIdx = IMU_MOUNT_XRIGHT;
  }
  gMount  = mountIdx;
  gChipUp = chipUp;
  resetFusionState();                  // 方向变了，滤波要从头用加速度计初始化
}

void attCycleMount(void) {
  /* 顺序：X-forward → X-right → X-back → X-left → 再回到 X-forward（同时翻"是否倒扣"） */
  uint8_t m = (uint8_t)(gMount + 1);
  bool    c = gChipUp;
  if (m > IMU_MOUNT_XLEFT) {
    m = IMU_MOUNT_XFWD;
    c = !c;
  }
  attSetMount(m, c);
}

uint8_t attGetMount(void)  { return gMount; }
bool    attGetChipUp(void) { return gChipUp; }

const char *attMountName(uint8_t mountIdx) {
  switch (mountIdx) {
    case IMU_MOUNT_XFWD:  return "X-forward";
    case IMU_MOUNT_XBACK: return "X-back";
    case IMU_MOUNT_XLEFT: return "X-left";
    default:              return "X-right";
  }
}

/* ============================ 4. 开机静置校准 ============================
 *  目的：① 标定陀螺零偏（静止时角速度不为 0，会随时间积分出假角度）
 *        ② 记录姿态零点（把开机时的安装姿态当作 0°，放平即显示 0.0°）
 *  做法：CALIB_MS 期间每 50ms 累加一次样本，结束时取平均；
 *        同时统计角速度的"最大-最小"波动，用来提示用户"别动"。
 * ======================================================================== */
void attCalibBegin(void) {
  calibClear();
  resetFusionState();
}

void attCalibAccumulate(const BodyVec *b) {
  if (gCalN == 0) {                     // 第一个样本：初始化极值
    gMinWR = gMaxWR = b->wRoll;
    gMinWP = gMaxWP = b->wPitch;
    gMinWY = gMaxWY = b->wYaw;
  } else {
    if (b->wRoll  < gMinWR) gMinWR = b->wRoll;
    if (b->wRoll  > gMaxWR) gMaxWR = b->wRoll;
    if (b->wPitch < gMinWP) gMinWP = b->wPitch;
    if (b->wPitch > gMaxWP) gMaxWP = b->wPitch;
    if (b->wYaw   < gMinWY) gMinWY = b->wYaw;
    if (b->wYaw   > gMaxWY) gMaxWY = b->wYaw;
  }

  gSumWR += b->wRoll;
  gSumWP += b->wPitch;
  gSumWY += b->wYaw;
  gSumF  += b->fwd;
  gSumR  += b->right;
  gSumD  += b->down;
  gCalN++;
}

bool attCalibFinish(void) {
  if (gCalN == 0) {
    return false;
  }

  const float n = (float)gCalN;
  gBiasRoll  = (float)(gSumWR / n);
  gBiasPitch = (float)(gSumWP / n);
  gBiasYaw   = (float)(gSumWY / n);

  gSpanWR = gMaxWR - gMinWR;
  gSpanWP = gMaxWP - gMinWP;
  gSpanWY = gMaxWY - gMinWY;

  /* 姿态零点：用校准期间的平均加速度算一次绝对角，作为 0° 基准 */
#if CALIB_LEVEL_ZERO
  {
    const float mf = (float)(gSumF / n);
    const float mr = (float)(gSumR / n);
    const float md = (float)(gSumD / n);
    gZeroPitch = atan2f(mf, sqrtf(mr * mr + md * md)) * RAD_TO_DEG;
    gZeroRoll  = atan2f(-mr, -md) * RAD_TO_DEG;
  }
#else
  gZeroPitch = 0.0f;
  gZeroRoll  = 0.0f;
#endif

  /* 静止判定：三个角速度的波动都小于阈值，就算"静止" */
  const float spanMax = fmaxf(gSpanWR, fmaxf(gSpanWP, gSpanWY));
  return (spanMax < CALIB_MAX_SPAN_DPS);
}

float   attCalibSpanDps(void)   { return fmaxf(gSpanWR, fmaxf(gSpanWP, gSpanWY)); }
uint8_t attCalibSamples(void)   { return (uint8_t)(gCalN > 255 ? 255 : gCalN); }

/* ============================ 5. 互补滤波解算 ============================
 *  ┌ 加速度计绝对角（静态准，动态会被"加减速"干扰）：
 *  │    pitch = atan2(fwd, √(right²+down²))     （抬头为正）
 *  │    roll  = atan2(-right, -down)            （右倾为正）
 *  ├ 陀螺积分（短时间准，长时间会因零偏漂移）：角度 += 角速度·dt
 *  └ 互补滤波：角度 = α·(上一角度 + 角速度·dt) + (1-α)·加速度计角
 *             α = τ/(τ+dt)  ← 用"实际 dt"算 α，所以采样周期抖动也不影响稳定性
 *  说明：yaw（偏航）没有磁力计做绝对参考，只能纯积分、必然漂，故只做参考不上屏。
 * ======================================================================== */
void attUpdate(const BodyVec *b, float dtSec) {
  /* ---- ① 加速度计绝对角 ---- */
  const float rollAcc  = atan2f(-b->right, -b->down) * RAD_TO_DEG;
  const float pitchAcc = atan2f(b->fwd, sqrtf(b->right * b->right + b->down * b->down)) * RAD_TO_DEG;

  /* ---- ② 首次：直接用加速度计结果，避免从 0° 慢慢收敛 ---- */
  if (!gInit) {
    gRoll    = rollAcc;
    gPitch   = pitchAcc;
    gYaw     = 0.0f;
    gPitchDisp = pitchAcc - gZeroPitch;
    gRollDisp  = rollAcc  - gZeroRoll;
    gInit = true;
    return;
  }

  /* ---- ③ 扣掉开机标定出的陀螺零偏 ---- */
  const float wx = b->wRoll  - gBiasRoll;   // 横滚率(°/s)
  const float wy = b->wPitch - gBiasPitch;  // 俯仰率(°/s)
  const float wz = b->wYaw   - gBiasYaw;    // 偏航率(°/s)

  /* ---- ④ 互补滤波 ---- */
  const float alpha = (CF_TAU_S > 0.0f) ? (CF_TAU_S / (CF_TAU_S + dtSec)) : 0.0f;

  gRoll  = alpha * (gRoll  + wx * dtSec) + (1.0f - alpha) * rollAcc;
  gPitch = alpha * (gPitch + wy * dtSec) + (1.0f - alpha) * pitchAcc;
  gYaw  += wz * dtSec;

  /* 偏航归一化到 ±180°；俯仰限幅 ±90°（超过就没有物理意义了） */
  if (gYaw >  180.0f) gYaw -= 360.0f;
  if (gYaw < -180.0f) gYaw += 360.0f;
  if (gPitch >  PITCH_LIMIT_DEG) gPitch =  PITCH_LIMIT_DEG;
  if (gPitch < -PITCH_LIMIT_DEG) gPitch = -PITCH_LIMIT_DEG;
}

/* ============================ 6. 显示级低通 ============================
 *  二阶效果：解算结果已由互补滤波平滑，这里再叠一级一阶低通，让"地平线运动柔和"。
 *  离散一阶低通：y += k·(目标 - y)，k = dt/(τ+dt)；τ=DISP_TAU_S 越小越跟手。
 * ======================================================================== */
void attFilterDisplay(float dtSec) {
  const float tp = gPitch - gZeroPitch;
  const float tr = gRoll  - gZeroRoll;
  const float k  = (DISP_TAU_S > 0.0f) ? (dtSec / (DISP_TAU_S + dtSec)) : 1.0f;

  gPitchDisp += k * (tp - gPitchDisp);
  gRollDisp  += k * (tr - gRollDisp);
}

/* ============================ 7. 结果读取接口 ============================ */
float attPitch(void)        { return gPitch; }
float attRoll(void)         { return gRoll; }
float attPitchDisp(void)    { return gPitchDisp; }
float attRollDisp(void)     { return gRollDisp; }
float attZeroPitch(void)    { return gZeroPitch; }
float attZeroRoll(void)     { return gZeroRoll; }
float attBiasRollDps(void)  { return gBiasRoll; }
float attBiasPitchDps(void) { return gBiasPitch; }
float attBiasYawDps(void)   { return gBiasYaw; }

