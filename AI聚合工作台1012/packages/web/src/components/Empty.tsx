/** 空态提示：没有对话时给出"下一步做什么"的引导 */
import { PROVIDER_ORDER } from '@shared';
import { ProviderAvatar } from './ProviderAvatar';

export function EmptyState({
  title = '还没有对话',
  hint = '在上面的输入框里输入问题，或直接拖拽 / 粘贴图片进来，一条消息会同时发给勾选的 AI。',
  showProviders = true,
}: {
  title?: string;
  hint?: string;
  showProviders?: boolean;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <div className="flex gap-2 opacity-80">
        {PROVIDER_ORDER.map((p) => (
          <ProviderAvatar key={p} provider={p} size={34} />
        ))}
      </div>
      <div className="text-sm font-medium text-slate-300">{title}</div>
      <p className="max-w-sm text-xs leading-relaxed text-slate-500">{hint}</p>
      {showProviders && (
        <div className="mt-1 flex flex-wrap justify-center gap-1.5 text-[11px] text-slate-500">
          <span className="chip">拖拽图片</span>
          <span className="chip">Ctrl/⌘ + V 粘贴</span>
          <span className="chip">Ctrl/⌘ + Enter 发送</span>
          <span className="chip">Esc 停止</span>
        </div>
      )}
    </div>
  );
}
