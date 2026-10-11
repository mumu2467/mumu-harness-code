/**
 * ============================================================================
 *  全局状态（zustand）+ localStorage 持久化
 * ============================================================================
 *
 *  P1 阶段的职责划分（重要，避免"两个真源"）：
 *    - **前端是会话状态的持有者**：会话 / 轮次 / 回复 / 投票 / 视图偏好都在这里
 *    - **后端是无状态的执行者**：只负责把消息投出去、把流式事件推回来
 *    - 前端靠 clientMsgId + provider 关联事件，因此 WS 事件比 HTTP 响应先到也不会错位
 *
 *  P2 会把会话权威存储搬到服务端（SQLite），届时本文件的 sessions 改为缓存镜像。
 *
 *  图片持久化说明：dataURL 进 localStorage 会几秒钟撑爆 5MB 配额，
 *  所以落盘时**只保留元信息**（名字/尺寸），刷新后显示"历史图片未保留"占位。
 *  P2 图片改由服务端落盘返回 URL 后，这里就能真正持久化。
 */
import { create } from 'zustand';
import {
  DEFAULT_ENABLED,
  PROVIDER_META,
  PROVIDER_ORDER,
  makeId,
  type AdapterKind,
  type ErrorCode,
  type LoginState,
  type Provider,
  type ReplyStatus,
  type SendRequest,
  type ServerEvent,
} from '@shared';
import { api } from '../api/client';
import type { WsStatus } from '../ws/client';
import { downloadText, fileStamp } from '../lib/download';
import type { ImageItem } from '../lib/image';
import { plainText } from '../lib/markdown';

/* -------------------------------------------------------------------------- */
/* 数据模型（前端视图层）                                                      */
/* -------------------------------------------------------------------------- */

export interface ReplyState {
  /** 服务端 id：先收到事件后收到 HTTP 响应时可能短暂为空 */
  id?: string;
  provider: Provider;
  content: string;
  status: ReplyStatus;
  /** 站点渲染出的思考过程（折叠展示） */
  reasoning?: string;
  error?: string;
  errorCode?: ErrorCode;
  firstTokenMs?: number;
  latencyMs?: number;
  tokenEst?: number;
  stopped?: boolean;
  startedAt: number;
}

export interface Turn {
  /** 本地用户消息 id（服务端返回的 messageId 会回填到这里） */
  id: string;
  clientMsgId: string;
  text: string;
  images: ImageItem[];
  createdAt: number;
  /** 这一轮参与了哪些 AI（决定列/标签页显示哪几家） */
  order: Provider[];
  replies: Partial<Record<Provider, ReplyState>>;
}

export interface VoteState {
  like?: boolean;
  best?: boolean;
}

export interface SessionRecord {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  turns: Turn[];
  /** key = `${turnId}:${provider}`，避免依赖可能后到的 replyId */
  votes: Record<string, VoteState>;
  /** 每个窗口单独"清空视图"的时间戳：只显示晚于它的轮次 */
  clearedAt: Partial<Record<Provider, number>>;
}

export type ViewMode = 'concurrent' | 'aggregate';

export interface UiState {
  view: ViewMode;
  enabled: Record<Provider, boolean>;
  /** 移动端（<768px）当前显示的窗口 */
  mobileTab: Provider;
  /** 聚合页里每一轮当前选中的 provider */
  activeTab: Record<string, Provider>;
  /** 聚合页里每一轮是否开启"并排对比" */
  parallel: Record<string, boolean>;
  sidebarOpen: boolean;
}

export interface ProviderRuntime {
  login: LoginState;
  generating: boolean;
  adapter: AdapterKind;
  note?: string;
}

export interface ToastItem {
  id: string;
  text: string;
  kind: 'info' | 'success' | 'error';
}

/* -------------------------------------------------------------------------- */
/* 持久化                                                                      */
/* -------------------------------------------------------------------------- */

const STORAGE_KEY = 'aiwb.v1';

interface PersistedState {
  version: 1;
  sessions: SessionRecord[];
  activeSessionId: string | null;
  ui: UiState;
}

function defaultUi(): UiState {
  return {
    view: 'concurrent',
    enabled: { ...DEFAULT_ENABLED },
    mobileTab: 'deepseek',
    activeTab: {},
    parallel: {},
    sidebarOpen: false,
  };
}

function newSessionRecord(title = '新会话'): SessionRecord {
  const t = Date.now();
  return { id: makeId('s'), title, createdAt: t, updatedAt: t, turns: [], votes: {}, clearedAt: {} };
}

