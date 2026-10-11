/**
 * 页面 2：聚合对话页
 *
 * 布局：单列 IM 流。用户消息在右侧气泡，三家的回复聚合在左侧同一个气泡里，
 *       气泡右上角用 Tab 切换（切换时淡入替换并保留滚动位置），
 *       也可以一键切成"并排对比"三列。
 * 底部是输入区（IM 习惯的位置）。
 */
import { useCallback, useEffect, useRef } from 'react';
import { PROVIDER_META, cx, formatMs, type Provider } from '@shared';
import { Composer } from '../components/Composer';
import { EmptyState } from '../components/Empty';
import { ImageStrip } from '../components/ImageStrip';
import { ParallelCompare } from '../components/ParallelCompare';
import { ProviderAvatar } from '../components/ProviderAvatar';
import { ProviderTabs } from '../components/ProviderTabs';
import { ReplyBody } from '../components/ReplyBody';
import { VoteBar } from '../components/VoteBar';
import { useActiveSession, useStore, useStreamingCount, type Turn } from '../store/useStore';

export function AggregatePage() {
  const session = useActiveSession();
  const sendMessage = useStore((s) => s.sendMessage);
  const streaming = useStreamingCount();

  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const turns = session?.turns ?? [];

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (stick.current) el.scrollTop = el.scrollHeight;
  });

  const onScroll = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };

  /**
   * 切换 provider 时保留滚动位置：
   * 记录当前 scrollTop → 触发状态更新 → 连续两帧后恢复。
   * （双 rAF 是为了等 React 提交 DOM 之后再恢复，否则会被布局变化覆盖）
   */
  const withPreservedScroll = useCallback((fn: () => void) => {
    const el = scrollRef.current;
    const top = el?.scrollTop ?? 0;
    fn();
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (el) el.scrollTop = top;
      });
    });
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="scroll-thin min-h-0 flex-1 space-y-5 overflow-y-auto px-3 py-4 lg:px-6"
      >
        {turns.length === 0 ? (
          <EmptyState />
        ) : (
          turns.map((turn) => (
            <TurnBlock key={turn.id} turn={turn} withPreservedScroll={withPreservedScroll} />
          ))
        )}
      </div>

      <div className="flex-none border-t border-white/10 bg-white/[0.02] p-3 backdrop-blur-xl">
        <Composer
          onSend={(text, images) => void sendMessage(text, images)}
          streaming={streaming}
          placeholder="继续追问…（Ctrl/⌘ + Enter 发送）"
        />
      </div>
    </div>
  );
}

/** 一轮对话：右侧用户气泡 + 左侧聚合 AI 气泡 */
function TurnBlock({
  turn,
  withPreservedScroll,
}: {
  turn: Turn;
  withPreservedScroll: (fn: () => void) => void;
}) {
  const activeTabRaw = useStore((s) => s.ui.activeTab[turn.id]);
  const parallel = useStore((s) => s.ui.parallel[turn.id] ?? false);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const toggleParallel = useStore((s) => s.toggleParallel);
  const retryReply = useStore((s) => s.retryReply);
  const stopReply = useStore((s) => s.stopReply);

  const active: Provider =
    activeTabRaw && turn.order.includes(activeTabRaw) ? activeTabRaw : turn.order[0];
  const reply = turn.replies[active];
  const doneCount = turn.order.filter((p) => turn.replies[p]?.status === 'done').length;
  const errorCount = turn.order.filter((p) => turn.replies[p]?.status === 'error').length;

  const select = (p: Provider): void => {
    withPreservedScroll(() => {
      if (parallel) toggleParallel(turn.id);
      setActiveTab(turn.id, p);
    });
  };

  return (
    <div className="animate-fade-in space-y-2.5">
      {/* 用户消息（右） */}
      <div className="flex justify-end">
        <div className="max-w-[min(78%,720px)] rounded-xl border border-white/10 bg-white/[0.07] px-3 py-2">
          {turn.text && <div className="whitespace-pre-wrap break-words text-[14px] text-slate-100">{turn.text}</div>}
          {turn.images.length > 0 && <ImageStrip images={turn.images} size={72} />}
          <div className="mt-1 text-right text-[10px] text-slate-500">
            {new Date(turn.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} · 发给{' '}
            {turn.order.length} 家
          </div>
        </div>
      </div>

      {/* AI 聚合回复（左） */}
      <div className="flex gap-2.5">
        <div className="flex flex-none flex-col gap-1 pt-1">
          {turn.order.map((p) => (
            <ProviderAvatar key={p} provider={p} size={22} />
          ))}
        </div>

        <div className="glass-strong min-w-0 flex-1 p-3">
          {/* 右上角切换控件 */}
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div className="text-[11px] text-slate-500">
              {doneCount}/{turn.order.length} 家已完成
              {errorCount > 0 && <span className="text-rose-300/80"> · {errorCount} 家失败</span>}
            </div>
            <ProviderTabs
              order={turn.order}
              active={active}
              replies={turn.replies}
              onSelect={select}
              parallel={parallel}
              onToggleParallel={() => toggleParallel(turn.id)}
            />
          </div>

          {/* 正文：单栏（淡入切换） 或 并排对比 */}
          {parallel ? (
            <ParallelCompare turn={turn} />
          ) : (
            <div key={active} className="animate-fade-in">
              {reply ? (
                <ReplyBody
                  provider={active}
                  reply={reply}
                  onRetry={() => void retryReply(turn.id, active)}
                  onStop={() => void stopReply(turn.id, active)}
                />
              ) : (
                <div className="text-[13px] text-slate-500">这一轮没有该 AI 的回复</div>
              )}
            </div>
          )}

          {/* 底部：投票 + 当前来源提示 */}
          <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 border-t border-white/5 pt-2">
            <VoteBar turnId={turn.id} provider={parallel ? active : active} />
            <span className="text-[11px] text-slate-500">
              {PROVIDER_META[active].label}
              {reply?.latencyMs !== undefined && ` · ${formatMs(reply.latencyMs)}`}
              {parallel && '（并排模式，可在每张卡片上单独投票）'}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
