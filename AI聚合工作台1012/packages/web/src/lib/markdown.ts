/**
 * 极简 Markdown 渲染器（零依赖）。
 *
 * 为什么自己写而不引 marked + DOMPurify：
 *   - 只用到 3 家回答里最常见的语法（标题/列表/粗体/行内码/代码块/引用/链接/分割线）
 *   - 少两个依赖，也少一个 XSS 面
 *
 * ★ 安全约定：**先整体转义 HTML，再插入受控标签**。
 *   任何来自模型输出的 < > & " 都会先变成实体，因此不存在注入路径。
 */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 只允许 http/https 链接，其余一律降级成纯文本 */
function safeUrl(url: string): string | null {
  const u = url.trim();
  if (/^https?:\/\//i.test(u)) return u;
  return null;
}

/** 行内语法：行内码 → 粗体 → 链接（顺序很关键：先处理 code，避免里面的 ** 被误解析） */
function renderInline(raw: string): string {
  let s = escapeHtml(raw);

  // 行内码
  s = s.replace(/`([^`]+)`/g, (_m, code: string) => `<code>${code}</code>`);

  // 粗体
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  // 链接：[文字](地址)
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label: string, url: string) => {
    const safe = safeUrl(url);
    if (!safe) return m;
    return `<a href="${safe}" target="_blank" rel="noreferrer noopener">${label}</a>`;
  });

  return s;
}

interface Block {
  type: 'code' | 'text';
  lang: string;
  body: string;
}

/** 先把 ``` 代码块切出来，避免块内内容被按行解析 */
function splitFences(src: string): Block[] {
  const blocks: Block[] = [];
  const parts = src.split('```');
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      // 代码块：首行可能是语言标识
      const nl = part.indexOf('\n');
      const first = nl >= 0 ? part.slice(0, nl) : part;
      const looksLikeLang = /^[a-zA-Z0-9+#._-]{0,16}$/.test(first.trim());
      const lang = looksLikeLang ? first.trim() : '';
      const body = looksLikeLang && nl >= 0 ? part.slice(nl + 1) : part;
      blocks.push({ type: 'code', lang, body });
    } else if (part.length > 0) {
      blocks.push({ type: 'text', lang: '', body: part });
    }
  });
  return blocks;
}

/** 解析一段纯文本（标题/列表/引用/分割线/段落） */
function renderTextBlock(src: string): string {
  const lines = src.split(/\r?\n/);
  const html: string[] = [];
  let listType: 'ul' | 'ol' | null = null;

  const closeList = (): void => {
    if (listType) {
      html.push(`</${listType}>`);
      listType = null;
    }
  };

  const openList = (type: 'ul' | 'ol'): void => {
    if (listType !== type) {
      closeList();
      html.push(`<${type}>`);
      listType = type;
    }
  };

  for (const line of lines) {
    const t = line.trim();

    if (t === '') {
      closeList();
      continue;
    }

    // 分割线
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) {
      closeList();
      html.push('<hr />');
      continue;
    }

    // 标题
    const heading = /^(#{1,4})\s+(.*)$/.exec(t);
    if (heading) {
      closeList();
      const level = heading[1].length;
      html.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      continue;
    }

    // 引用
    const quote = /^>\s?(.*)$/.exec(t);
    if (quote) {
      closeList();
      html.push(`<blockquote>${renderInline(quote[1])}</blockquote>`);
      continue;
    }

    // 无序列表（- * +）
    const ul = /^[-*+]\s+(.*)$/.exec(t);
    if (ul) {
      openList('ul');
      html.push(`<li>${renderInline(ul[1])}</li>`);
      continue;
    }

    // 有序列表（1. 2. …）
    const ol = /^\d+[.)]\s+(.*)$/.exec(t);
    if (ol) {
      openList('ol');
      html.push(`<li>${renderInline(ol[1])}</li>`);
      continue;
    }

    // 普通段落行（连续行会在同一个 <p> 内以 <br> 连接）
    closeList();
    const last = html.length > 0 ? html[html.length - 1] : '';
    if (last.startsWith('<p>')) {
      html[html.length - 1] = `${last.slice(0, -4)}<br />${renderInline(t)}</p>`;
    } else {
      html.push(`<p>${renderInline(t)}</p>`);
    }
  }

  closeList();
  return html.join('');
}

/**
 * 渲染成 HTML 字符串。调用方用 dangerouslySetInnerHTML 注入，
 * 安全性由本文件"先转义、后拼标签"的顺序保证。
 */
export function renderMarkdown(src: string): string {
  if (!src) return '';
  const blocks = splitFences(src);
  return blocks
    .map((b) => {
      if (b.type === 'code') {
        const langAttr = b.lang ? ` data-lang="${escapeHtml(b.lang)}"` : '';
        return `<pre${langAttr}><code>${escapeHtml(b.body.replace(/\n$/, ''))}</code></pre>`;
      }
      return renderTextBlock(b.body);
    })
    .join('');
}

/** 纯文本摘要（导出、侧边栏标题用） */
export function plainText(src: string, limit = 80): string {
  const s = src
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#>*`_~\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > limit ? `${s.slice(0, limit)}…` : s;
}
