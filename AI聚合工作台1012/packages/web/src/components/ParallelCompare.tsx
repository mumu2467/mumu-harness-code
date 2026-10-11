/**
 * 并排对比视图：把一轮里几家的回答变成等宽多列，方便横向看差异。
 * 每家卡片自带状态、耗时、投票与各自的重试入口。
 */
import { PROVIDER_META, cx, formatMs } from '@shared';
import type { Turn } from '../store/useStore';
import { useStore } from '../store/useStore';
import { ReplyBody } from './ReplyBody';
import { ProviderAvatar } from './ProviderAvatar';
import { StatusDot } from './StatusDot';
import { useVote } from './VoteBar';

export function ParallelCompare({ turn }: { turn: Turn }) {
  const retryReply = useStore((s) => s.retryReply);
  const stopReply = useStore((s) => s.stopReply);
  const setVote = useStore((s) => s.setVote);

  return (
    <div
      className={cx(
        'grid gap-2',
        turn.order.length >= 3 ? 'grid-cols-1 md:grid-cols-2 xl:grid-cols-3' : 'grid-cols-1 md:grid-cols-2',
      )}
    >
      {turn.order.map((p) => {
        const meta = PROVIDER_META[p];
        const reply = turn.replies[p];
        const vote = useVote(turn.id, p);
        return (
          <div
            key={p}
            className={cx(
              'pv-' + p,
              'flex min-h-[120px] flex-col rounded-xl border bg-black/20 p-2.5',
              vote.best ? 'border-amber-300/50' : 'border-white/10',
            )}
          >
            <div className="mb-1.5 flex items-center gap-2">
              <ProviderAvatar provider={p} size={22} />
              <span className="text-[13px] font-medium text-slate-100">{meta.label}</span>
              <StatusDot status={reply?.status ?? 'idle'} />
              <span className="ml-auto flex items-center gap-1.5 text-[10px] text-slate-500">
                {reply?.latencyMs !== undefined && <span>{formatMs(reply.latencyMs)}</span>}
                <button
                  type="button"
                  className={cx('btn btn-ghost btn-xs px-1', vote.like ? 'text-emerald-300' : 'text-slate-500')}
                  onClick={() => setVote(turn.id, p, 'like')}
                  title="有用"
                >
                  👍
                </button>
                <button
                  type="button"
                  className={cx('btn btn-ghost btn-xs px-1', vote.best ? 'text-amber-300' : 'text-slate-500')}
                  onClick={() => setVote(turn.id, p, 'best')}
                  title="标记为最佳答案"
                >
                  ⭐
                </button>
              </span>
            </div>

            {reply ? (
              // 卡片内容独立滚动：让三列各自可读，而不是被 overflow-hidden 直接切掉
              <div className="scroll-thin max-h-[46vh] min-h-0 flex-1 overflow-y-auto pr-0.5">
                <ReplyBody
                  provider={p}
                  reply={reply}
                  compact
                  onRetry={() => void retryReply(turn.id, p)}
                  onStop={() => void stopReply(turn.id, p)}
                />
              </div>
            ) : (
              <div className="text-[12px] text-slate-500">这一轮未参与</div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** 并排视图里的一句"查看全部"提示（可选扩展点） */
export function ParallelSummary({ turn }: { turn: Turn }) {
  const done = turn.order.filter((p) => turn.replies[p]?.status === 'done').length;
  return (
    <div className="text-[11px] text-slate-500">
      {done}/{turn.order.length} 家已完成
    </div>
  );
}
