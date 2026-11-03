/**
 * 「上次同步时本地是什么内容」的账本。
 *
 * 键 = `连接信息 \0 远程路径`，值 = 内容指纹（SHA1）。
 *
 * 它支撑两件事：
 *   1. 保存时判断"内容没变就不传"
 *   2. 启动/手动增量同步时判断"哪些变了、哪些本地已经删了"
 *
 * 第 2 条要求它**必须能持久化** —— 插件一重启，内存里的东西就没了，
 * 而"上次传到哪"恰恰是重启之后最需要知道的信息。
 */

/** 键的分隔符。用 NUL，因为它在路径和连接信息里都不可能出现。 */
export const DIGEST_KEY_SEP = '\u0000';

/**
 * 「只是记录到过」的标记，加在指纹前面。
 *
 * 第一次启用会建立基线：把当前本地文件的状态记下来作为基准。但这些文件**我们并没有传过**
 * —— 远程那份可能是别人放的。如果不加区分，本地删掉一个从没传过、但远程恰好同名的文件时，
 * 就会把别人的文件删掉。
 *
 * 所以：带这个标记的条目只用来判断"内容有没有变"，**绝不参与删除判断**。
 * 只有真的被本插件传成功过的条目（不带标记）才允许删远程。
 */
export const BASELINE_MARK = '\u0001';

export function markBaseline(digest: string): string {
  return BASELINE_MARK + digest;
}

/** 去掉标记，拿到真正的指纹。 */
export function unmarkDigest(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.startsWith(BASELINE_MARK) ? value.slice(1) : value;
}

/** 这个条目是不是"我们自己传上去的"（只有这种才允许删远程）。 */
export function uploadedByUs(value: string | undefined): boolean {
  return !!value && !value.startsWith(BASELINE_MARK);
}

export interface DigestStore {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  delete(key: string): boolean;
  /** 所有键的快照。增量同步靠它找出"账本里有、本地却没了"的条目。 */
  keys(): string[];
  readonly size: number;
}

/** 连接的标识。换服务器/换账号/换端口都会变，账本自然失效。 */
export function connectionIdOf(server: {
  protocol: string;
  username: string;
  host: string;
  port: number;
}): string {
  return `${server.protocol}://${server.username}@${server.host}:${server.port}`;
}

export function digestKey(connectionId: string, remotePath: string): string {
  return connectionId + DIGEST_KEY_SEP + remotePath;
}

export function parseDigestKey(key: string): { connectionId: string; remotePath: string } | undefined {
  const idx = key.indexOf(DIGEST_KEY_SEP);
  if (idx <= 0) return undefined;
  return { connectionId: key.slice(0, idx), remotePath: key.slice(idx + 1) };
}

/**
 * 账本里用来记「这台服务器已经建过基线了」的假路径。
 *
 * 为什么不靠"账本是不是空的"来判断首次：**每上传成功一个文件账本就会多一条记录**。
 * 用户只要正常用一会儿再打开自动同步，账本就不空了 —— 于是第一次扫描会被当成
 * "不是首次"，把整个项目都当成新增文件报出来。
 *
 * 远程路径一定以 `/` 开头，所以下面这个以 \u0001 开头的值不会和真实路径撞。
 */
export const BASELINE_FLAG_PATH = '\u0001__baseline__';

export function baselineFlagKey(connectionId: string): string {
  return digestKey(connectionId, BASELINE_FLAG_PATH);
}

export function isBaselineFlagKey(key: string): boolean {
  return parseDigestKey(key)?.remotePath === BASELINE_FLAG_PATH;
}

/** 纯内存实现，用于测试；真实运行用的是 vscode/workspaceDigestStore.ts。 */
export class MemoryDigestStore implements DigestStore {
  private readonly entries = new Map<string, string>();

  get(key: string): string | undefined {
    return this.entries.get(key);
  }

  set(key: string, value: string): void {
    this.entries.set(key, value);
  }

  delete(key: string): boolean {
    return this.entries.delete(key);
  }

  keys(): string[] {
    return [...this.entries.keys()];
  }

  get size(): number {
    return this.entries.size;
  }
}
