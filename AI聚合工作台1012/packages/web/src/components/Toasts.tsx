/** 轻量 Toast：右下角堆叠，自动消失（错误停留更久） */
import { cx } from '@shared';
import { useStore } from '../store/useStore';

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[min(92vw,360px)] flex-col gap-2">
      {toasts.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => dismiss(t.id)}
          className={cx(
            'glass-strong pointer-events-auto animate-fade-in px-3 py-2 text-left text-[13px] shadow-xl',
            t.kind === 'error' ? 'border-rose-400/40 text-rose-100' : '',
            t.kind === 'success' ? 'border-emerald-400/40 text-emerald-100' : '',
            t.kind === 'info' ? 'text-slate-200' : '',
          )}
        >
          <span className="mr-1.5 opacity-70">
            {t.kind === 'error' ? '⚠' : t.kind === 'success' ? '✓' : 'ℹ'}
          </span>
          {t.text}
        </button>
      ))}
    </div>
  );
}
