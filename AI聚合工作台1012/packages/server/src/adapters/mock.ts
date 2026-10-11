/**
 * MockAdapter —— 离线假回复通道
 *
 * 存在意义：让**整个前端（两个页面、全部交互）不装浏览器、不登录、不联网就能完整验证**。
 * 这是 P1 的验收基础，也是后续每改一次 UI 的回归手段。
 *
 * 输入框里的调试指令（方便手动测各种状态）：
 *   /fail  这一轮强制失败（验证错误态与重试按钮）
 *   /slow  放慢输出（验证"停止生成"与流式滚动）
 *   /long  生成长文本（验证长回答下的滚动与并排布局）
 *   /reason 附带"思考过程"（验证折叠展示与排除逻辑）
 */
import {
  PROVIDER_META,
  truncate,
  type AdapterKind,
  type DiagReport,
  type ErrorCode,
  type LoginState,
  type Provider,
} from '../../../shared/src/index';
import type { MockConfig } from '../config';
import { AdapterError } from './errors';
import { BaseAdapter, type SendContext, type SendInput, type ReplySink } from './types';

/** 可被 abort 打断的睡眠：abort 时立即 resolve，由调用方检查 signal.aborted */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      resolve();
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** 三家各用不同的失败文案与错误码，方便把每种错误 UI 都点一遍 */
const MOCK_FAILURES: Record<Provider, { message: string; code: ErrorCode }> = {
  deepseek: { message: '（模拟）HTTP 429：请求过于频繁，请稍后再试', code: 'network' },
  doubao: { message: '（模拟）当前访问人数过多，请稍后重试', code: 'timeout' },
  kimi: { message: '（模拟）检测到异常访问行为，需要先完成安全验证', code: 'risk' },
};

const TAIL_HINT =
  '\n\n---\n> 这是**模拟通道**的输出。调试指令：`/fail` 强制失败、`/slow` 放慢输出、`/long` 生成长文本、`/reason` 附带思考过程。';

function buildBody(provider: Provider, question: string, imgNote: string): string {
  switch (provider) {
    case 'deepseek':
      return [
        `**DeepSeek · 模拟回复**`,
        ``,
        `收到你的问题：「${question}」${imgNote}。`,
        ``,
        `### 分析路径`,
        `1. 先把问题拆成"已知条件 / 待求目标"两部分；`,
        `2. 再检查是否存在歧义或缺失的约束；`,
        `3. 最后给出结论，并明确标注不确定项。`,
        ``,
        `### 结论`,
        `在模拟通道下，我返回的是**结构完整、内容占位**的回答，用来验证：`,
        `- 打字机效果是否平滑（按固定字数分批推送）`,
        `- 首字延迟与总耗时统计是否准确`,
        `- 停止 / 重试 / 错误态是否符合预期`,
        ``,
        '```ts',
        `// 想验证代码块渲染，直接发一段代码问题即可`,
        `const answer: number = 42;`,
        '```',
      ].join('\n');

    case 'doubao':
      return [
        `**豆包 · 模拟回复** 👋`,
        ``,
        `收到～你说的是：「${question}」${imgNote}`,
        ``,
        `我先给你三个要点：`,
        ``,
        `- **并行投递**：三家同时开始输出，任意一家慢或失败都不影响其他两家；`,
        `- **独立控制**：每个窗口都能单独停止、清空、开新会话；`,
        `- **两种视图**：三窗并发页横向对比，聚合页在同一个气泡里切换查看。`,
        ``,
        `想让我展开哪一部分？直接说就行。`,
      ].join('\n');

    case 'kimi':
    default:
      return [
        `**Kimi · 模拟回复**`,
        ``,
        `关于「${question}」${imgNote}，我从三个层面回答。`,
        ``,
        `**一、问题本身**`,
        `你的问题可以拆成两个部分：需要被同时分发出去的内容，以及需要在界面上被区分开的来源。`,
        `前者决定发送链路的设计，后者决定数据模型与视图层。`,
        ``,
        `**二、常见解法**`,
        `最直接的做法是"一份输入、N 份输出、按来源分桶"；进一步则要把每个来源的状态机独立出来，`,
        `这样单个来源的失败或超时不会污染其他来源的展示。`,
        ``,
        `**三、我的建议**`,
        `先固定事件契约（谁产生、谁消费、字段含义），再让视图只依赖契约——`,
        `这样以后新增第四个 AI 时，前端几乎不用改。`,
      ].join('\n');
  }
}

