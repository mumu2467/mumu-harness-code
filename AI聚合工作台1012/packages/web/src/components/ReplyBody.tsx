/**
 * 一条 AI 回复的正文渲染：loading / 流式打字机 / 完成统计 / 错误态 + 重试。
 * 三窗并发页与聚合页共用这一个组件，保证两处视觉与行为一致。
 */
import { useState } from 'react';
import { PROVIDER_META, cx, formatMs, type ErrorCode, type Provider } from '@shared';
import type { ReplyState } from '../store/useStore';
import { useStore } from '../store/useStore';
import { renderMarkdown } from '../lib/markdown';
import { hexA } from '../lib/color';

/** 错误分类 → 人话 + 建议动作 */
function explainError(code?: ErrorCode): string {
  switch (code) {
    case 'needLogin':
      return '该站点登录态失效，需要重新登录后重试。';
    case 'risk':
      return '命中人机/风控验证，需要人工在该站点页面里处理一次。';
    case 'selector':
      return '页面结构可能已改版，选择器需要更新（可跑 /api/diag/selectors 诊断）。';
    case 'timeout':
      return '等待回答超时，可能是站点繁忙或网络较慢。';
    case 'network':
      return '网络或站点接口异常，稍后重试即可。';
    case 'aborted':
      return '本次生成已被停止或中断。';
    default:
      return '';
  }
}

export function ReplyBody({
  provider,
  reply,
  onRetry,
  onStop,
  compact = false,
}: {
  provider: Provider;
  reply: ReplyState;
  onRetry?: () => void;
  onStop?: () => void;
  compact?: boolean;
}) {
  const toast = useStore((s) => s.toast);
  const [showReasoning, setShowReasoning] = useState(false);
  const meta = PROVIDER_META[provider];

  const streaming = reply.status === 'pending' || reply.status === 'streaming';
  const hasStats =
    reply.firstTokenMs !== undefined || reply.latencyMs !== undefined || reply.tokenEst !== undefined;

  const copy = (): void => {
    void navigator.clipboard
      .writeText(reply.content)
      .then(() => toast(`已复制 ${meta.label} 的回答`, 'success'))
      .catch(() => toast('复制失败：浏览器拒绝了剪贴板访问', 'error'));
  };

  /* ---------------- 思考中 ---------------- */
  if (reply.status === 'pending') {
    return (
      <div className="flex items-center gap-2 py-1 text-[13px]">
        <span className="sheen-text font-medium">{meta.label} 正在思考</span>
        <span className="flex gap-1">
          <i className="dot dot-pending" />
          <i className="dot dot-pending" style={{ animationDelay: '0.15s' }} />
          <i className="dot dot-pending" style={{ animationDelay: '0.3s' }} />
        </span>
      </div>
    );
  }

  return (
    <div className="group/reply">
      {/* 思考过程（默认折叠） */}
      {reply.reasoning && (
        <div className="mb-1.5">
          <button
            type="button"
            className="btn btn-ghost btn-xs text-slate-400"
            onClick={() => setShowReasoning((v) => !v)}
          >
            {showReasoning ? '▾' : '▸'} 思考过程
          </button>
          {showReasoning && (
            <pre className="scroll-thin mt-1 max-h-56 overflow-auto whitespace-pre-wrap rounded-lg border border-white/10 bg-black/30 p-2 text-[12px] leading-relaxed text-slate-400">
              {reply.reasoning}
            </pre>
          )}
        </div>
      )}

      {/* 正文 */}
      {reply.content ? (
        <div
          className={cx('md', streaming && 'typing-caret')}
          // 安全性由 renderMarkdown 的"先转义后拼标签"保证
          dangerouslySetInnerHTML={{ __html: renderMarkdown(reply.content) }}
        />
      ) : reply.status === 'error' ? null : (
        <div className="text-[13px] text-slate-500">（已收到空内容）</div>
      )}

      {/* 错误态 */}
      {reply.status === 'error' && (
        <div
          className="mt-1 rounded-lg border px-2.5 py-2 text-[12px]"
          style={{ borderColor: 'rgba(248,113,113,0.35)', background: 'rgba(248,113,113,0.08)' }}
        >
          <div className="font-medium text-rose-200">{reply.error || '生成失败'}</div>
          {explainError(reply.errorCode) && (
            <div className="mt-0.5 text-rose-200/70">{explainError(reply.errorCode)}</div>
          )}
          <div className="mt-1.5 flex gap-1.5">
            {onRetry && (
              <button type="button" className="btn btn-xs" onClick={onRetry}>
                重试
              </button>
            )}
            {reply.content && (
              <button type="button" className="btn btn-xs" onClick={copy}>
                复制已有内容
              </button>
            )}
          </div>
        </div>
      )}

      {/* 统计与操作 */}
      <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-slate-500">
        {hasStats && (
          <>
            {reply.firstTokenMs !== undefined && <span>首字 {formatMs(reply.firstTokenMs)}</span>}
            {reply.latencyMs !== undefined && <span>耗时 {formatMs(reply.latencyMs)}</span>}
            {reply.tokenEst !== undefined && (
              <span title="网页版拿不到真实 usage，这里是按字符数估算">≈{reply.tokenEst} tokens</span>
            )}
          </>
        )}
        {reply.stopped && <span className="text-amber-300/80">已停止</span>}

        {!compact && (
          <span className="ml-auto flex gap-1.5 opacity-0 transition group-hover/reply:opacity-100">
            {reply.content && (
              <button type="button" className="btn btn-ghost btn-xs" onClick={copy}>
                复制
              </button>
            )}
            {streaming && onStop && (
              <button type="button" className="btn btn-ghost btn-xs text-rose-200" onClick={onStop}>
                停止
              </button>
            )}
          </span>
        )}
      </div>
    </div>
  );
}

/** 供聚合页并排视图用的极简卡片头 */
export function ReplyStatusStrip({ reply, provider }: { reply?: ReplyState; provider: Provider }) {
  const meta = PROVIDER_META[provider];
  const status = reply?.status ?? 'idle';
  return (
    <div className="flex items-center gap-2 text-[11px] text-slate-400">
      <span className="inline-block h-2 w-2 rounded-full" style={{ background: hexA(meta.accent, 0.9) }} />
      {status === 'pending' ? '等待首字' : status === 'streaming' ? '输出中' : status === 'done' ? `完成 · ${formatMs(reply?.latencyMs)}` : status === 'error' ? '失败' : '未参与'}
    </div>
  );
}
