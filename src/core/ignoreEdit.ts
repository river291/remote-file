/**
 * 在配置文件文本里增删 `ignore` 规则 —— **保留注释和原有格式**。
 *
 * 为什么不做"解析成对象 → 改 → 序列化回去"：那样会把 `//` / `#` 注释全部抹掉，
 * 而带注释正是这个配置文件的价值所在。所以这里做的是文本级手术，只动 `ignore` 那一段。
 *
 * 安全性：所有改动都只做"插入"或"删除一小段"，不改动其它任何字符；调用方写盘前还会
 * 再解析一次确认结果合法 —— 万一段落没排好看，也不会把配置文件改坏。
 */
import { parseConfigObject, type ConfigFormat } from './config';

export type IgnoreEditOutcome = 'added' | 'removed' | 'already-present' | 'not-present' | 'unsupported';

export interface IgnoreEditResult {
  text: string;
  outcome: IgnoreEditOutcome;
}

// ─────────────────────────── 对外入口 ───────────────────────────

export function addIgnoreRule(text: string, format: ConfigFormat, rule: string): IgnoreEditResult {
  return format === 'yaml' ? addYamlRule(text, rule) : addJsonRule(text, rule);
}

export function removeIgnoreRule(text: string, format: ConfigFormat, rule: string): IgnoreEditResult {
  return format === 'yaml' ? removeYamlRule(text, rule) : removeJsonRule(text, rule);
}

/** 当前有哪些规则（直接解析，最省事也最准）。 */
export function listIgnoreRules(text: string, format: ConfigFormat): string[] {
  let object: unknown;
  try {
    object = parseConfigObject(text, format);
  } catch {
    return [];
  }
  const raw = object && typeof object === 'object' ? (object as Record<string, unknown>).ignore : undefined;
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === 'string');
}

/**
 * 按扩展名生成"忽略该类型文件"的规则。
 *
 * `main.go` → `**\/*.go`（任意层级的 .go 文件）
 *
 * 没有扩展名时返回 undefined：`Makefile`、`.gitignore`（点开头算整个文件名）都不该按"类型"忽略。
 */