function buildAnswer(
  provider: Provider,
  input: SendInput,
  opts: { long: boolean; reasoning: boolean },
): { content: string; reasoning?: string } {
  const raw = (input.text || '').trim();
  const question = truncate(raw.replace(/\/(fail|slow|long|reason)\b/g, '').trim() || '（空消息）', 80);
  const imgNote = input.images.length > 0 ? `，以及 ${input.images.length} 张图片` : '';

  let content = buildBody(provider, question, imgNote);

  if (opts.long) {
    // 长文本：验证长回答下的滚动跟随与并排布局高度差异
    for (let i = 1; i <= 6; i += 1) {
      content += `\n\n**补充段落 ${i}**\n${'这是用于压测长回答渲染的占位段落，重复文字可以让不同来源的回答长度差异更明显。'.repeat(3)}`;
    }
  }

  content += TAIL_HINT;

  const reasoning = opts.reasoning
    ? [
        `我需要先理解用户的问题：「${question}」。`,
        `用户在测试多 AI 聚合工作台，所以我应该给出结构清晰、长度适中、便于横向对比的回答。`,
        `三家回答要能在同一个气泡里切换，因此开头必须标明身份。`,
      ].join('\n')
    : undefined;

  return { content, reasoning };
}

export class MockAdapter extends BaseAdapter {
  readonly id: Provider;
  readonly kind: AdapterKind = 'mock';

  private readonly cfg: MockConfig;

  constructor(id: Provider, cfg: MockConfig) {
    super();
    this.id = id;
    this.cfg = cfg;
  }

  override async ensureReady(): Promise<void> {
    this.note = `${PROVIDER_META[this.id].label} · 模拟通道（无需登录与网络）`;
  }

  override async loginState(): Promise<LoginState> {
    return 'loggedIn';
  }

  override async diagnose(): Promise<DiagReport> {
    return {
      provider: this.id,
      mode: this.kind,
      checkedAt: Date.now(),
      hits: [{ field: 'mock', selector: '(none)', matched: true, count: 1 }],
      note: '模拟通道不需要选择器',
    };
  }

  override async send(input: SendInput, sink: ReplySink, ctx: SendContext): Promise<void> {
    this.generating = true;
    try {
      const long = /\/long\b/.test(input.text);
      const slow = /\/slow\b/.test(input.text);
      const wantReasoning = this.cfg.showReasoning || /\/reason\b/.test(input.text);
      const forceFail = /\/fail\b/.test(input.text) || Math.random() < this.cfg.failRate;

      const firstTokenMs = this.cfg.firstTokenMs[this.id] ?? 800;
      const chunkMs = (slow ? this.cfg.chunkMs * 4 : this.cfg.chunkMs) || 35;
      const chunkSize = Math.max(1, this.cfg.chunkSize || 4);

      // ① 模拟首字延迟（真实站点里这段是"思考中"）
      await sleep(firstTokenMs, ctx.signal);
      if (ctx.signal.aborted) {
        sink.onDone({ content: '', stopped: true });
        return;
      }

      // ② 失败注入
      if (forceFail) {
        const f = MOCK_FAILURES[this.id];
        throw new AdapterError(f.message, f.code);
      }

      // ③ 分批推送（每批都是累计全文）
      const { content, reasoning } = buildAnswer(this.id, input, { long, reasoning: wantReasoning });
      let out = '';
      for (let i = 0; i < content.length; i += chunkSize) {
        await sleep(chunkMs, ctx.signal);
        if (ctx.signal.aborted) {
          sink.onDone({ content: out, reasoning, stopped: true });
          return;
        }
        out = content.slice(0, i + chunkSize);
        sink.onDelta(out);
      }

      sink.onDone({ content, reasoning });
    } finally {
      this.generating = false;
    }
  }

  override async stop(): Promise<void> {
    this.generating = false;
  }

  override async newSession(): Promise<void> {
    this.generating = false;
  }
}
