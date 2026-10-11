/**
 * 图片处理：前端压缩（画布）后转 dataURL。
 *
 * 为什么在前端压：三家的图片上限与上传耗时都受体积影响，
 * 而且超长边会先被站点二次压缩，不如我们自己控制质量。
 *
 * 为什么统一转 JPEG：JPEG 体积远小于 PNG，且聊天场景（照片/截图）质量足够。
 * 代价：PNG 的透明通道会变成黑底——纯图标类图片建议先自行转白底。
 */
import { makeId } from '@shared';

export interface ImageItem {
  id: string;
  name: string;
  /** 压缩后的 dataURL（P1 直接随请求发给后端；P2 起改为上传后返回的 URL） */
  dataUrl: string;
  /** 压缩后的像素尺寸 */
  width: number;
  height: number;
  /** 压缩后的字节数（估算，base64 长度 × 3/4） */
  size: number;
}

export const IMAGE_LIMITS = {
  /** 单次最多几张 */
  maxCount: 6,
  /** 单张原始文件最大 12MB */
  maxFileSize: 12 * 1024 * 1024,
  /** 压缩后最长边 */
  maxDim: 1600,
  /** JPEG 质量 */
  quality: 0.85,
};

/** dataURL 的 base64 部分换算成字节数 */
export function dataUrlBytes(dataUrl: string): number {
  const idx = dataUrl.indexOf(',');
  const b64 = idx >= 0 ? dataUrl.slice(idx + 1) : '';
  return Math.round((b64.length * 3) / 4);
}

/** 读取文件为 dataURL（压缩失败时的兜底） */
function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(new Error('读取文件失败'));
    fr.readAsDataURL(file);
  });
}

/** 用 <img> 解码（比 createImageBitmap 兼容性更好，且能拿到 naturalWidth） */
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片解码失败'));
    img.src = src;
  });
}

/**
 * 压缩单张图片。
 * 失败时不抛错到调用方崩溃，而是回退为"原始文件直传"，并让上层提示。
 */
export async function compressImage(file: File): Promise<ImageItem> {
  if (!file.type.startsWith('image/')) throw new Error('只能上传图片文件');
  if (file.size > IMAGE_LIMITS.maxFileSize) {
    throw new Error(`「${file.name}」超过 ${Math.round(IMAGE_LIMITS.maxFileSize / 1024 / 1024)}MB`);
  }

  const original = await readAsDataUrl(file);

  try {
    const img = await loadImage(original);
    const scale = Math.min(1, IMAGE_LIMITS.maxDim / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法创建画布上下文');

    // 透明区域铺深色底，避免 JPEG 把透明变黑块看起来像"图片坏了"
    ctx.fillStyle = '#0d1220';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);

    const dataUrl = canvas.toDataURL('image/jpeg', IMAGE_LIMITS.quality);

    // 压缩反而更大时（例如本来就极小的图），保留原图
    const useOriginal = dataUrlBytes(dataUrl) >= dataUrlBytes(original) * 1.05;
    const finalUrl = useOriginal ? original : dataUrl;

    return {
      id: makeId('img'),
      name: file.name || '粘贴的图片',
      dataUrl: finalUrl,
      width: useOriginal ? img.naturalWidth : w,
      height: useOriginal ? img.naturalHeight : h,
      size: dataUrlBytes(finalUrl),
    };
  } catch {
    // 解码失败：直接原样带上，交给站点处理
    return {
      id: makeId('img'),
      name: file.name || '图片',
      dataUrl: original,
      width: 0,
      height: 0,
      size: dataUrlBytes(original),
    };
  }
}

/** 批量压缩（保持顺序；超出上限的截断） */
export async function compressImages(files: File[], already: number): Promise<ImageItem[]> {
  const room = Math.max(0, IMAGE_LIMITS.maxCount - already);
  const picked = files.filter((f) => f.type.startsWith('image/')).slice(0, room);
  const out: ImageItem[] = [];
  for (const f of picked) out.push(await compressImage(f));
  return out;
}

/** 人类可读体积 */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}
