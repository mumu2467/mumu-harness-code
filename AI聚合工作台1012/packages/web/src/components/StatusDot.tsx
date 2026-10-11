/** 状态圆点：灰=加载中（呼吸）· 绿=已完成 · 红=失败 */
import type { ReplyStatus } from '@shared';

export function StatusDot({
  status,
  title,
  size = 8,
}: {
  status: ReplyStatus | 'idle';
  title?: string;
  size?: number;
}) {
  const cls = status === 'done' ? 'dot-done' : status === 'error' ? 'dot-error' : 'dot-pending';
  return (
    <span
      className={`dot ${cls}`}
      style={{ width: size, height: size }}
      title={title ?? STATUS_LABEL[status]}
    />
  );
}

export const STATUS_LABEL: Record<ReplyStatus | 'idle', string> = {
  idle: '未参与',
  pending: '等待首字',
  streaming: '输出中',
  done: '已完成',
  error: '失败',
};

export function StatusBadge({ status }: { status: ReplyStatus | 'idle' }) {
  const color =
    status === 'done'
      ? 'text-emerald-300/90'
      : status === 'error'
        ? 'text-rose-300/90'
        : 'text-slate-400';
  return (
    <span className={`inline-flex items-center gap-1 text-[11px] ${color}`}>
      <StatusDot status={status} />
      {STATUS_LABEL[status]}
    </span>
  );
}
