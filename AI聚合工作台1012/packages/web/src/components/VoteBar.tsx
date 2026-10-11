/** 点赞 / 标记最佳答案。数据写在 store.votes 里并随 localStorage 持久化 */
import { cx, type Provider } from '@shared';
import { useStore, type VoteState } from '../store/useStore';

/** 投票的 key 用 turnId + provider，避免依赖可能后到的 replyId */
export function voteKeyOf(turnId: string, provider: Provider): string {
  return `${turnId}:${provider}`;
}

/**
 * ★ 稳定的空对象常量，必须有 ★
 *
 * zustand v5 基于 useSyncExternalStore：选择器每次返回**新引用**时，
 * 它认为快照变了 → 重新渲染 → 又拿到新引用 → 无限循环（React #185）。
 * 之前的写法 `?? {}` 每次调用都造一个新对象，正好踩中这个坑，
 * 表现是"一进聚合页整棵组件树就崩掉"。
 */
const EMPTY_VOTE: VoteState = {};

export function useVote(turnId: string, provider: Provider): VoteState {
  return useStore((s) => {
    const session = s.sessions.find((x) => x.id === s.activeSessionId);
    return session?.votes[voteKeyOf(turnId, provider)] ?? EMPTY_VOTE;
  });
}

export function VoteBar({ turnId, provider }: { turnId: string; provider: Provider }) {
  const vote = useVote(turnId, provider);
  const setVote = useStore((s) => s.setVote);

  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        data-testid="vote-like"
        onClick={() => setVote(turnId, provider, 'like')}
        title="这个回答有用"
        className={cx('btn btn-ghost btn-xs', vote.like ? 'text-emerald-300' : 'text-slate-500')}
      >
        👍 有用{vote.like ? ' ✓' : ''}
      </button>
      <button
        type="button"
        data-testid="vote-best"
        onClick={() => setVote(turnId, provider, 'best')}
        title="标记为这一轮的最佳答案（同一轮只能有一个）"
        className={cx('btn btn-ghost btn-xs', vote.best ? 'text-amber-300' : 'text-slate-500')}
      >
        ⭐ 最佳{vote.best ? ' ✓' : ''}
      </button>
    </div>
  );
}
