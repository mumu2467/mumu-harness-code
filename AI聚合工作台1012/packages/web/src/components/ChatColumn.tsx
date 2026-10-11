/**
 * 三窗并发页里的单个聊天窗口。
 * 每个窗口完全独立：自己的滚动位置、自己的停止/清空/新会话、自己的错误与重试。
 */
import { useEffect, useRef } from 'react';
import { PROVIDER_META, cx, formatMs, type Provider } from '@shared';
import { useActiveSession, useStore } from '../store/useStore';
import { EmptyState } from './Empty';
import { ImageStrip } from './ImageStrip';
import { ProviderAvatar } from './ProviderAvatar';
import { ReplyBody } from './ReplyBody';
import { StatusDot } from './StatusDot';

export function ChatColumn({
  provider,
  hiddenOnMobile,
}: {
  provider: Provider;
  hiddenOnMobile: boolean;
}) {
  const meta = PROVIDER_META[provider];
  const session = useActiveSession();
  const runtime = useStore((s) => s.providers[provider]);
  const enabled = useStore((s) => s.ui.enabled[provider]);
  const clearColumn = useStore((s) => s.clearColumn);
  const newProviderSession = useStore((s) => s.newProviderSession);
  const retryReply = useStore((s) => s.retryReply);
  const stopReply = useStore((s) => s.stopReply);

  const bodyRef = useRef<HTMLDivElement>(null);
  /** 只有用户本来就贴在底部时才自动跟随，否则会被"抢滚动" */
  const stick = useRef(true);

  const clearedAt = session?.clearedAt[provider] ?? 0;
  const turns = (session?.turns ?? []).filter(
    (t) => t.order.includes(provider) && t.createdAt > clearedAt,
  );
  const lastReply = turns.length > 0 ? turns[turns.length - 1].replies[provider] : undefined;
  const streaming = lastReply?.status === 'pending' || lastReply?.status === 'streaming';

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    if (stick.current) el.scrollTop = el.scrollHeight;
  });

  const onScroll = (): void => {
    const el = bodyRef.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  return (
    <section
      data-testid={`column-${provider}`}
      className={cx(
        'pv-' + provider,
        'glass flex min-h-0 flex-col overflow-hidden',
        hiddenOnMobile ? 'hidden md:flex' : 'flex',
      )}
      style={{ borderColor: enabled ? undefined : 'rgba(255,255,255,0.06)' }}
    >
      {/* 窗口头 */}
      <header className="flex flex-none items-center gap-2 border-b border-white/10 px-3 py-2">
        <ProviderAvatar provider={provider} size={30} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium text-slate-100">{meta.label}</span>
            {!enabled && <span className="chip text-[10px] text-slate-500">未勾选</span>}
            <StatusDot
              status={streaming ? 'pending' : (lastReply?.status ?? 'idle')}
              title={
                streaming
                  ? '生成中'
                  : lastReply?.status === 'done'
                    ? `完成 · ${formatMs(lastReply.latencyMs)}`
                    : lastReply?.status === 'error'
                      ? '失败'
                      : '空闲'
              }
            />
          </div>
          <div className="truncate text-[11px] text-slate-500">
            {runtime?.note ?? meta.desc}
            {runtime?.login === 'needLogin' && <span className="text-amber-300"> · 需要登录</span>}
            {runtime?.login === 'needManual' && <span className="text-amber-300"> · 需要人工处理验证码</span>}
          </div>
        </div>

        <div className="flex flex-none items-center gap-1">
          {streaming && (
            <button
              type="button"
              className="btn btn-ghost btn-xs text-rose-200"
              title="停止这个窗口的生成"
              onClick={() => {
                const last = turns[turns.length - 1];
                if (last) void stopReply(last.id, provider);
              }}
            >
              停止
            </button>
          )}
          <button
            type="button"
            className="btn btn-ghost btn-xs"
            title="只清空这个窗口的显示（不动站点上下文）"
            onClick={() => clearColumn(provider)}
          >
            清空
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-xs"
            title="让该站点开启新对话（清空站点上下文）并清空本窗口"
            onClick={() => void newProviderSession(provider)}
          >
            新会话
          </button>
        </div>
      </header>

      {/* 消息区（独立滚动，与其他窗口不同步） */}
      <div ref={bodyRef} onScroll={onScroll} className="scroll-thin min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {turns.length === 0 ? (
          <EmptyState
            title={`${meta.label} 还没有消息`}
            hint={enabled ? '发送后会显示在这里。' : '当前未勾选，发送时不会带上它。'}
            showProviders={false}
          />
        ) : (
          turns.map((turn) => {
            const reply = turn.replies[provider];
            if (!reply) return null;
            return (
              <div key={turn.id} className="animate-fade-in space-y-2">
                {/* 用户消息 */}
                <div className="flex justify-end">
                  <div className="max-w-[88%] rounded-xl border border-white/10 bg-white/[0.07] px-2.5 py-1.5 text-[13px] text-slate-200">
                    {turn.text && <div className="whitespace-pre-wrap break-words">{turn.text}</div>}
                    {turn.images.length > 0 && <ImageStrip images={turn.images} size={48} />}
                  </div>
                </div>

                {/* AI 回复 */}
                <div className="rounded-xl border border-white/10 bg-black/20 px-3 py-2">
                  <ReplyBody
                    provider={provider}
                    reply={reply}
                    onRetry={() => void retryReply(turn.id, provider)}
                    onStop={() => void stopReply(turn.id, provider)}
                  />
                </div>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}
