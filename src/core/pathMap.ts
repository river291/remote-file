/**
 * 本地路径 <-> 远程路径的映射计算。
 *
 * 一个配置会解析出若干「同步根」(SyncRoot)：
 *   - root    ：context（本地根） <-> remotePath（远程根）
 *   - mapping ：mappings[] 里的每一条
 *
 * 一个本地文件落在哪个根下面，就按那个根算出远程路径。
 * 多个根重叠时取「匹配得最深的那个」，这样 mappings 可以覆盖默认根里的子目录。
 */
import * as path from 'node:path';
import type { ServerConfig } from './types';
import { posixJoin, posixNormalize, relativePosix, posixBasename } from './posixPath';

export interface SyncRoot {
  kind: 'root' | 'mapping';
  /** 展示给用户看的名字，例如 "默认" 或 "dist → /var/www/html"。 */
  label: string;
  /** 本地目录的绝对路径。 */
  localDir: string;
  /** 远程目录的绝对 POSIX 路径。 */
  remoteDir: string;
}

const IS_WINDOWS = process.platform === 'win32';

/** 本地路径比较用的归一化：Windows 下大小写不敏感。 */
function normalizeLocal(p: string): string {
  const abs = path.resolve(p);
  return IS_WINDOWS ? abs.toLowerCase() : abs;
}

/** 把本地绝对路径转成远程绝对路径。 */
export function resolveRoots(workspaceRoot: string, profile: ServerConfig): SyncRoot[] {
  const roots: SyncRoot[] = [];

  const contextAbs = path.resolve(workspaceRoot, profile.context || '.');
  const remoteRoot = posixNormalize(profile.remotePath || '/');
  roots.push({
    kind: 'root',
    label: profile.context && profile.context !== '.' ? `${profile.context} → ${remoteRoot}` : `默认 → ${remoteRoot}`,
    localDir: contextAbs,
    remoteDir: remoteRoot,
  });

  for (const m of profile.mappings ?? []) {
    const localAbs = path.resolve(workspaceRoot, m.local);
    const remoteDir = posixNormalize(m.remote);
    if (roots.some((r) => normalizeLocal(r.localDir) === normalizeLocal(localAbs))) {
      // 同一个本地目录重复映射：后写的覆盖先写的（用户意图更明确）
      const idx = roots.findIndex((r) => normalizeLocal(r.localDir) === normalizeLocal(localAbs));
      roots[idx] = { kind: 'mapping', label: `${m.local} → ${remoteDir}`, localDir: localAbs, remoteDir };
      continue;
    }
    roots.push({
      kind: 'mapping',
      label: `${m.local} → ${remoteDir}`,
      localDir: localAbs,
      remoteDir,
    });
  }

  // 本地目录更深（路径更长）的排前面，方便"取最匹配的那个"
  return roots.sort((a, b) => normalizeLocal(b.localDir).length - normalizeLocal(a.localDir).length);
}

export interface LocalMatch {
  root: SyncRoot;
  /** 相对 root.localDir 的 POSIX 路径；文件正好就是 root.localDir 时为 ''。 */
  relative: string;
}

/** 找出某个本地文件属于哪个同步根。 */
export function matchLocal(roots: readonly SyncRoot[], localAbs: string): LocalMatch | undefined {
  const target = normalizeLocal(localAbs);
  for (const root of roots) {
    const base = normalizeLocal(root.localDir);
    if (target === base) return { root, relative: '' };
    if (target.startsWith(base.endsWith(path.sep) ? base : base + path.sep)) {
      const rel = path.relative(root.localDir, path.resolve(localAbs));
      return { root, relative: rel.split(path.sep).join('/') };
    }
  }
  return undefined;
}

export interface RemoteMatch {
  root: SyncRoot;
  /** 相对 root.remoteDir 的 POSIX 路径。 */
  relative: string;
}

/** 找出某个远程路径属于哪个同步根（用于远程 -> 本地方向，例如下载）。 */
export function matchRemote(roots: readonly SyncRoot[], remotePath: string): RemoteMatch | undefined {
  const target = posixNormalize(remotePath);
  let best: RemoteMatch | undefined;
  for (const root of roots) {
    const rel = relativePosix(root.remoteDir, target);
    if (rel === null) continue;
    // 远程根更深者优先
    if (!best || root.remoteDir.length > best.root.remoteDir.length) {
      best = { root, relative: rel };
    }
  }
  return best;
}

/** 本地绝对路径 -> 远程绝对路径。不在任何同步根下时返回 undefined。 */
export function localToRemote(roots: readonly SyncRoot[], localAbs: string): string | undefined {
  const m = matchLocal(roots, localAbs);
  if (!m) return undefined;
  return m.relative === '' ? m.root.remoteDir : posixJoin(m.root.remoteDir, m.relative);
}

/** 远程绝对路径 -> 本地绝对路径。不在任何同步根下时返回 undefined。 */
export function remoteToLocal(roots: readonly SyncRoot[], remotePath: string): string | undefined {
  const m = matchRemote(roots, remotePath);
  if (!m) return undefined;
  if (m.relative === '') return m.root.localDir;
  return path.join(m.root.localDir, ...m.relative.split('/'));
}

/** 相对某个同步根的路径，用于忽略规则判断。 */
export function relativeToRoot(root: SyncRoot, localAbs: string): string | null {
  const base = normalizeLocal(root.localDir);
  const target = normalizeLocal(localAbs);
  if (target === base) return '';
  if (!target.startsWith(base.endsWith(path.sep) ? base : base + path.sep)) return null;
  return path.relative(root.localDir, path.resolve(localAbs)).split(path.sep).join('/');
}

export { posixBasename, posixNormalize };