export function typeRuleFor(fileName: string): string | undefined {
  const base = String(fileName ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .pop() ?? '';
  const dot = base.lastIndexOf('.');
  // dot <= 0 同时排除了"没有点"和".gitignore 这种点开头的"
  if (dot <= 0) return undefined;
  const ext = base.slice(dot + 1);
  if (ext === '' || /[/*?[\]]/.test(ext)) return undefined;
  return `**/*.${ext}`;
}

// ─────────────────────────── JSON / JSONC ───────────────────────────

interface Span {
  start: number;
  end: number;
}

interface Element extends Span {
  value: string;
}

/** 跳过空白与 `//` `/* *​/` 注释。 */
function skipJsonTrivia(text: string, i: number): number {
  for (;;) {
    const c = text[i];
    if (c === undefined) return i;
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
      i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i);
      i = nl === -1 ? text.length : nl + 1;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      i = close === -1 ? text.length : close + 2;
      continue;
    }
    return i;
  }
}

/** 从开引号扫到收尾引号之后。 */
function scanJsonString(text: string, i: number): number {
  let j = i + 1;
  while (j < text.length) {
    const c = text[j];
    if (c === '\\') {
      j += 2;
      continue;
    }
    if (c === '"') return j + 1;
    j++;
  }
  return text.length;
}

function decodeJsonString(raw: string): string {
  try {
    return JSON.parse(raw) as string;
  } catch {
    return raw.slice(1, -1);
  }
}

/** 从 `[` 扫到配对的 `]` 之后。 */
function scanJsonArray(text: string, i: number): number {
  let depth = 0;
  let j = i;
  while (j < text.length) {
    j = skipJsonTrivia(text, j);
    const c = text[j];
    if (c === undefined) break;
    if (c === '"') {
      j = scanJsonString(text, j);
      continue;
    }
    if (c === '[' || c === '{') {
      depth++;
      j++;
      continue;
    }
    if (c === ']' || c === '}') {
      depth--;
      j++;
      if (depth === 0) return j;
      continue;
    }
    j++;
  }
  return text.length;
}

/** 找到顶层 `ignore` 字段的**值**的起始位置；没有这个字段时返回 undefined。 */
function findJsonIgnoreValueStart(text: string): number | undefined {
  let i = 0;
  let depth = 0;
  while (i < text.length) {
    i = skipJsonTrivia(text, i);
    const c = text[i];
    if (c === undefined) break;
    if (c === '{' || c === '[') {
      depth++;
      i++;
      continue;
    }
    if (c === '}' || c === ']') {
      depth--;
      i++;
      continue;
    }
    if (c === '"') {
      const strEnd = scanJsonString(text, i);
      const colon = skipJsonTrivia(text, strEnd);
      if (depth === 1 && text[colon] === ':' && decodeJsonString(text.slice(i, strEnd)) === 'ignore') {
        return skipJsonTrivia(text, colon + 1);
      }
      i = strEnd;
      continue;
    }
    i++;
  }
  return undefined;
}

/** 找到顶层 `"ignore": [...]` 的数组区间；字段不存在、或不是数组时返回 undefined。 */
function findJsonIgnoreArray(text: string): Span | undefined {
  const valueStart = findJsonIgnoreValueStart(text);
  if (valueStart === undefined || text[valueStart] !== '[') return undefined;
  return { start: valueStart, end: scanJsonArray(text, valueStart) };
}

/** 列出数组里的字符串元素及其在文本中的位置。 */
function jsonArrayElements(text: string, span: Span): Element[] {
  const out: Element[] = [];
  let i = span.start + 1;
  const limit = span.end - 1;
  while (i < limit) {
    const j = skipJsonTrivia(text, i);
    if (j >= limit) break;
    if (text[j] === '"') {
      const end = scanJsonString(text, j);
      out.push({ start: j, end, value: decodeJsonString(text.slice(j, end)) });
      i = end;
      continue;
    }
    i = j + 1;
  }
  return out;
}

/** 数组里元素的缩进（多行数组用）。 */
function arrayElementIndent(text: string, span: Span): string {
  const inner = text.slice(span.start + 1, span.end - 1);
  const lines = inner.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^([ \t]*)\S/.exec(lines[i]);
    if (m) return m[1];
  }
  return '  ';
}

function addJsonRule(text: string, rule: string): IgnoreEditResult {
  const span = findJsonIgnoreArray(text);
  if (!span) {
    // 字段存在但不是数组 → 拒绝动手。否则会追加出重复的 "ignore" 键，把用户原来的值悄悄顶掉。
    if (findJsonIgnoreValueStart(text) !== undefined) return { text, outcome: 'unsupported' };
    const withField = appendJsonIgnoreField(text, rule);
    return withField ? { text: withField, outcome: 'added' } : { text, outcome: 'unsupported' };
  }
  const elements = jsonArrayElements(text, span);
  if (elements.some((e) => e.value === rule)) return { text, outcome: 'already-present' };

  const close = span.end - 1; // ']' 的位置
  const inner = text.slice(span.start + 1, close);
  const literal = JSON.stringify(rule);

  if (elements.length === 0) {
    // 空数组直接放一行，别搞出多行空壳
    return { text: text.slice(0, span.start) + `[${literal}]` + text.slice(span.end), outcome: 'added' };
  }
  if (!inner.includes('\n')) {
    return { text: text.slice(0, close) + `, ${literal}` + text.slice(close), outcome: 'added' };
  }
  // 多行数组：接在最后一个元素后面，保持同样的缩进
  const last = elements[elements.length - 1];
  const indent = arrayElementIndent(text, span);
  const insertion = `,\n${indent}${literal}`;
  return { text: text.slice(0, last.end) + insertion + text.slice(last.end), outcome: 'added' };
}

function removeJsonRule(text: string, rule: string): IgnoreEditResult {
  const span = findJsonIgnoreArray(text);
  if (!span) {
    // 字段存在但不是数组：看不懂，别改
    return { text, outcome: findJsonIgnoreValueStart(text) !== undefined ? 'unsupported' : 'not-present' };
  }
  const target = jsonArrayElements(text, span).find((e) => e.value === rule);
  if (!target) return { text, outcome: 'not-present' };

  let delStart = target.start;
  let delEnd = target.end;

  const afterComma = skipJsonTrivia(text, target.end);
  if (text[afterComma] === ',') {
    delEnd = afterComma + 1;
    while (delEnd < text.length && (text[delEnd] === ' ' || text[delEnd] === '\t')) delEnd++;
    // 后面的换行也带走，免得留一整行空白
    if (text[delEnd] === '\r') delEnd++;
    if (text[delEnd] === '\n') delEnd++;
  } else {
    // 是最后一个元素：删它前面的逗号
    let before = target.start - 1;
    while (before > span.start && /[ \t\r\n]/.test(text[before])) before--;
    if (text[before] === ',') {
      delStart = before;
      while (delStart > span.start && (text[delStart - 1] === ' ' || text[delStart - 1] === '\t')) delStart--;
    }
  }

  return { text: text.slice(0, delStart) + text.slice(delEnd), outcome: 'removed' };
}

/** 配置里压根没有 ignore 字段时，补一个进去。 */
function appendJsonIgnoreField(text: string, rule: string): string | undefined {
  // 找根对象的收尾 '}'：从第一个 '{' 开始配对
  const open = text.indexOf('{');
  if (open === -1) return undefined;
  let depth = 0;
  let close = -1;
  let i = open;
  while (i < text.length) {
    i = skipJsonTrivia(text, i);
    const c = text[i];
    if (c === undefined) break;
    if (c === '"') {
      i = scanJsonString(text, i);
      continue;
    }
    if (c === '{' || c === '[') {
      depth++;
      i++;
      continue;
    }
    if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
      i++;
      continue;
    }
    i++;
  }
  if (close === -1) return undefined;

  const before = skipJsonTrivia(text, open + 1);
  const isEmpty = before === close;
  const literal = JSON.stringify(rule);
  const body = isEmpty ? `\n  "ignore": [${literal}]\n` : `,\n  "ignore": [${literal}]\n`;
  return text.slice(0, close) + body + text.slice(close);
}

