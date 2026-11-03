/**
 * 忽略规则匹配器。
 *
 * 支持常见的 glob 语法，行为对齐 .gitignore 的直觉：
 *   node_modules      -> 忽略任意层级下名为 node_modules 的目录及其内容
 *   *.log             -> 忽略任意层级下的 .log 文件
 *   dist/**           -> 忽略 dist 目录下的所有内容
 *   src/**\/*.test.ts -> 精确匹配
 *
 * 判定规则：某条规则命中「路径本身」或「路径的任意祖先目录」时，该路径被忽略。
 * 这样 node_modules 这样的目录名规则才能连带忽略它下面的所有文件。
 */
import { posixNormalize } from './posixPath';

/** 把一条 glob 转成正则，不做任何转义之外的魔法。 */
export function globToRegExp(pattern: string): RegExp {
  let p = String(pattern ?? '').trim();
  if (p === '') return /(?!)/; // 空规则永不匹配

  // 注意：这里刻意不使用前导 "!" 反选语义，保持规则可预测。
  if (p.startsWith('./')) p = p.slice(2);

  // 尾部的 "/**" 表示"这个目录以及它下面的所有内容"，并且也匹配目录本身
  // （用户写 dest/** 的时候想表达的就是"别管 dest"）。
  let suffix = '';
  if (/\/\*\*$/.test(p)) {
    p = p.slice(0, -3);
    suffix = '(?:/.*)?';
  }

  // 目录规则：尾部斜杠只表示"这是个目录"，匹配时路径本身已去掉尾部斜杠
  p = p.replace(/\/+$/, '');
  if (p === '') return suffix === '' ? /(?!)/ : /^(?:.*\/)?.*$/;

  const anchored = p.startsWith('/');
  if (anchored) p = p.slice(1);
  if (p === '') return /(?!)/;

  // 不含斜杠的规则匹配任意层级下的同名条目；含斜杠的规则从根开始匹配
  const hasSlash = p.includes('/');
  const prefix = anchored || hasSlash ? '^' : '^(?:.*/)?';
  return new RegExp(prefix + globSegmentsToRegExpSource(p) + suffix + '$');
}

/** 处理 *, **, ? 与字符组之外的字面量转义。 */
function globSegmentsToRegExpSource(glob: string): string {
  let out = '';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // ** 跨目录
        let j = i + 2;
        if (glob[j] === '/') {
          out += '(?:.*/)?';
          i = j + 1;
          continue;
        }
        out += '.*';
        i = j;
        continue;
      }
      out += '[^/]*';
      i += 1;
      continue;
    }
    if (c === '?') {
      out += '[^/]';
      i += 1;
      continue;
    }
    if (c === '[') {
      const end = glob.indexOf(']', i + 1);
      if (end > i) {
        let cls = glob.slice(i + 1, end);
        if (cls.startsWith('!')) cls = '^' + cls.slice(1);
        out += '[' + cls.replace(/\\/g, '\\\\') + ']';
        i = end + 1;
        continue;
      }
    }
    out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    i += 1;
  }
  return out;
}

export class IgnoreMatcher {
  private readonly rules: { source: string; re: RegExp }[] = [];

  constructor(patterns: readonly string[] = []) {
    for (const raw of patterns) {
      if (raw === undefined || raw === null) continue;
      const source = String(raw).trim();
      if (source === '' || source.startsWith('#')) continue;
      this.rules.push({ source, re: globToRegExp(source) });
    }
  }

  get size(): number {
    return this.rules.length;
  }

  /** 判断某个相对路径（POSIX 风格，不带前导斜杠）是否应当被忽略。 */
  ignores(relativePath: string): boolean {
    const rel = posixNormalize(relativePath);
    if (rel === '' || rel === '.' || rel === '/') return false;
    const clean = rel.replace(/^\/+/, '');
    const segments = clean.split('/').filter(Boolean);

    // 路径自身 + 所有祖先目录都要过一遍规则
    let prefix = '';
    for (let i = 0; i < segments.length; i++) {
      prefix = prefix === '' ? segments[i] : prefix + '/' + segments[i];
      for (const rule of this.rules) {
        if (rule.re.test(prefix)) return true;
      }
    }
    return false;
  }

  /** 命中的第一条规则，用于日志说明为什么跳过。 */
  match(relativePath: string): string | null {
    const rel = posixNormalize(relativePath);
    if (rel === '' || rel === '.' || rel === '/') return null;
    const segments = rel.replace(/^\/+/, '').split('/').filter(Boolean);
    let prefix = '';
    for (let i = 0; i < segments.length; i++) {
      prefix = prefix === '' ? segments[i] : prefix + '/' + segments[i];
      for (const rule of this.rules) {
        if (rule.re.test(prefix)) return rule.source;
      }
    }
    return null;
  }
}
