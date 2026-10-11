/**
 * ============================================================================
 *  test/injected-syntax.test.mjs —— 注入脚本的"语法与转义"回归测试
 * ----------------------------------------------------------------------------
 *  为什么需要它（血泪教训）：
 *    注入脚本写在模板字符串里，而**模板字符串会处理转义**：
 *      `.replace(/\r/g,'')` 里的 \r 会被换成真实回车，
 *      页面拿到的正则就成了非法的 `/g`
 *      → SyntaxError: Invalid regular expression: missing /（页面只报一句
 *        "Script failed to execute"，非常难查；页面还有 CSP 不许 eval 自检）。
 *
 *  解决办法：所有注入脚本一律用 **String.raw`...`**（原始字符串），
 *  反斜杠原样保留，脚本里就能像平时一样写 /\s+/、/\r/、/\n/。
 *
 *  这个测试负责把规矩钉住：
 *    ① base.mjs 里每个注入脚本都必须能编译（抽出模板 → 按 String.raw 规则还原 → new Function）
 *    ② page-utils.mjs 生成的整段脚本必须能编译，且关键正则存在
 *    ③ 禁止在注入模板里写"双反斜杠"（String.raw 下会变成字面反斜杠）
 * ============================================================================
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ADAPTERS = path.join(HERE, '..', 'adapters');
const BASE = path.join(ADAPTERS, 'base.mjs');

/**
 * 抽出 evalWithUtils(String.raw`...`, cfg) 的脚本本体。
 * String.raw 的语义 = 原样字符串，所以这里不需要做任何反转义。
 */
function extractRawScripts(source) {
  const out = [];
  const marker = 'evalWithUtils(String.raw`';
  let i = 0;
  while ((i = source.indexOf(marker, i)) !== -1) {
    const start = i + marker.length;
    let j = start;
    for (; j < source.length; j++) {
      if (source[j] === '`' && source[j - 1] !== '\\') break;
    }
    out.push({
      body: source.slice(start, j),
      line: source.slice(0, i).split('\n').length
    });
    i = j + 1;
  }
  return out;
}

/** 按 base.mjs 的拼装方式包一层，便于编译检查 */
function assemble(body) {
  return '(async () => {\n' +
    '  const A = window.__ARENA__;\n' +
    '  if (!A) return { ok: false };\n' +
    '  const CFG = {};\n' +
    '  try {\n' + body + '\n  } catch (err) { return { ok: false, error: String(err) }; }\n' +
    '})()';
}

test('base.mjs 里所有注入脚本都必须是合法 JS', () => {
  const source = fs.readFileSync(BASE, 'utf8');
  const scripts = extractRawScripts(source);
  assert.ok(scripts.length >= 20, '应该抽出至少 20 段注入脚本，实际 ' + scripts.length);

  const broken = [];
  for (const s of scripts) {
    const code = assemble(s.body);
    try {
      // eslint-disable-next-line no-new-func
      new Function('return ' + code);
    } catch (err) {
      broken.push(
        `注入脚本语法错误（base.mjs 第 ${s.line} 行附近）：${err.message}\n` +
        `  脚本片段：${JSON.stringify(s.body.trim().slice(0, 200))}`
      );
    }
  }
  assert.deepStrictEqual(broken, [], '\n' + broken.join('\n\n'));
});

test('page-utils.mjs 生成给页面的整段脚本必须能编译，且关键正则完好', () => {
  const { buildPageUtils } = require(path.join(ADAPTERS, 'page-utils.js'));
  const code = buildPageUtils();

  // ① 整段脚本能编译
  let err = null;
  try {
    // eslint-disable-next-line no-new-func
    new Function('return ' + code);
  } catch (e) {
    err = e;
  }
  assert.strictEqual(err, null, '生成的注入脚本语法错误：' + (err && err.message));

  // ② 关键正则不能被模板字符串"吃掉"
  //    （曾经写过 /\r/ 结果页面里变成 /g，这里就是那道防线）
  for (const re of ['/\\s+/', '/\\r/', '/\\n/', '[ \\t]']) {
    assert.ok(code.includes(re), `生成的脚本里应该保留正则片段 ${re}，说明反斜杠被模板字符串处理掉了`);
  }

  // ③ 不该出现"双反斜杠"（String.raw 下那会变成字面反斜杠，匹配不到预期字符）
  const suspicious = code.split('\n')
    .map((l, i) => ({ i: i + 1, l }))
    .filter((x) => /\/[^/\n]*\\\\[srn t]/.test(x.l))
    .slice(0, 5);
  assert.deepStrictEqual(suspicious, [],
    '\nString.raw 下反斜杠是原样保留的，正则里请写单反斜杠（不要写 \\\\s）：\n' +
    suspicious.map((x) => `  行${x.i}: ${x.l.trim()}`).join('\n'));
});

test('注入脚本必须使用 String.raw，禁止裸模板字符串（否则转义会被吃掉）', () => {
  const files = ['base.mjs', 'page-utils.mjs'];
  const problems = [];
  for (const f of files) {
    const src = fs.readFileSync(path.join(ADAPTERS, f), 'utf8');
    // 找出所有 "evalWithUtils(`" 这种没用 String.raw 的写法
    const bad = src.match(/evalWithUtils\(`/g);
    if (bad) problems.push(`  ${f}：有 ${bad.length} 处 evalWithUtils(\` ... ) 没有用 String.raw`);
    // page-utils 的主模板也必须是 String.raw
    if (f === 'page-utils.mjs' && !src.includes('return String.raw`')) {
      problems.push('  page-utils.mjs：buildPageUtils 的返回模板必须用 String.raw`');
    }
  }
  assert.deepStrictEqual(problems, [],
    '\n模板字符串会处理 \\n \\r \\t 等转义，导致页面里的正则被破坏。请统一写成 String.raw`：\n' + problems.join('\n'));
});
