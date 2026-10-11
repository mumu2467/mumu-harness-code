/** AI 头像：品牌色渐变方块 + 短字符 */
import { PROVIDER_META, type Provider } from '@shared';

export function ProviderAvatar({ provider, size = 30 }: { provider: Provider; size?: number }) {
  const meta = PROVIDER_META[provider];
  return (
    <span
      // pv-<provider> 提供 --pv / --pv2 变量，pv-avatar 用它们做渐变
      className={`pv-${provider} pv-avatar inline-flex flex-none items-center justify-center rounded-xl font-semibold text-white`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }}
      title={meta.desc}
    >
      {meta.short}
    </span>
  );
}
