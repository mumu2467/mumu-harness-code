/* ============================================================================
 *  attitude.h —— 姿态解算模块（安装方向映射 + 互补滤波 + 显示低通 + 开机校准）
 *  项目：esp32-0920 AHT30 + MPU6050 + ST7789 彩屏（飞机水平仪 ADI）
 * ----------------------------------------------------------------------------
 *  设计说明（为什么这么拆）：
 *    · 本模块**不碰 I2C、不碰屏幕**，只做"数学"：输入一组 MPU6050 原始读数，
 *      输出 pitch / roll（度）。这样传感器代码与显示代码互不干扰，便于单独验证。
 *    · .ino 每 50ms 调用一次：attMapAxes() → attUpdate() → attFilterDisplay()
 * ----------------------------------------------------------------------------
 *  坐标系定义（务必记住，装机方向不对时就是靠它对齐的）：
 *    机体坐标：fwd=前(机头)、right=右、down=下（右手系）
 *      水平放置时：fwd≈0, right≈0, down≈+1g（重力指向下）
 *    pitch（俯仰）= 抬头为正  = atan2(fwd, √(right²+down²))
 *    roll （横滚）= 右倾为正  = atan2(-right, -down)
 *    角速度      ：wRoll=绕机头轴(横滚率)、wPitch=绕右翼轴(俯仰率)、wYaw=绕向下轴
 * ============================================================================ */

#ifndef ATTITUDE_H
#define ATTITUDE_H

#include <Arduino.h>

/* 机体坐标量：安装方向映射后的加速度与角速度 */
typedef struct {
  float fwd, right, down;      // 加速度（机体坐标，单位 g）
  float wRoll, wPitch, wYaw;   // 角速度（绕机头/右翼/向下轴，单位 °/s）
} BodyVec;

/* ---- 初始化 / 复位 ---- */
void attReset(void);                      // 清空滤波器与校准状态（掉线恢复后调用）

/* ---- 安装方向映射：传感器轴 → 机体轴（方向补偿宏在 app_config.h） ---- */
void attMapAxes(float ax, float ay, float az, float gx, float gy, float gz, BodyVec *out);

/* ---- 开机静置校准（非阻塞：由主循环分步调用）---- */
void  attCalibBegin(void);                // 开始校准（清零累加器）
void  attCalibAccumulate(const BodyVec *b); // 校准期间：累加一个样本
bool  attCalibFinish(void);               // 结算：算陀螺零偏与姿态零点；返回"是否足够静止"
float attCalibSpanDps(void);              // 校准期间的角速度最大波动(°/s)，用于提示"请勿移动"
uint8_t attCalibSamples(void);            // 已累加样本数

/* ---- 解算 ---- */
void  attUpdate(const BodyVec *b, float dtSec);  // 互补滤波：陀螺积分(高频) + 加速度计(低频)
void  attFilterDisplay(float dtSec);            // 显示级一阶低通（让地平线运动柔和、不抖）

/* ---- 结果读取 ---- */
float attPitch(void);        // 滤波后的俯仰角(°)（重力绝对角，未扣零点）
float attRoll(void);         // 滤波后的横滚角(°)
float attPitchDisp(void);    // 显示用俯仰角(°) = pitch - 零点，再低通
float attRollDisp(void);     // 显示用横滚角(°)
float attZeroPitch(void);    // 开机校准得到的俯仰零点(°)
float attZeroRoll(void);     // 开机校准得到的横滚零点(°)
float attBiasRollDps(void);  // 标定出的横滚率零偏(°/s)，仅用于打印
float attBiasPitchDps(void); // 标定出的俯仰率零偏(°/s)
float attBiasYawDps(void);   // 标定出的偏航率零偏(°/s)

/* ---- 运行期安装方向切换（串口命令 'm' 用：不用重新烧录就能试出正确方向） ----
 *  说明：初值来自 app_config.h 的 IMU_MOUNT / IMU_CHIP_UP，改动后立即生效并复位滤波。
 *  试出正确方向后，把 app_config.h 的 IMU_MOUNT 宏改成同一个值即可固化。 */
void        attSetMount(uint8_t mountIdx, bool chipUp);
void        attCycleMount(void);                  // 循环切换（4 个方向 × 是否倒扣）
uint8_t     attGetMount(void);
bool        attGetChipUp(void);
const char *attMountName(uint8_t mountIdx);       // "X-forward"/"X-right"/"X-back"/"X-left"

#endif /* ATTITUDE_H */