// ─────────────────────────── YAML ───────────────────────────

type YamlIgnoreFound =
  | {
      kind: 'list';
      /** `ignore:` 这一行的下标（0 基）。 */
      keyLine: number;
      keyIndent: string;
      /** 块列表形式的元素。 */
      items: { line: number; indent: string; value: string }[];
      /** 行内流式列表 `ignore: [a, b]` 的区间。 */
      flow?: Span;
    }
  | { kind: 'other' };

/** 找 `ignore:` 字段。返回 undefined 表示压根没有这个字段。 */
function findYamlIgnore(text: string): YamlIgnoreFound | undefined {
  const lines = text.split('\n');
  let offset = 0;
  const offsets: number[] = [];
  for (const line of lines) {
    offsets.push(offset);
    offset += line.length + 1;
  }

  for (let i = 0; i < lines.length; i++) {
    const m = /^([ \t]*)ignore[ \t]*:(.*)$/.exec(lines[i]);
    if (!m) continue;
    const keyIndent = m[1];
    const rest = stripYamlComment(m[2]).trim();

    if (rest.startsWith('[')) {
      const start = offsets[i] + lines[i].indexOf('[');
      return { kind: 'list', keyLine: i, keyIndent, items: [], flow: { start, end: findFlowEnd(text, start) } };
    }
    // 是个标量（比如 ignore: "x"）→ 看不懂，别改
    if (rest !== '') return { kind: 'other' };

    // 块列表：往下收集缩进更深的 `- xxx`（空行和注释行跳过，不算结束）
    const items: { line: number; indent: string; value: string }[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (line.trim() === '' || line.trim().startsWith('#')) continue;
      const im = /^([ \t]*)-[ \t]*(.*)$/.exec(line);
      if (!im) break;
      if (im[1].length <= keyIndent.length) break;
      items.push({ line: j, indent: im[1], value: unquoteYaml(stripYamlComment(im[2]).trim()) });
    }
    return { kind: 'list', keyLine: i, keyIndent, items };
  }
  return undefined;
}

function stripYamlComment(s: string): string {
  // YAML 里只有当 # 前面是空白或行首时才是注释
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '#' && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i);
  }
  return s;
}

function unquoteYaml(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
  return s;
}

/** YAML 里这些字符开头的裸标量会被当成别名/锚点/注释/块标记等，必须加引号。 */
const YAML_SPECIAL_START = new Set([
  '*', '&', '!', '%', '@', '`', '{', '}', '[', ']', ',', '>', '|', '?', '#', '-', ':', "'", '"',
]);

