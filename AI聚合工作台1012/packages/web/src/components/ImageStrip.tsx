/** 图片缩略图条：支持删除；刷新后（dataUrl 被剥离）显示"未保留"占位 */
import type { ImageItem } from '../lib/image';
import { formatBytes } from '../lib/image';

export function ImageStrip({
  images,
  onRemove,
  size = 64,
}: {
  images: ImageItem[];
  onRemove?: (id: string) => void;
  size?: number;
}) {
  if (images.length === 0) return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-1.5">
      {images.map((img) => (
        <div key={img.id} className="group relative" style={{ width: size, height: size }}>
          {img.dataUrl ? (
            <img
              src={img.dataUrl}
              alt={img.name}
              className="h-full w-full rounded-lg border border-white/10 object-cover"
              title={`${img.name} · ${img.width}×${img.height} · ${formatBytes(img.size)}`}
            />
          ) : (
            <div
              className="flex h-full w-full items-center justify-center rounded-lg border border-dashed border-white/20 bg-white/[0.03] px-1 text-center text-[10px] leading-tight text-slate-500"
              title={`${img.name}（历史图片未保留）`}
            >
              历史图片
              <br />
              未保留
            </div>
          )}
          {onRemove && (
            <button
              type="button"
              onClick={() => onRemove(img.id)}
              title="移除这张图片"
              className="absolute -right-1.5 -top-1.5 hidden h-5 w-5 items-center justify-center rounded-full border border-white/20 bg-slate-900 text-xs text-slate-300 transition hover:bg-rose-500/80 hover:text-white group-hover:flex"
            >
              ×
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
