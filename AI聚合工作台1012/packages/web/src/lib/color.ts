/** 颜色小工具：把 PROVIDER_META 里的 6 位 hex 转成带透明度的 rgba，用于内联样式 */

function parseHex(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace('#', '').trim();
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = Number.parseInt(full, 16);
  if (!Number.isFinite(n)) return { r: 79, g: 110, b: 247 };
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function hexA(hex: string, alpha: number): string {
  const { r, g, b } = parseHex(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
