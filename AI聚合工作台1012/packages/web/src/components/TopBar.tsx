/**
 * 顶部工具栏：视图切换 + 全局 AI 开关 + 通道/连接状态 + 导出。
 */
import { useState } from 'react';
import { ADAPTER_LABEL, PROVIDER_ORDER, cx } from '@shared';
import { api } from '../api/client';
import { useActiveSession, useStore } from '../store/useStore';
import { ExportMenu } from './ExportMenu';
import { ProviderToggles } from './ProviderToggles';
import { StatusDot } from './StatusDot';

export function TopBar() {
  const view = useStore((s) => s.ui.view);
  const setView = useStore((s) => s.setView);
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const session = useActiveSession();
  const wsStatus = useStore((s) => s.wsStatus);
  const mode = useStore((s) => s.mode);
  const providers = useStore((s) => s.providers);
  const setProviders = useStore((s) => s.setProviders);
  const setMode = useStore((s) => s.setMode);
  const toast = useStore((s) => s.toast);

  const [refreshing, setRefreshing] = useState(false);

  const note = PROVIDER_ORDER.map((p) => providers[p]?.note).find(Boolean);

  const refresh = async (): Promise<void> => {
    setRefreshing(true);
    try {
      const res = await api.providersStatus(true);
      setProviders(res.providers);
      if (res.providers[0]) setMode(res.providers[0].adapter);
      toast('已刷新三家状态', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : '刷新失败', 'error');
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <header className="flex flex-none flex-col gap-2 border-b border-white/10 bg-white/[0.02] px-3 py-2 backdrop-blur-xl lg:flex-row lg:items-center lg:gap-3">
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          className="btn btn-ghost btn-xs lg:hidden"
          onClick={() => toggleSidebar()}
          title="会话列表"
        >
          ☰
        </button>

        {/* 视图切换 */}
        <div className="glass inline-flex flex-none p-0.5">
          <button
            type="button"
            data-testid="view-concurrent"
            onClick={() => setView('concurrent')}
            className={cx(
              'rounded-[9px] px-2.5 py-1 text-[12px] transition',
              view === 'concurrent' ? 'bg-white/[0.12] font-medium text-white' : 'text-slate-400 hover:text-slate-200',
            )}
            title="三列等宽，同一时间看三家的输出"
          >
            三窗并发
          </button>
          <button
            type="button"
            data-testid="view-aggregate"
            onClick={() => setView('aggregate')}
            className={cx(
              'rounded-[9px] px-2.5 py-1 text-[12px] transition',
              view === 'aggregate' ? 'bg-white/[0.12] font-medium text-white' : 'text-slate-400 hover:text-slate-200',
            )}
            title="单列 IM 视图，在气泡里切换查看三家"
          >
            聚合对话
          </button>
        </div>

        <div className="min-w-0 flex-1 truncate text-[13px] text-slate-400">
          {session?.title ?? '未选择会话'}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 lg:ml-auto lg:flex-nowrap">
        <ProviderToggles />

        <button
          type="button"
          className="chip"
          onClick={() => void refresh()}
          title={note ?? '点击重新探测三家登录态'}
          disabled={refreshing}
        >
          <StatusDot
            status={wsStatus === 'open' ? 'done' : wsStatus === 'connecting' ? 'pending' : 'error'}
            size={6}
            title={wsStatus === 'open' ? 'WebSocket 已连接' : wsStatus === 'connecting' ? '正在连接…' : 'WebSocket 已断开'}
          />
          {ADAPTER_LABEL[mode]}
          {refreshing && ' · 刷新中'}
        </button>

        <ExportMenu />
      </div>
    </header>
  );
}
