/**
 * 顶部全局开关：☑DeepSeek ☑豆包 ☑Kimi
 * 取消勾选的 AI 不接收消息（发送时直接不进 providers 数组）。
 * 开关的边框/底色用各家品牌色，右侧小点显示当前登录态。
 */
import { PROVIDER_META, PROVIDER_ORDER, cx, type Provider } from '@shared';
import { useStore } from '../store/useStore';
import { hexA } from '../lib/color';
import { StatusDot } from './StatusDot';

export function ProviderToggles({ compact = false }: { compact?: boolean }) {
  const enabled = useStore((s) => s.ui.enabled);
  const setEnabled = useStore((s) => s.setEnabled);
  const providers = useStore((s) => s.providers);

  return (
    <div className="flex items-center gap-1.5">
      {PROVIDER_ORDER.map((p) => (
        <Toggle key={p} provider={p} on={enabled[p]} runtime={providers[p]} compact={compact} onToggle={(v) => setEnabled(p, v)} />
      ))}
    </div>
  );
}

function Toggle({
  provider,
  on,
  runtime,
  compact,
  onToggle,
}: {
  provider: Provider;
  on: boolean;
  runtime: { login: string; generating: boolean };
  compact: boolean;
  onToggle: (v: boolean) => void;
}) {
  const meta = PROVIDER_META[provider];
  const login = runtime?.login ?? 'unknown';
  const loginTitle =
    login === 'loggedIn' ? '已登录' : login === 'needLogin' ? '需要登录' : login === 'needManual' ? '需要人工处理验证码' : login === 'error' ? '状态异常' : '状态未知';

  return (
    <button
      type="button"
      onClick={() => onToggle(!on)}
      title={`${on ? '取消勾选后不发送给它' : '勾选后一起发送'} · ${loginTitle}`}
      className={cx(
        'chip pv-' + provider,
        'transition',
        compact ? 'px-1.5 py-0.5' : 'px-2 py-1',
        on ? 'text-white' : 'text-slate-400 opacity-60 hover:opacity-90',
      )}
      style={
        on
          ? { borderColor: hexA(meta.accent, 0.55), background: hexA(meta.accent, 0.16) }
          : undefined
      }
    >
      <span
        className="inline-block h-2.5 w-2.5 flex-none rounded-[3px] border"
        style={{
          borderColor: on ? hexA(meta.accent, 0.9) : 'rgba(255,255,255,0.35)',
          background: on ? `linear-gradient(135deg, ${meta.accent}, ${meta.accent2})` : 'transparent',
        }}
      />
      <span className="font-medium">{meta.label}</span>
      <StatusDot status={login === 'loggedIn' ? 'done' : login === 'unknown' ? 'idle' : 'error'} size={6} title={loginTitle} />
    </button>
  );
}
