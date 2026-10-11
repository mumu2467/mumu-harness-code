/** 导出菜单：Markdown（带图片） / JSON（完整结构） */
import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store/useStore';

export function ExportMenu() {
  const [open, setOpen] = useState(false);
  const exportSession = useStore((s) => s.exportSession);
  const session = useStore((s) => s.sessions.find((x) => x.id === s.activeSessionId) ?? null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const turns = session?.turns.length ?? 0;

  return (
    <div className="relative" ref={wrapRef}>
      <button
        type="button"
        className="btn btn-xs"
        onClick={() => setOpen((v) => !v)}
        title="导出当前会话"
        disabled={turns === 0}
      >
        导出 ▾
      </button>

      {open && (
        <div className="glass-strong absolute right-0 z-40 mt-1.5 w-56 animate-fade-in p-1 shadow-2xl">
          <button
            type="button"
            className="block w-full rounded-lg px-2.5 py-2 text-left text-[13px] text-slate-200 transition hover:bg-white/10"
            onClick={() => {
              exportSession('md');
              setOpen(false);
            }}
          >
            <div className="font-medium">Markdown（.md）</div>
            <div className="text-[11px] text-slate-500">按轮次分节，含各家回答、统计与投票</div>
          </button>
          <button
            type="button"
            className="block w-full rounded-lg px-2.5 py-2 text-left text-[13px] text-slate-200 transition hover:bg-white/10"
            onClick={() => {
              exportSession('json');
              setOpen(false);
            }}
          >
            <div className="font-medium">JSON（.json）</div>
            <div className="text-[11px] text-slate-500">完整结构，含图片 dataURL 与投票</div>
          </button>
          <div className="px-2.5 py-1.5 text-[11px] text-slate-500">
            共 {turns} 轮 · {session?.title}
          </div>
        </div>
      )}
    </div>
  );
}
