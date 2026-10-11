/**
 * 应用外壳：左侧会话栏 + 顶部工具栏 + 主视图（三窗并发 / 聚合对话）
 * 同时负责三件全局事务：
 *   1. 建立并维护 WebSocket 连接（含当前会话订阅）
 *   2. 启动时拉一次后端状态（通道模式 / 三家登录态）
 *   3. 全局快捷键：Esc 停止生成
 */
import { useEffect, useRef } from 'react';
import { api } from './api/client';
import { createWsClient, type WsClient } from './ws/client';
import { useStore } from './store/useStore';
import { SessionSidebar } from './components/SessionSidebar';
import { TopBar } from './components/TopBar';
import { Toasts } from './components/Toasts';
import { ConcurrentPage } from './pages/ConcurrentPage';
import { AggregatePage } from './pages/AggregatePage';

export default function App() {
  const wsRef = useRef<WsClient | null>(null);
  const hydrated = useStore((s) => s.hydrated);
  const view = useStore((s) => s.ui.view);
  const activeSessionId = useStore((s) => s.activeSessionId);
  const sidebarOpen = useStore((s) => s.ui.sidebarOpen);

  /* ① WebSocket 连接 */
  useEffect(() => {
    const client = createWsClient({
      onEvent: (event) => useStore.getState().handleServerEvent(event),
      onStatus: (status) => useStore.getState().setWsStatus(status),
    });
    wsRef.current = client;
    client.connect();
    return () => {
      client.close();
      wsRef.current = null;
    };
  }, []);

  /* ② 订阅当前会话（切换会话时自动改订阅） */
  useEffect(() => {
    wsRef.current?.subscribe(activeSessionId);
  }, [activeSessionId]);

  /* ③ 启动时同步后端状态 */
  useEffect(() => {
    let alive = true;
    api
      .health()
      .then((h) => {
        if (!alive) return;
        useStore.getState().setMode(h.mode);
        useStore.getState().setProviders(h.providers);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        useStore
          .getState()
          .toast(err instanceof Error ? err.message : '无法连接后端', 'error');
      });
    return () => {
      alive = false;
    };
  }, []);

  /* ④ 全局快捷键：Esc = 停止生成 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      const target = e.target as HTMLElement | null;
      // 重命名等输入框里的 Esc 交给它自己处理（取消编辑）
      if (target && target.tagName === 'INPUT') return;
      useStore.getState().stopAll();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!hydrated) {
    return (
      <div className="flex h-dvh items-center justify-center text-sm text-slate-400">正在载入…</div>
    );
  }

  return (
    <div className="relative z-10 flex h-dvh w-full overflow-hidden">
      <SessionSidebar />

      {/* 移动端：侧边栏以抽屉形式出现 */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-20 bg-black/50 lg:hidden"
          onClick={() => useStore.getState().toggleSidebar(false)}
        />
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <main className="min-h-0 flex-1">
          {view === 'concurrent' ? <ConcurrentPage /> : <AggregatePage />}
        </main>
      </div>

      <Toasts />
    </div>
  );
}
