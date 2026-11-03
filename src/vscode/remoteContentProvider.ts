import * as vscode from 'vscode';
import { posixBasename } from '../core/posixPath';
import type { ConfigStore } from './configStore';
import type { Logger } from './logger';
import type { SyncService } from './sync';
import { formatSize } from './sync';

export const REMOTE_SCHEME = 'remote-file';
/** 远程文档在标签页上显示的前缀，用来和本地那份区分开。 */
export const REMOTE_LABEL_PREFIX = '(远程) ';
/** 超过这个大小就不在编辑器里打开了，避免卡死。 */
const MAX_PREVIEW_BYTES = 8 * 1024 * 1024;

/**
 * 把远程文件内容喂给编辑器，实现"点一下就能看远程文件"。
 * 用的是虚拟文档（只读），不会在本地磁盘留下任何东西。
 *
 * URI 的构造方式很讲究，见 uriFor() 上的注释 —— 这里踩过一次坑。
 */
export class RemoteContentProvider implements vscode.TextDocumentContentProvider {
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange: vscode.Event<vscode.Uri> = this._onDidChange.event;

  constructor(
    private readonly config: ConfigStore,
    private readonly sync: SyncService,
    private readonly logger: Logger,
  ) {}

  dispose(): void {
    this._onDidChange.dispose();
  }

  /**
   * 构造预览用的虚拟文档 URI。
   *
   * 结构：`remote-file:/<显示名>?p=<真实远程路径的 base64url>&n=<服务器名的 base64url>`
   *
   * 两个要点：
   *
   * 1. **不能靠字符串拼接**。曾经写成 `vscode.Uri.parse(`${SCHEME}:/${remotePath}`)`，
   *    remotePath 本身以 `/` 开头，于是拼出 `remote-file://www/index.html` ——
   *    URI 语法里 `//` 之后是 authority（主机名），第一层目录会被当成主机名丢掉：
   *      - `/www/index.html` → authority="www"，path="/index.html"（静默读错文件）
   *      - `/index.html`     → authority="index.html"，path=""（变成读取整个根目录，
   *        FTP 服务器回 "I can only retrieve regular files"）
   *    现在用 `Uri.from({ path })` 明确指定路径（原样保存，不编码不解码）。
   *
   * 2. **真实路径放在 query 里而不是 path 里**，因为 path 要留给"给人看的标签名"
   *    （`(远程) index.html`）。query 的值用 base64url 编码 —— 它的字符集只有
   *    `A-Za-z0-9-_`，不含 `%` `&` `=` `+` `/`，所以无论 VSCode 对 query 做
   *    还是不做百分号解码，解析回来都是同一个字符串，彻底避开编码歧义。
   */
  static uriFor(remotePath: string, profileName?: string, displayName?: string): vscode.Uri {
    const name = displayName ?? REMOTE_LABEL_PREFIX + posixBasename(remotePath);
    const params = new URLSearchParams();
    params.set('p', toBase64Url(remotePath));
    if (profileName) params.set('n', toBase64Url(profileName));
    return vscode.Uri.from({
      scheme: REMOTE_SCHEME,
      path: '/' + name,
      query: params.toString(),
    });
  }

  /** 从 URI 还原远程路径。 */
  static remotePathOf(uri: vscode.Uri): string {
    const fromQuery = fromBase64Url(paramsOf(uri).get('p'));
    if (fromQuery) return fromQuery;
    // 兜底：没有 query 的旧式 URI，只能把 path 当路径用
    const path = uri.path || '/';
    return path.startsWith('/') ? path : '/' + path;
  }

  /** 从 URI 里取服务器名（多服务器时同一个远程路径属于不同文档）。 */
  static profileNameOf(uri: vscode.Uri): string | undefined {
    return fromBase64Url(paramsOf(uri).get('n'));
  }

  /** 内容变了（比如重新上传后）就让编辑器重新拉一次。 */
  invalidate(remotePath: string, profileName?: string): void {
    this._onDidChange.fire(RemoteContentProvider.uriFor(remotePath, profileName));
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const remotePath = RemoteContentProvider.remotePathOf(uri);
    const profileName = RemoteContentProvider.profileNameOf(uri);
    try {
      const data = await this.sync.readRemote(remotePath, profileName);
      if (data.length > MAX_PREVIEW_BYTES) {
        return `文件太大（${formatSize(data.length)}），已超出预览上限 ${formatSize(MAX_PREVIEW_BYTES)}。\n\n请用「下载到本地」把它取下来再看。`;
      }
      if (looksBinary(data)) {
        return `这是一个二进制文件（${formatSize(data.length)}），无法以文本方式预览。\n\n请用「下载到本地」把它取下来。`;
      }
      // 去掉 UTF-8 BOM，否则编辑器会显示一个乱码字符
      const text = data.toString('utf8');
      return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`读取远程文件失败 ${remotePath}`, err);
      return `读取远程文件失败：\n\n${message}`;
    }
  }
}

function paramsOf(uri: vscode.Uri): URLSearchParams {
  try {
    return new URLSearchParams(uri.query || '');
  } catch {
    return new URLSearchParams();
  }
}

/** 用 URL 安全字符集编码，避开百分号编码带来的歧义。 */
export function toBase64Url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  } catch {
    return undefined;
  }
}

function looksBinary(data: Buffer): boolean {
  const limit = Math.min(data.length, 8000);
  for (let i = 0; i < limit; i++) {
    if (data[i] === 0) return true;
  }
  return false;
}
