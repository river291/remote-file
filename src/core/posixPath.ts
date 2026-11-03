/**
 * 远程路径一律使用 POSIX 风格（/ 分隔、绝对路径）。
 * 本地路径使用 node:path，跨平台交给它处理。
 * 这个文件只做纯字符串运算，不碰文件系统，方便单元测试。
 */

/** 把反斜杠统一成斜杠，去掉多余的分隔符和结尾斜杠。 */
export function posixNormalize(input: string): string {
  if (!input) return '/';
  let p = String(input).replace(/\\/g, '/');
  // 折叠重复斜杠（保留开头的，表示绝对路径）
  p = p.replace(/\/{2,}/g, '/');
  const absolute = p.startsWith('/');
  const parts: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length > 0 && parts[parts.length - 1] !== '..') parts.pop();
      else if (!absolute) parts.push('..');
      continue;
    }
    parts.push(seg);
  }
  const joined = parts.join('/');
  if (absolute) return '/' + joined;
  return joined === '' ? '.' : joined;
}

/** 拼接远程路径，结果永远是规范化后的绝对路径（除非全部入参都是相对路径）。 */
export function posixJoin(...parts: string[]): string {
  const filtered = parts.filter((p) => p !== undefined && p !== null && p !== '');
  if (filtered.length === 0) return '/';
  return posixNormalize(filtered.join('/'));
}

/** 返回父目录；已经是根目录时返回自身。 */
export function posixDirname(p: string): string {
  const n = posixNormalize(p);
  if (n === '/' || n === '.') return n;
  const idx = n.lastIndexOf('/');
  if (idx < 0) return '.';
  if (idx === 0) return '/';
  return n.slice(0, idx);
}

/** 返回最后一段名字；根目录返回 /。 */
export function posixBasename(p: string): string {
  const n = posixNormalize(p);
  if (n === '/') return '/';
  const idx = n.lastIndexOf('/');
  return idx < 0 ? n : n.slice(idx + 1);
}

/** child 是否等于 parent 或位于 parent 之下。 */
export function isSubPath(parent: string, child: string): boolean {
  const a = posixNormalize(parent);
  const b = posixNormalize(child);
  if (a === b) return true;
  if (a === '/') return b.startsWith('/');
  return b.startsWith(a + '/');
}

/** child 相对 parent 的路径。不在 parent 之下时返回 null。 */
export function relativePosix(parent: string, child: string): string | null {
  if (!isSubPath(parent, child)) return null;
  const a = posixNormalize(parent);
  const b = posixNormalize(child);
  if (a === b) return '';
  if (a === '/') return b.slice(1);
  return b.slice(a.length + 1);
}

/** 逐级列出祖先目录（含自身），从最外层到最内层。 */
export function ancestors(p: string): string[] {
  const n = posixNormalize(p);
  if (n === '/' || n === '.') return [n];
  const out: string[] = [];
  const segs = n.split('/').filter(Boolean);
  let cur = n.startsWith('/') ? '' : '.';
  if (n.startsWith('/')) out.push('/');
  for (const s of segs) {
    cur = cur === '/' ? '/' + s : cur === '' ? '/' + s : cur + '/' + s;
    out.push(posixNormalize(cur));
  }
  return out;
}
