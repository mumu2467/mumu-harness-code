/**
 * 页面 1：三窗并发页
 *
 * 布局：顶部输入区 → 下方三列等宽聊天窗
 *   响应式：≥1280px 三列；768–1280px 两列；<768px 变 Tab 切换
 *   三窗滚动互不同步（各自一个滚动容器，见 ChatColumn）
 */
import { PROVIDER_META, PROVIDER_ORDER, cx } from '@shared';
import { ChatColumn } from '../components/ChatColumn';
import { Composer } from '../components/Composer';
import { useStore, useStreamingCount } from '../store/useStore';
import { hexA } from '../lib/color';

export function ConcurrentPage() {
  const enabled = useStore((s) => s.ui.enabled);
  const mobileTab = useStore((s) => s.ui.mobileTab);
  const setMobileTab = useStore((s) => s.setMobileTab);
  const sendMessage = useStore((s) => s.sendMessage);
  const streaming = useStreamingCount();

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-3">
      <Composer onSend={(text, images) => void sendMessage(text, images)} streaming={streaming} />

      {/* 移动端：<768px 用 Tab 切换，避免三列挤成一团 */}
      <div className="flex flex-none gap-1.5 md:hidden">
        {PROVIDER_ORDER.map((p) => {
          const meta = PROVIDER_META[p];
          const active = mobileTab === p;
          return (
            <button
              key={p}
              type="button"
              onClick={() => setMobileTab(p)}
              className={cx(
                'flex flex-1 items-center justify-center gap-1.5 rounded-xl border px-2 py-1.5 text-[12px] transition',
                active ? 'text-white' : 'border-white/10 bg-white/[0.03] text-slate-400',
              )}
              style={active ? { borderColor: hexA(meta.accent, 0.5), background: hexA(meta.accent, 0.16) } : undefined}
            >
              {meta.label}
              {!enabled[p] && <span className="text-[10px] opacity-60">未勾选</span>}
            </button>
          );
        })}
      </div>

      {/* 三列（md 两列 / xl 三列） */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {PROVIDER_ORDER.map((p) => (
          <ChatColumn key={p} provider={p} hiddenOnMobile={mobileTab !== p} />
        ))}
      </div>
    </div>
  );
}
