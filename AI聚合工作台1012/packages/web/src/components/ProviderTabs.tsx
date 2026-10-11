/**
 * 聚合页气泡右上角的切换控件：在 DeepSeek / 豆包 / Kimi 之间切换。
 * 每个 Tab 带状态圆点（灰=加载中 · 绿=完成 · 红=失败）与耗时，一眼看出哪家先答完。
 */
import { PROVIDER_META, cx, formatMs, type Provider } from '@shared';
import type { ReplyState } from '../store/useStore';
import { hexA } from '../lib/color';
import { StatusDot } from './StatusDot';

export function ProviderTabs({
  order,
  active,
  replies,
  onSelect,
  parallel,
  onToggleParallel,
}: {
  order: Provider[];
  active: Provider;
  replies: Partial<Record<Provider, ReplyState>>;
  onSelect: (p: Provider) => void;
  parallel: boolean;
  onToggleParallel: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <div className="glass inline-flex flex-wrap gap-0.5 p-0.5">
        {order.map((p) => {
          const meta = PROVIDER_META[p];
          const reply = replies[p];
          const status = reply?.status ?? 'idle';
          const isActive = active === p && !parallel;
          return (
            <button
              key={p}
              type="button"
              data-testid={`tab-${p}`}
              onClick={() => onSelect(p)}
              title={`切换到 ${meta.label}${reply?.latencyMs !== undefined ? ` · 耗时 ${formatMs(reply.latencyMs)}` : ''}`}
              className={cx(
                'inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-[12px] transition',
                isActive ? 'font-medium text-white' : 'text-slate-400 hover:text-slate-200',
              )}
              style={isActive ? { background: hexA(meta.accent, 0.22), boxShadow: `inset 0 0 0 1px ${hexA(meta.accent, 0.5)}` } : undefined}
            >
              <StatusDot status={status} size={7} />
              {meta.label}
              {reply?.latencyMs !== undefined && (
                <span className="text-[10px] text-slate-500">{formatMs(reply.latencyMs)}</span>
              )}
            </button>
          );
        })}
      </div>

      <button
        type="button"
        data-testid="parallel-toggle"
        onClick={onToggleParallel}
        title="把这一轮的三家回复变成三列对比视图"
        className={cx('btn btn-xs', parallel && 'border-white/25 text-white')}
      >
        {parallel ? '▣ 单栏' : '▥ 并排'}
      </button>
    </div>
  );
}