/** 落盘：剥离 dataURL，避免撑爆 localStorage 配额 */
function stripForStorage(s: SessionRecord): SessionRecord {
  return {
    ...s,
    turns: s.turns.map((t) => ({
      ...t,
      images: t.images.map((img) => ({ ...img, dataUrl: '' })),
    })),
  };
}

/**
 * 载入后的清洗：
 * 刷新页面后正在生成的回复不会有后续事件了，必须收尾成"已中断"，
 * 否则会出现永远转圈的假 loading。
 */
function sanitizeOnLoad(s: SessionRecord): SessionRecord {
  return {
    ...s,
    turns: s.turns.map((t) => {
      const replies: Partial<Record<Provider, ReplyState>> = {};
      for (const p of PROVIDER_ORDER) {
        const r = t.replies[p];
        if (!r) continue;
        if (r.status === 'pending' || r.status === 'streaming') {
          replies[p] = {
            ...r,
            status: 'error',
            errorCode: 'aborted',
            error: '页面刷新，本次生成已中断',
            stopped: true,
          };
        } else {
          replies[p] = r;
        }
      }
      return { ...t, replies };
    }),
  };
}

function loadPersisted(): PersistedState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedState;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.sessions)) return null;
    return {
      version: 1,
      sessions: parsed.sessions.map(sanitizeOnLoad),
      activeSessionId: parsed.activeSessionId ?? parsed.sessions[0]?.id ?? null,
      ui: { ...defaultUi(), ...(parsed.ui ?? {}) },
    };
  } catch {
    return null;
  }
}