/** YAML 值什么时候需要加引号（配置模板和忽略规则共用）。 */
export function yamlScalar(rule: string): string {
  if (rule === '') return '""';
  const needsQuote =
    YAML_SPECIAL_START.has(rule[0]) ||
    /^\s|\s$/.test(rule) || // 首尾空白
    /[:#]\s/.test(rule) || // 冒号/井号后面跟空格
    /\s#/.test(rule) ||
    /^(true|false|null|yes|no|on|off|~)$/i.test(rule) ||
    /^[\d.+-]+$/.test(rule);
  return needsQuote ? JSON.stringify(rule) : rule;
}

function findFlowEnd(text: string, start: number): number {
  let depth = 0;
  let j = start;
  while (j < text.length) {
    const c = text[j];
    if (c === '"' || c === "'") {
      const quote = c;
      j++;
      while (j < text.length && text[j] !== quote) {
        if (quote === '"' && text[j] === '\\') j++;
        j++;
      }
      j++;
      continue;
    }
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) return j + 1;
    }
    j++;
  }
  return text.length;
}

function flowElements(text: string, span: Span): Element[] {
  const out: Element[] = [];
  let i = span.start + 1;
  const limit = span.end - 1;
  while (i < limit) {
    while (i < limit && /[\s,]/.test(text[i])) i++;
    if (i >= limit) break;
    const start = i;
    let value = '';
    if (text[i] === '"' || text[i] === "'") {
      const quote = text[i];
      i++;
      let buf = '';
      while (i < limit && text[i] !== quote) {
        if (quote === '"' && text[i] === '\\') {
          buf += text[i + 1] ?? '';
          i += 2;
          continue;
        }
        buf += text[i];
        i++;
      }
      i++;
      value = buf;
    } else {
      while (i < limit && text[i] !== ',') i++;
      value = text.slice(start, i).trim();
    }
    out.push({ start, end: i, value });
  }
  return out;
}

function addYamlRule(text: string, rule: string): IgnoreEditResult {
  const info = findYamlIgnore(text);
  if (info === undefined) {
    // 没有 ignore 字段：直接追加到文件末尾
    const needsNewline = text.length > 0 && !text.endsWith('\n');
    return {
      text: `${text}${needsNewline ? '\n' : ''}\nignore:\n  - ${yamlScalar(rule)}\n`,
      outcome: 'added',
    };
  }
  // 字段是标量之类的怪东西：拒绝动手，免得追加出重复键
  if (info.kind === 'other') return { text, outcome: 'unsupported' };

  if (info.flow) {
    const elements = flowElements(text, info.flow);
    if (elements.some((e) => e.value === rule)) return { text, outcome: 'already-present' };
    const close = info.flow.end - 1;
    const literal = yamlScalar(rule);
    const sep = elements.length === 0 ? '' : ', ';
    return { text: text.slice(0, close) + sep + literal + text.slice(close), outcome: 'added' };
  }

  if (info.items.some((it) => it.value === rule)) return { text, outcome: 'already-present' };
  const lines = text.split('\n');
  const indent = info.items.length > 0 ? info.items[info.items.length - 1].indent : info.keyIndent + '  ';
  const anchor = info.items.length > 0 ? info.items[info.items.length - 1].line : info.keyLine;
  lines.splice(anchor + 1, 0, `${indent}- ${yamlScalar(rule)}`);
  return { text: lines.join('\n'), outcome: 'added' };
}

function removeYamlRule(text: string, rule: string): IgnoreEditResult {
  const info = findYamlIgnore(text);
  if (info === undefined) return { text, outcome: 'not-present' };
  if (info.kind === 'other') return { text, outcome: 'unsupported' };

  if (info.flow) {
    const elements = flowElements(text, info.flow);
    const target = elements.find((e) => e.value === rule);
    if (!target) return { text, outcome: 'not-present' };
    let delStart = target.start;
    let delEnd = target.end;
    // 连带后面的逗号；如果是最后一个就删前面的
    let j = delEnd;
    while (j < info.flow.end - 1 && /[\s]/.test(text[j])) j++;
    if (text[j] === ',') delEnd = j + 1;
    else {
      let k = delStart - 1;
      while (k > info.flow.start && /\s/.test(text[k])) k--;
      if (text[k] === ',') delStart = k;
    }
    return { text: text.slice(0, delStart) + text.slice(delEnd), outcome: 'removed' };
  }

  const target = info.items.find((it) => it.value === rule);
  if (!target) return { text, outcome: 'not-present' };
  const lines = text.split('\n');
  lines.splice(target.line, 1);
  return { text: lines.join('\n'), outcome: 'removed' };
}
