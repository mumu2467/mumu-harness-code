/**
 * 输入区：文字 + 图片混合发送。
 * 支持三种加图方式：点击选择 / 拖拽到面板 / Ctrl(⌘)+V 粘贴。
 * 图片在前端压缩后转 dataURL（P1 直接随请求发送；P2 起改为上传到服务端再带 URL）。
 */
import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { PROVIDER_ORDER, cx } from '@shared';
import { IMAGE_LIMITS, compressImages, formatBytes, type ImageItem } from '../lib/image';
import { useStore } from '../store/useStore';
import { ImageStrip } from './ImageStrip';

interface Props {
  onSend: (text: string, images: ImageItem[]) => void;
  /** 当前会话在生成的回复数量：>0 时显示"停止全部" */
  streaming: number;
  placeholder?: string;
}

export function Composer({ onSend, streaming, placeholder }: Props) {
  const [text, setText] = useState('');
  const [images, setImages] = useState<ImageItem[]>([]);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);

  const enabled = useStore((s) => s.ui.enabled);
  const toast = useStore((s) => s.toast);
  const stopAll = useStore((s) => s.stopAll);

  const fileRef = useRef<HTMLInputElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const enabledCount = PROVIDER_ORDER.filter((p) => enabled[p]).length;
  const totalBytes = images.reduce((sum, i) => sum + i.size, 0);

  /** 让输入框随内容长高（上限 200px） */
  const autoResize = useCallback(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(200, el.scrollHeight)}px`;
  }, []);

  useEffect(() => {
    autoResize();
  }, [text, autoResize]);

  const addFiles = useCallback(
    async (files: File[]) => {
      const list = files.filter((f) => f.type.startsWith('image/'));
      if (list.length === 0) return;
      setBusy(true);
      try {
        const items = await compressImages(list, images.length);
        if (items.length === 0) {
          toast(`最多 ${IMAGE_LIMITS.maxCount} 张图片`, 'error');
          return;
        }
        if (items.length < list.length) {
          toast(`最多 ${IMAGE_LIMITS.maxCount} 张图片，已保留前 ${items.length} 张`, 'info');
        }
        setImages((prev) => [...prev, ...items]);
      } catch (err) {
        toast(err instanceof Error ? err.message : '图片处理失败', 'error');
      } finally {
        setBusy(false);
      }
    },
    [images.length, toast],
  );

  const handleSend = useCallback(() => {
    if (busy) return;
    if (!text.trim() && images.length === 0) {
      toast('请输入内容或添加图片', 'error');
      return;
    }
    if (enabledCount === 0) {
      toast('至少勾选一个 AI 再发送', 'error');
      return;
    }
    onSend(text, images);
    setText('');
    setImages([]);
    requestAnimationFrame(autoResize);
  }, [autoResize, busy, enabledCount, images, onSend, text, toast]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    // Ctrl / ⌘ + Enter 发送
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      handleSend();
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>): void => {
    const files: File[] = [];
    for (const item of Array.from(e.clipboardData.items)) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length > 0) {
      e.preventDefault();
      void addFiles(files);
    }
  };

  return (
    <div
      className={cx('glass p-2.5 transition', dragging && 'drag-active')}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        void addFiles(Array.from(e.dataTransfer.files));
      }}
    >
      <div className="flex items-end gap-2">
        <textarea
          ref={taRef}
          data-testid="composer-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          rows={1}
          placeholder={placeholder ?? '输入问题…（Ctrl/⌘ + Enter 发送，可拖拽或粘贴图片）'}
          className="field max-h-[200px] min-h-[44px] flex-1"
        />

        <div className="flex flex-none flex-col gap-1.5">
          <button
            type="button"
            className="btn btn-xs"
            disabled={busy || images.length >= IMAGE_LIMITS.maxCount}
            onClick={() => fileRef.current?.click()}
            title={`添加图片（压缩到最长边 ${IMAGE_LIMITS.maxDim}px，最多 ${IMAGE_LIMITS.maxCount} 张）`}
          >
            {busy ? '压缩中…' : '＋图片'}
          </button>

          {streaming > 0 ? (
            <button type="button" data-testid="composer-stop" className="btn btn-xs border-rose-400/40 text-rose-200" onClick={stopAll} title="停止所有正在生成的回复（Esc）">
              停止 {streaming}
            </button>
          ) : (
            <button type="button" data-testid="composer-send" className="btn btn-primary btn-xs" onClick={handleSend} disabled={busy}>
              发送
            </button>
          )}
        </div>
      </div>

      <ImageStrip
        images={images}
        size={58}
        onRemove={(id) => setImages((prev) => prev.filter((i) => i.id !== id))}
      />

      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500">
        <span>
          将发送给 <b className="text-slate-300">{enabledCount}</b> 个 AI
          {enabledCount === 0 && <span className="text-rose-300">（请在上方勾选）</span>}
        </span>
        {images.length > 0 && (
          <span>
            {images.length} 张图片 · 共 {formatBytes(totalBytes)}
          </span>
        )}
        <span className="hidden sm:inline">拖拽 / 粘贴图片 · Ctrl(⌘)+Enter 发送 · Esc 停止</span>
      </div>

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          void addFiles(Array.from(e.target.files ?? []));
          e.target.value = '';
        }}
      />
    </div>
  );
}
