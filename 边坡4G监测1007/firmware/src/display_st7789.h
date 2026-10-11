/* ============================================================================
 *  display_st7789.h —— ST7789 240x320 SPI 彩屏驱动 + 飞机水平仪(ADI) UI
 *  项目：esp32-0920 AHT30 + MPU6050 + ST7789 彩屏
 * ----------------------------------------------------------------------------
 *  屏幕分工（竖屏 240x320）：
 *    上 240x240：姿态仪层（天空/地面随 roll 旋转、随 pitch 平移、
 *                白地平线、俯仰刻度 ±10/20/30、顶部横滚刻度与指针、
 *                固定飞机符号、顶部数值框）—— 20FPS 刷新，用 TFT_eSprite 离屏绘制
 *    下 80px  ：温湿度区（FONT4 大字，温度/湿度 1 位小数）—— 只在数值变化时重绘
 *  背光：GPIO42 走 LEDC PWM（5kHz / 8bit），默认亮度 80%，可 setBacklight() 调
 * ----------------------------------------------------------------------------
 *  使用顺序（在 .ino 里）：
 *    setup():      dispInit() → dispPrintConfig() → dispDrawBoot()
 *    校准阶段:      dispDrawCalib(percent, spanDps)
 *    20Hz 任务:     dispDrawAttitude(attPitchDisp(), attRollDisp())
 *    1Hz  任务:     dispDrawEnv(temp, humi, ahtOnline)
 *    状态变化:      dispSetSensorState(mpuOnline, ahtOnline)
 * ============================================================================ */

#ifndef DISPLAY_ST7789_H
#define DISPLAY_ST7789_H

#include <Arduino.h>

/* ---- 初始化 ---- */
bool  dispInit(void);                  // TFT 初始化 + LEDC 背光 + 创建 Sprite；返回是否成功
void  dispPrintConfig(void);           // 把驱动/引脚/SPI/Sprite/内存等信息打印到串口
bool  dispSpriteReady(void);           // Sprite 是否创建成功（失败时自动退化为直接绘制）

/* ---- 背光（GPIO42，LEDC PWM） ---- */
void    setBacklight(uint8_t level);         // 直接给占空比 0~255
void    setBacklightPercent(uint8_t percent); // 给百分比 0~100（内部换算）
uint8_t getBacklight(void);                  // 读回当前占空比 0~255

/* ---- 画面 ---- */
void dispDrawBoot(void);                                     // 开机画面（含屏幕方向标记）
void dispDrawCalib(uint8_t percent, float spanDps);          // 开机校准进度画面（非阻塞，可反复调用）
void dispDrawAttitude(float pitchDeg, float rollDeg);         // 姿态仪一帧（20FPS 调这个）
void dispDrawEnv(float tempC, float humiPct, bool ahtOk);     // 底部温湿度（1Hz / 数值变化时重绘）
void dispSetSensorState(bool mpuOk, bool ahtOk);             // 更新状态点（绿=在线 红=离线）

/* ---- 排错：方向 / 轴向自检画面（屏幕方向反了、左右动却显示上下 时用它核对）----
 *  画面内容：UP/LEFT/RIGHT/DOWN 标记 + 四角编号（判断屏幕方向对不对）
 *            + 原始轴 AX/AY/AZ + 机体轴 FWD/RIGHT/UP + PITCH/ROLL + 当前安装方向
 *  用法：串口敲 'd' 切换显示；串口敲 'm' 循环安装方向，看哪组能让"向右滚 → ROLL 变大"。 */
void dispDrawDiag(const char *mountName, bool chipUp,
                  float ax, float ay, float az,
                  float fwd, float right, float up,
                  float pitch, float roll);

/* ---- 运行期切换屏幕方向（0~3，串口 'r' 用）；会自动重画底图并清空姿态层 ---- */
void dispSetRotation(uint8_t rot);
uint8_t dispGetRotation(void);

/* ---- 运行期切换天空/地面填充方式（串口 'g' 用）：两种方式对比着看 ---- */
void dispToggleGradient(void);
bool dispGetGradient(void);

/* ---- 统计 ---- */
float    dispFps(void);                // 最近 1 秒实测帧率
uint32_t dispLastFrameUs(void);        // 最近一帧「绘制+推送」耗时(us)
uint16_t dispSlowFrames(void);         // 超过 UI_TASK_LIMIT_MS 的帧数（掉帧排查用）
uint32_t dispFreeHeap(void);           // 当前空闲堆(byte)

#endif /* DISPLAY_ST7789_H */
