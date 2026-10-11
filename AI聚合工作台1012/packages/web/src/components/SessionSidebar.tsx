/**
 * 会话侧边栏：新建 / 重命名 / 删除 / 搜索。
 * 桌面端常驻左侧；<1024px 收成抽屉（由 TopBar 的 ☰ 控制）。
 */
import { useMemo, useState } from 'react';
import { ADAPTER_LABEL, cx, relativeTime } from '@shared';
import { useStore } from '../store/useStore';

export function SessionSidebar() {
  const sessions = useStore((s) => s.sessions);
  const activeId = useStore((s) => s.activeSessionId);
  const sidebarOpen = useStore((s) => s.ui.sidebarOpen);
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const newSession = useStore((s) => s.newSession);
  const selectSession = useStore((s) => s.selectSession);
  const renameSession = useStore((s) => s.renameSession);
  const deleteSession = useStore((s) => s.deleteSession);
  const mode = useStore((s) => s.mode);

  const [query, setQuery] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const list = useMemo(() => {
    const kw = query.trim().toLowerCase();
    const filtered = kw
      ? sessions.filter(
          (s) =>
            s.title.toLowerCase().includes(kw) ||
            s.turns.some((t) => t.text.toLowerCase().includes(kw)),
        )
      : sessions;
    return [...filtered].sort((a, b) => b.updatedAt - a.updatedAt);
  }, [query, sessions]);

  const startRename = (id: string, title: string): void => {
    setEditingId(id);
    setDraft(title);
    setConfirmId(null);
  };

  const commitRename = (): void => {
    if (editingId) renameSession(editingId, draft);
    setEditingId(null);
  };

  return (
    <aside
      className={cx(
        'z-30 flex w-[272px] flex-none flex-col border-r border-white/10 bg-white/[0.03] backdrop-blur-xl',
        'fixed inset-y-0 left-0 transition-transform lg:static lg:translate-x-0',
        sidebarOpen ? 'translate-x-0' : '-translate-x-full',
      )}
    >
      <div className="flex items-center gap-2 border-b border-white/10 px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-slate-100">多 AI 聚合工作台</div>
          <div className="truncate text-[11px] text-slate-500">一条消息 · 三家同时回答</div>
        </div>
        <button
          type="button"
          className="btn btn-xs"
          title="新建会话"
          onClick={() => {
            newSession();
            setQuery('');
            toggleSidebar(false);
          }}
        >
          ＋ 新建
        </button>
      </div>

      <div className="px-3 py-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索会话或消息内容…"
          className="field py-2 text-[13px]"
        />
      </div>

      <div className="scroll-thin min-h-0 flex-1 space-y-1 overflow-y-auto px-2 pb-2">
        {list.length === 0 && (
          <div className="px-2 py-6 text-center text-xs text-slate-500">没有匹配的会话</div>
        )}

        {list.map((s) => {
          const active = s.id === activeId;
          const isEditing = editingId === s.id;
          return (
            <div
              key={s.id}
              className={cx(
                'group cursor-pointer rounded-xl border px-2.5 py-2 transition',
                active
                  ? 'border-white/20 bg-white/[0.09]'
                  : 'border-transparent hover:border-white/10 hover:bg-white/[0.05]',
              )}
              onClick={() => {
                if (isEditing) return;
                selectSession(s.id);
                toggleSidebar(false);
              }}
            >
              {isEditing ? (
                <input
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename();
                    if (e.key === 'Escape') setEditingId(null);
                  }}
                  onBlur={commitRename}
                  className="field py-1 text-[13px]"
                />
              ) : (
                <div className="flex items-center gap-1.5">
                  <span className="min-w-0 flex-1 truncate text-[13px] text-slate-200">{s.title}</span>
                  {active && <span className="chip text-[10px]">当前</span>}
                </div>
              )}

              <div className="mt-0.5 flex items-center gap-2 text-[11px] text-slate-500">
                <span>{relativeTime(s.updatedAt)}</span>
                <span>{s.turns.length} 轮</span>

                <span className="ml-auto flex gap-1 opacity-0 transition group-hover:opacity-100">
                  <button
                    type="button"
                    className="btn btn-ghost btn-xs px-1.5 py-0"
                    title="重命名"
                    onClick={(e) => {
                      e.stopPropagation();
                      startRename(s.id, s.title);
                    }}
                  >
                    ✎
                  </button>
                  {confirmId === s.id ? (
                    <button
                      type="button"
                      className="btn btn-xs border-rose-400/40 px-1.5 py-0 text-rose-200"
                      title="再次点击确认删除"
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteSession(s.id);
                        setConfirmId(null);
                      }}
                    >
                      确认
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-ghost btn-xs px-1.5 py-0"
                      title="删除会话"
                      onClick={(e) => {
                        e.stopPropagation();
                        setConfirmId(s.id);
                      }}
                    >
                      🗑
                    </button>
                  )}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      <div className="border-t border-white/10 px-3 py-2 text-[11px] text-slate-500">
        <div className="flex items-center justify-between">
          <span>通道</span>
          <span className="text-slate-300">{ADAPTER_LABEL[mode]}</span>
        </div>
        <div className="mt-0.5 opacity-80">P1：会话与投票存于浏览器本地存储</div>
      </div>
    </aside>
  );
}
