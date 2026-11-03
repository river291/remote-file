import * as vscode from 'vscode';
import type { DigestStore } from '../core/digestStore';

const STORAGE_KEY = 'remoteFile.syncedDigests';
/** 超过这个条数就提示一下：账本会越来越大，但还是留着（删掉会丢失"本地已删"的判断力）。 */
const WARN_SIZE = 20000;
/** 写盘去抖：保存文件时可能每秒都更新，没必要每次都序列化整个账本。 */
const FLUSH_DELAY_MS = 2000;

/**
 * 把账本存进 VSCode 的 workspaceState（跟着工作区走，不进项目目录，也不会被上传）。
 *
 * 写盘做了去抖：一次「全部保存」可能触发几十次 set，攒够 2 秒再落盘一次。
 * 真正要保证不丢的是 deactivate 时的那次 flush。
 */
export class WorkspaceDigestStore implements DigestStore {
  private readonly entries = new Map<string, string>();
  private dirty = false;
  private timer?: NodeJS.Timeout;
  private warned = false;

  constructor(private readonly context: vscode.ExtensionContext) {
    const saved = context.workspaceState.get<Record<string, string>>(STORAGE_KEY);
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
      for (const [key, value] of Object.entries(saved)) {
        if (typeof value === 'string' && key.includes('\u0000')) this.entries.set(key, value);
      }
    }
  }

  get size(): number {
    return this.entries.size;
  }

  get(key: string): string | undefined {
    return this.entries.get(key);
  }

  set(key: string, value: string): void {
    this.entries.set(key, value);
    this.schedule();
  }

  delete(key: string): boolean {
    const removed = this.entries.delete(key);
    if (removed) this.schedule();
    return removed;
  }

  keys(): string[] {
    return [...this.entries.keys()];
  }

  private schedule(): void {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, FLUSH_DELAY_MS);
    this.timer.unref?.();
  }

  /** 立刻落盘。VSCode 关闭时会调用它。 */
  async flush(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.entries.size > WARN_SIZE && !this.warned) {
      this.warned = true;
      // 不清理：删掉条目会丢失"本地已删"的判断力，宁可变大
      void vscode.window.showWarningMessage(
        `Remote File：同步账本已经有 ${this.entries.size} 个条目，会占用一些存储空间。项目特别大的话可以考虑关掉无关目录的同步。`,
      );
    }
    const plain: Record<string, string> = {};
    for (const [key, value] of this.entries) plain[key] = value;
    try {
      await this.context.workspaceState.update(STORAGE_KEY, plain);
    } catch (err) {
      // 存不下就算了，下次操作会重新补上；最坏情况是重启后多传一次
      this.dirty = true;
      void err;
    }
  }
}