function savePersisted(state: StoreState): void {
  try {
    const payload: PersistedState = {
      version: 1,
      sessions: state.sessions.map(stripForStorage),
      activeSessionId: state.activeSessionId,
      ui: state.ui,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // 配额超限：退化为只保存会话标题级信息，保证应用不崩
    try {
      const slim: PersistedState = {
        version: 1,
        sessions: state.sessions.map((s) => ({ ...s, turns: s.turns.slice(-20).map((t) => ({ ...t, images: [] })) })),
        activeSessionId: state.activeSessionId,
        ui: state.ui,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(slim));
    } catch {
      /* 放弃持久化 */
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Store                                                                       */
/* -------------------------------------------------------------------------- */

export interface StoreState {
  /* --- 数据 --- */
  sessions: SessionRecord[];
  activeSessionId: string | null;
  ui: UiState;
  providers: Record<Provider, ProviderRuntime>;
  /** 后端实际生效的通道 */
  mode: AdapterKind;
  wsStatus: WsStatus;
  toasts: ToastItem[];
  hydrated: boolean;

  /* --- 会话管理 --- */
  newSession: () => string;
  selectSession: (id: string) => void;
  renameSession: (id: string, title: string) => void;
  deleteSession: (id: string) => void;

  /* --- 视图 --- */
  setView: (view: ViewMode) => void;
  setEnabled: (provider: Provider, on: boolean) => void;
  setMobileTab: (provider: Provider) => void;
  toggleSidebar: (open?: boolean) => void;
  setActiveTab: (turnId: string, provider: Provider) => void;
  toggleParallel: (turnId: string) => void;
  setWsStatus: (status: WsStatus) => void;
  setMode: (mode: AdapterKind) => void;
  setProviders: (list: Array<{ provider: Provider; login: LoginState; generating: boolean; adapter: AdapterKind; note?: string }>) => void;

  /* --- 发送与回复控制 --- */
  sendMessage: (text: string, images: ImageItem[]) => Promise<void>;
  stopReply: (turnId: string, provider: Provider) => Promise<void>;
  stopAll: () => number;
  retryReply: (turnId: string, provider: Provider) => Promise<void>;
  clearColumn: (provider: Provider) => void;
  newProviderSession: (provider: Provider) => Promise<void>;

  /* --- 投票 / 导出 --- */
  setVote: (turnId: string, provider: Provider, kind: 'like' | 'best') => void;
  exportSession: (format: 'md' | 'json') => void;

  /* --- 事件与提示 --- */
  handleServerEvent: (event: ServerEvent) => void;
  toast: (text: string, kind?: ToastItem['kind']) => void;
  dismissToast: (id: string) => void;
  hydrate: () => void;
}

function initialProviders(): Record<Provider, ProviderRuntime> {
  const out = {} as Record<Provider, ProviderRuntime>;
  for (const p of PROVIDER_ORDER) {
    out[p] = { login: 'unknown', generating: false, adapter: 'mock' };
  }
  return out;
}

/** 会话内查找某个轮次（按 clientMsgId） */
function locateTurn(
  sessions: SessionRecord[],
  sessionId: string,
  clientMsgId: string,
): { sIdx: number; tIdx: number } | null {
  const sIdx = sessions.findIndex((s) => s.id === sessionId);
  if (sIdx < 0) return null;
  const tIdx = sessions[sIdx].turns.findIndex((t) => t.clientMsgId === clientMsgId);
  if (tIdx < 0) return null;
  return { sIdx, tIdx };
}

function voteKey(turnId: string, provider: Provider): string {
  return `${turnId}:${provider}`;
}

export const useStore = create<StoreState>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  ui: defaultUi(),
  providers: initialProviders(),
  mode: 'mock',
  wsStatus: 'closed',
  toasts: [],
  hydrated: false,

  /* ------------------------------ 生命周期 ------------------------------ */

  hydrate: () => {
    const persisted = loadPersisted();
    if (persisted && persisted.sessions.length > 0) {
      set({
        sessions: persisted.sessions,
        activeSessionId: persisted.activeSessionId ?? persisted.sessions[0].id,
        ui: persisted.ui,
        hydrated: true,
      });
    } else {
      const s = newSessionRecord();
      set({ sessions: [s], activeSessionId: s.id, hydrated: true });
    }
  },

  /* ------------------------------ 会话管理 ------------------------------ */

  newSession: () => {
    const s = newSessionRecord();
    set((state) => ({ sessions: [s, ...state.sessions], activeSessionId: s.id }));
    return s.id;
  },

  selectSession: (id) => set({ activeSessionId: id }),

  renameSession: (id, title) => {
    const clean = title.trim() || '未命名会话';
    set((state) => ({
      sessions: state.sessions.map((s) => (s.id === id ? { ...s, title: clean, updatedAt: Date.now() } : s)),
    }));
  },

  deleteSession: (id) => {
    set((state) => {
      const sessions = state.sessions.filter((s) => s.id !== id);
      const next = sessions.length > 0 ? sessions : [newSessionRecord()];
      const activeSessionId = state.activeSessionId === id ? next[0].id : state.activeSessionId;
      return { sessions: next, activeSessionId };
    });
  },

  /* ------------------------------ 视图 ------------------------------ */

  setView: (view) => set((state) => ({ ui: { ...state.ui, view } })),

  setEnabled: (provider, on) =>
    set((state) => ({ ui: { ...state.ui, enabled: { ...state.ui.enabled, [provider]: on } } })),

  setMobileTab: (provider) => set((state) => ({ ui: { ...state.ui, mobileTab: provider } })),

  toggleSidebar: (open) =>
    set((state) => ({ ui: { ...state.ui, sidebarOpen: open ?? !state.ui.sidebarOpen } })),

  setActiveTab: (turnId, provider) =>
    set((state) => ({ ui: { ...state.ui, activeTab: { ...state.ui.activeTab, [turnId]: provider } } })),

  toggleParallel: (turnId) =>
    set((state) => ({
      ui: { ...state.ui, parallel: { ...state.ui.parallel, [turnId]: !state.ui.parallel[turnId] } },
    })),

  setWsStatus: (wsStatus) => set({ wsStatus }),

  setMode: (mode) => set({ mode }),

  setProviders: (list) => {
    if (list.length === 0) return;
    set((state) => {
      const providers = { ...state.providers };
      let mode = state.mode;
      for (const item of list) {
        providers[item.provider] = {
          login: item.login,
          generating: item.generating,
          adapter: item.adapter,
          note: item.note,
        };
        mode = item.adapter;
      }
      return { providers, mode };
    });
  },

  /* ------------------------------ 发送 ------------------------------ */

  sendMessage: async (text, images) => {
    const state = get();
    const sessionId = state.activeSessionId ?? state.newSession();
    const providers = PROVIDER_ORDER.filter((p) => state.ui.enabled[p]);

    if (providers.length === 0) {
      state.toast('至少勾选一个 AI 再发送', 'error');
      return;
    }
    if (!text.trim() && images.length === 0) {
      state.toast('请输入内容或添加图片', 'error');
      return;
    }

    const clientMsgId = makeId('c');
    const started = Date.now();
    const replies: Partial<Record<Provider, ReplyState>> = {};
    for (const p of providers) {
      replies[p] = { provider: p, content: '', status: 'pending', startedAt: started };
    }

    const turn: Turn = {
      id: makeId('m'),
      clientMsgId,
      text,
      images,
      createdAt: started,
      order: providers,
      replies,
    };

    // ① 先落本地：这样 WS 事件即使比 HTTP 响应先到也能正确关联
    set((s) => ({
      sessions: s.sessions.map((sess) => {
        if (sess.id !== sessionId) return sess;
        const isFirst = sess.turns.length === 0;
        return {
          ...sess,
          title: isFirst && sess.title === '新会话' ? plainText(text, 24) || '图片消息' : sess.title,
          turns: [...sess.turns, turn],
          updatedAt: started,
        };
      }),
      ui:
        s.ui.view === 'aggregate'
          ? { ...s.ui, activeTab: { ...s.ui.activeTab, [turn.id]: providers[0] } }
          : s.ui,
    }));

    // ② 投递
    const body: SendRequest = {
      sessionId,
      clientMsgId,
      text,
      images: images.map((i) => i.dataUrl),
      providers,
    };

    try {
      const res = await api.send(body);
      if (res.replies.length < providers.length) {
        get().toast('后端只接受了部分 AI，请查看各窗口状态', 'info');
      }
      // ③ 回填 replyId（停止 / 重试要用）
      set((s) => ({
        sessions: s.sessions.map((sess) => {
          if (sess.id !== sessionId) return sess;
          return {
            ...sess,
            turns: sess.turns.map((t) => {
              if (t.clientMsgId !== clientMsgId) return t;
              const nextReplies = { ...t.replies };
              for (const r of res.replies) {
                const prev = nextReplies[r.provider];
                if (prev) nextReplies[r.provider] = { ...prev, id: r.replyId };
              }
              return { ...t, id: res.messageId || t.id, replies: nextReplies };
            }),
          };
        }),
      }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      get().toast(`投递失败：${message}`, 'error');
      // ③' 投递失败：把这一轮的所有回复标记为错误（可单窗重试）
      set((s) => ({
        sessions: s.sessions.map((sess) => {
          if (sess.id !== sessionId) return sess;
          return {
            ...sess,
            turns: sess.turns.map((t) => {
              if (t.clientMsgId !== clientMsgId) return t;
              const nextReplies = { ...t.replies };
              for (const p of providers) {
                const prev = nextReplies[p];
                if (prev) {
                  nextReplies[p] = { ...prev, status: 'error', error: message, errorCode: 'network' };
                }
              }
              return { ...t, replies: nextReplies };
            }),
          };
        }),
      }));
    }
  },

  stopReply: async (turnId, provider) => {
    const state = get();
    const session = state.sessions.find((s) => s.id === state.activeSessionId);
    const turn = session?.turns.find((t) => t.id === turnId);
    const reply = turn?.replies[provider];
    if (!reply?.id) return;
    try {
      await api.stopReply(reply.id);
    } catch (err) {
      state.toast(err instanceof Error ? err.message : '停止失败', 'error');
    }
  },

  stopAll: () => {
    const state = get();
    const session = state.sessions.find((s) => s.id === state.activeSessionId);
    if (!session) return 0;
    let n = 0;
    for (const turn of session.turns) {
      for (const p of PROVIDER_ORDER) {
        const r = turn.replies[p];
        if (r?.id && (r.status === 'pending' || r.status === 'streaming')) {
          void api.stopReply(r.id).catch(() => undefined);
          n += 1;
        }
      }
    }
    if (n > 0) get().toast(`已请求停止 ${n} 个生成`, 'info');
    return n;
  },

  retryReply: async (turnId, provider) => {
    const state = get();
    const session = state.sessions.find((s) => s.id === state.activeSessionId);
    const turn = session?.turns.find((t) => t.id === turnId);
    const reply = turn?.replies[provider];
    if (!reply) return;

    if (!reply.id) {
      // 早期版本/异常情况：没有 replyId 就重新走一次完整发送
      await state.sendMessage(turn!.text, turn!.images);
      return;
    }

    // 乐观复位，随后服务端的 reply.started 也会再复位一次
    set((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.id !== session?.id
          ? sess
          : {
              ...sess,
              turns: sess.turns.map((t) =>
                t.id !== turnId
                  ? t
                  : {
                      ...t,
                      replies: {
                        ...t.replies,
                        [provider]: {
                          ...reply,
                          content: '',
                          status: 'pending',
                          error: undefined,
                          errorCode: undefined,
                          startedAt: Date.now(),
                          firstTokenMs: undefined,
                          latencyMs: undefined,
                          stopped: false,
                        },
                      },
                    },
              ),
            },
      ),
    }));

    try {
      await api.retryReply(reply.id);
    } catch (err) {
      state.toast(err instanceof Error ? err.message : '重试失败', 'error');
    }
  },

  clearColumn: (provider) => {
    const state = get();
    const sessionId = state.activeSessionId;
    if (!sessionId) return;
    set((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.id !== sessionId ? sess : { ...sess, clearedAt: { ...sess.clearedAt, [provider]: Date.now() } },
      ),
    }));
    state.toast(`已清空 ${PROVIDER_META[provider].label} 窗口的显示`, 'info');
  },

  newProviderSession: async (provider) => {
    const state = get();
    try {
      await api.newProviderSession(provider);
      state.clearColumn(provider);
      state.toast(`已让 ${PROVIDER_META[provider].label} 开启新会话`, 'success');
    } catch (err) {
      state.toast(err instanceof Error ? err.message : '开新会话失败', 'error');
    }
  },

  /* ------------------------------ 投票 ------------------------------ */

  setVote: (turnId, provider, kind) => {
    const state = get();
    const sessionId = state.activeSessionId;
    if (!sessionId) return;
    set((s) => ({
      sessions: s.sessions.map((sess) => {
        if (sess.id !== sessionId) return sess;
        const votes = { ...sess.votes };
        const key = voteKey(turnId, provider);
        const cur: VoteState = { ...(votes[key] ?? {}) };

        if (kind === 'best') {
          const willSet = !cur.best;
          // "最佳答案"在同一轮里互斥
          for (const p of PROVIDER_ORDER) {
            const k = voteKey(turnId, p);
            if (votes[k]?.best) votes[k] = { ...votes[k], best: false };
          }
          cur.best = willSet;
        } else {
          cur.like = !cur.like;
        }
        votes[key] = cur;
        return { ...sess, votes };
      }),
    }));
  },

  /* ------------------------------ 导出 ------------------------------ */

  exportSession: (format) => {
    const state = get();
    const session = state.sessions.find((s) => s.id === state.activeSessionId);
    if (!session) return;

    if (format === 'json') {
      const payload = {
        version: 1,
        exportedAt: new Date().toISOString(),
        adapterMode: state.mode,
        session: {
          ...session,
          turns: session.turns.map((t) => ({
            ...t,
            images: t.images.map((i) => ({ ...i, dataUrl: i.dataUrl || null })),
            replies: Object.fromEntries(
              PROVIDER_ORDER.filter((p) => t.replies[p]).map((p) => [
                p,
                { ...t.replies[p], provider: p, vote: session.votes[voteKey(t.id, p)] ?? {} },
              ]),
            ),
          })),
        },
      };
      downloadText(`${session.title}-${fileStamp()}.json`, JSON.stringify(payload, null, 2), 'application/json');
      state.toast('已导出 JSON', 'success');
      return;
    }

    const lines: string[] = [];
    lines.push(`# ${session.title}`);
    lines.push('');
    lines.push(`> 导出时间：${new Date().toLocaleString('zh-CN')}`);
    lines.push(`> 通道：${state.mode}　轮次：${session.turns.length}`);
    lines.push('');

    session.turns.forEach((turn, i) => {
      lines.push(`## 第 ${i + 1} 轮 · ${new Date(turn.createdAt).toLocaleString('zh-CN')}`);
      lines.push('');
      lines.push('**我：**');
      lines.push('');
      lines.push(turn.text || '（仅图片）');
      lines.push('');
      if (turn.images.length > 0) {
        turn.images.forEach((img, k) => {
          if (img.dataUrl) lines.push(`![${img.name}](${img.dataUrl})`);
          else lines.push(`- （图片 ${k + 1}：${img.name}，历史图片未保留）`);
        });
        lines.push('');
      }

      for (const p of turn.order) {
        const r = turn.replies[p];
        if (!r) continue;
        const vote = session.votes[voteKey(turn.id, p)];
        const badges = [
          r.status === 'done' ? '完成' : r.status === 'error' ? '失败' : '未完成',
          r.firstTokenMs !== undefined ? `首字 ${r.firstTokenMs}ms` : null,
          r.latencyMs !== undefined ? `耗时 ${r.latencyMs}ms` : null,
          r.tokenEst !== undefined ? `约 ${r.tokenEst} tokens` : null,
          r.stopped ? '已停止' : null,
          vote?.best ? '⭐最佳答案' : null,
          vote?.like ? '👍有用' : null,
        ].filter(Boolean);

        lines.push(`### ${PROVIDER_META[p].label}（${badges.join(' · ')}）`);
        lines.push('');
        if (r.reasoning) {
          lines.push('<details><summary>思考过程</summary>');
          lines.push('');
          lines.push(r.reasoning);
          lines.push('');
          lines.push('</details>');
          lines.push('');
        }
        lines.push(r.content || (r.error ? `> 错误：${r.error}` : '（无内容）'));
        lines.push('');
      }
      lines.push('---');
      lines.push('');
    });

    downloadText(`${session.title}-${fileStamp()}.md`, lines.join('\n'), 'text/markdown;charset=utf-8');
    state.toast('已导出 Markdown', 'success');
  },

  /* ------------------------------ 事件 ------------------------------ */

  handleServerEvent: (event) => {
    if (event.type === 'hello') return;

    if (event.type === 'provider.status') {
      set((state) => ({
        providers: {
          ...state.providers,
          [event.provider]: {
            login: event.login,
            generating: event.generating,
            adapter: (event.adapter ?? state.providers[event.provider].adapter) as AdapterKind,
            note: event.note,
          },
        },
      }));
      return;
    }

    if (event.type === 'view.frame') return;

    // 到这里都是 reply.*（reply.started / delta / done / error）
    set((state) => {
      const hit = locateTurn(state.sessions, event.sessionId, event.clientMsgId);
      if (!hit) return {};

      const session = state.sessions[hit.sIdx];
      const turn = session.turns[hit.tIdx];
      const prev: ReplyState =
        turn.replies[event.provider] ??
        ({ provider: event.provider, content: '', status: 'pending', startedAt: event.ts } as ReplyState);

      const next: ReplyState = { ...prev, id: event.replyId || prev.id };

      if (event.type === 'reply.started') {
        next.status = 'pending';
        next.content = '';
        next.error = undefined;
        next.errorCode = undefined;
        next.startedAt = event.ts;
        next.firstTokenMs = undefined;
        next.latencyMs = undefined;
        next.tokenEst = undefined;
        next.stopped = false;
      } else if (event.type === 'reply.delta') {
        next.status = 'streaming';
        next.content = event.content;
        if (event.firstTokenMs !== undefined) next.firstTokenMs = event.firstTokenMs;
      } else if (event.type === 'reply.done') {
        next.status = 'done';
        next.content = event.content;
        next.latencyMs = event.latencyMs;
        next.firstTokenMs = event.firstTokenMs;
        next.tokenEst = event.tokenEst;
        next.stopped = event.stopped;
        if (event.reasoning) next.reasoning = event.reasoning;
      } else {
        next.status = 'error';
        next.error = event.error;
        next.errorCode = event.errorCode;
        if (event.content) next.content = event.content;
        if (event.reasoning) next.reasoning = event.reasoning;
      }

      const turns = [...session.turns];
      turns[hit.tIdx] = { ...turn, replies: { ...turn.replies, [event.provider]: next } };
      const sessions = [...state.sessions];
      sessions[hit.sIdx] = { ...session, turns, updatedAt: event.ts };

      return { sessions };
    });
  },

  toast: (text, kind = 'info') => {
    const item: ToastItem = { id: makeId('t'), text, kind };
    set((state) => ({ toasts: [...state.toasts, item] }));
    window.setTimeout(() => get().dismissToast(item.id), kind === 'error' ? 6000 : 3600);
  },

  dismissToast: (id) => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),
}));

/* -------------------------------------------------------------------------- */
/* 选择器与派生值                                                              */
/* -------------------------------------------------------------------------- */

export function useActiveSession(): SessionRecord | null {
  return useStore((s) => s.sessions.find((x) => x.id === s.activeSessionId) ?? null);
}

/** 当前会话里是否还有正在生成的回复 */
export function useStreamingCount(): number {
  return useStore((s) => {
    const session = s.sessions.find((x) => x.id === s.activeSessionId);
    if (!session) return 0;
    let n = 0;
    for (const turn of session.turns) {
      for (const p of PROVIDER_ORDER) {
        const st = turn.replies[p]?.status;
        if (st === 'pending' || st === 'streaming') n += 1;
      }
    }
    return n;
  });
}

/* 自动持久化：任何状态变化都防抖 600ms 落盘 */
let saveTimer: number | null = null;
useStore.subscribe((state) => {
  if (!state.hydrated) return;
  if (saveTimer !== null) window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => savePersisted(state), 600);
});
