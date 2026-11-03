import * as vscode from 'vscode';
import { resolveRoots, type SyncRoot } from '../core/pathMap';
import type { RemoteEntry, ServerConfig } from '../core/types';
import type { ConfigStore } from './configStore';
import type { ConnectionManager } from './connection';
import type { Logger } from './logger';
import type { SyncService } from './sync';
import { formatSize } from './sync';

export type RemoteNodeKind = 'profile' | 'root' | 'folder' | 'file' | 'link' | 'info';

/** 侧边栏里的一行。 */
export class RemoteNode extends vscode.TreeItem {
  constructor(
    readonly kind: RemoteNodeKind,
    label: string,
    readonly remotePath: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    readonly profile?: ServerConfig,
    readonly root?: SyncRoot,
    /** 同步根是 0，它下面的条目是 1，再往下递增。用于控制默认展开到第几层。 */
    readonly depth = 0,
  ) {
    super(label, collapsibleState);
  }
}

/**
 * 远程文件树。目录内容按需加载（展开时才去连服务器），并带缓存，
 * 刷新或改配置时整棵清掉。
 */
export class RemoteTreeProvider implements vscode.TreeDataProvider<RemoteNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<RemoteNode | undefined | void>();
  readonly onDidChangeTreeData: vscode.Event<RemoteNode | undefined | void> = this._onDidChangeTreeData.event;

  private readonly cache = new Map<string, RemoteNode[]>();
  private readonly errors = new Map<string, string>();

  constructor(
    private readonly config: ConfigStore,
    private readonly connection: ConnectionManager,
    private readonly sync: SyncService,
    private readonly logger: Logger,
  ) {}

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }

  refresh(node?: RemoteNode): void {
    if (node) {
      this.cache.delete(this.cacheKey(node.profile, node.remotePath));
      this.errors.delete(this.cacheKey(node.profile, node.remotePath));
    } else {
      this.cache.clear();
      this.errors.clear();
    }
    this._onDidChangeTreeData.fire(node);
  }

  /**
   * 只让某一个远程目录的缓存失效，然后通知视图重绘。
   *
   * 和 refresh() 的区别：refresh() 会把整棵树的缓存清空，之后所有展开的目录都要
   * 重新向服务器请求一遍。这个方法只清一个目录，视图重绘时其余目录直接命中缓存，
   * 只有这一个目录会真的发一次列目录请求 —— 用在"保存即上传"这种高频场景正合适。
   */
  invalidateRemoteDir(profile: ServerConfig | undefined, remoteDir: string): void {
    const key = this.cacheKey(profile, remoteDir);
    this.cache.delete(key);
    this.errors.delete(key);
    this._onDidChangeTreeData.fire(undefined);
  }

  private cacheKey(profile: ServerConfig | undefined, remotePath: string): string {
    return `${profile?.name ?? ''}::${remotePath}`;
  }

  /**
   * 默认展开到第几层（0 = 全部折叠，1 = 只展开同步根，2 = 再展开第一层目录…）。
   *
   * 之所以做成可配置而不是直接全展开：**每个被自动展开的目录都会立刻向服务器
   * 发一次列目录请求**。远程根下要是有几十个目录，设成 3 就是几十次请求打过去，
   * 在 FTP 上（一个目录约 3~4 次往返）会明显拖慢面板打开。
   */
  private expandDepth(): number {
    const raw = vscode.workspace.getConfiguration('remoteFile').get<number>('expandDepth', 1);
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.min(Math.floor(n), 3);
  }

  /** depth 小于展开层数的目录默认展开。 */
  private collapsibleFor(depth: number): vscode.TreeItemCollapsibleState {
    return depth < this.expandDepth()
      ? vscode.TreeItemCollapsibleState.Expanded
      : vscode.TreeItemCollapsibleState.Collapsed;
  }

  getTreeItem(element: RemoteNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: RemoteNode): Promise<RemoteNode[]> {
    if (!this.config.isLoaded) await this.config.refresh();

    if (!element) return this.getRoots();

    if (element.kind === 'profile') {
      const profile = element.profile as ServerConfig;
      // 展开另一台服务器 = 切换过去。这样插件内部所有操作（上传/下载/映射）
      // 都只围绕一个"当前服务器"，不会出现"看到 A 的文件却传到 B"这种事。
      if (this.config.active?.name !== profile.name) {
        await this.connection.disconnect();
        await this.config.setActive(profile.name);
      }
      return this.rootNodes(profile);
    }
    if (element.kind === 'root' || element.kind === 'folder') {
      return this.listDirectory(element);
    }
    return [];
  }

  /** 顶层：多服务器时先列服务器，单服务器时直接列同步根。 */
  private getRoots(): RemoteNode[] {
    if (this.config.error) {
      const node = new RemoteNode('info', `配置有问题：${this.config.error}`, '', vscode.TreeItemCollapsibleState.None);
      node.contextValue = 'remoteFile.info';
      node.iconPath = new vscode.ThemeIcon('warning');
      return [node];
    }

    const profiles = this.config.all;
    if (profiles.length === 0) return [];

    if (profiles.length > 1) {
      const active = this.config.active;
      return profiles.map((p) => {
        const node = new RemoteNode(
          'profile',
          p.name === active?.name ? `${p.name}（当前）` : p.name,
          '',
          vscode.TreeItemCollapsibleState.Collapsed,
          p,
        );
        node.description = `${p.protocol}://${p.host}:${p.port}`;
        node.contextValue = 'remoteFile.profile';
        node.iconPath = new vscode.ThemeIcon(p.name === active?.name ? 'server-process' : 'server');
        node.tooltip = `${p.name}\n${p.protocol}://${p.username}@${p.host}:${p.port}\n远程根目录：${p.remotePath}`;
        return node;
      });
    }

    return this.rootNodes(profiles[0]);
  }

  private rootNodes(profile: ServerConfig): RemoteNode[] {
    const workspaceRoot = this.config.root;
    if (!workspaceRoot) return [];
    const roots = resolveRoots(workspaceRoot, profile);
    return roots.map((root) => {
      const node = new RemoteNode(
        'root',
        root.remoteDir,
        root.remoteDir,
        this.collapsibleFor(0),
        profile,
        root,
        0,
      );
      node.description = root.label;
      // 注意：根节点不标成 remoteFile.folder，否则右键会出现"删除远程文件夹"，
      // 一不小心就把整个远程根目录清空了。
      node.contextValue = 'remoteFile.root';
      node.iconPath = new vscode.ThemeIcon('server');
      node.tooltip = `远程目录：${root.remoteDir}\n本地目录：${root.localDir}`;
      return node;
    });
  }

  private async listDirectory(element: RemoteNode): Promise<RemoteNode[]> {
    const profile = element.profile ?? this.config.active;
    if (!profile) return [];
    const key = this.cacheKey(profile, element.remotePath);

    const cached = this.cache.get(key);
    if (cached) return cached;

    try {
      const entries = await this.sync.listRemote(element.remotePath);
      this.errors.delete(key);
      const nodes = entries.map((entry) => this.entryNode(entry, profile, element.root, element.depth + 1));
      this.cache.set(key, nodes);
      return nodes;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`读取远程目录 ${element.remotePath} 失败`, err);
      this.errors.set(key, message);
      const node = new RemoteNode('info', `读取失败：${message}`, element.remotePath, vscode.TreeItemCollapsibleState.None, profile);
      node.contextValue = 'remoteFile.info';
      node.iconPath = new vscode.ThemeIcon('error');
      node.tooltip = '点击这里重试：执行 "刷新远程文件列表"';
      return [node];
    }
  }

  private entryNode(entry: RemoteEntry, profile: ServerConfig, root: SyncRoot | undefined, depth: number): RemoteNode {
    const isFolder = entry.type === 'folder';
    const node = new RemoteNode(
      isFolder ? 'folder' : entry.type === 'link' ? 'link' : 'file',
      entry.name,
      entry.path,
      isFolder ? this.collapsibleFor(depth) : vscode.TreeItemCollapsibleState.None,
      profile,
      root,
      depth,
    );
    node.contextValue = isFolder ? 'remoteFile.folder' : 'remoteFile.file';
    node.iconPath = isFolder
      ? new vscode.ThemeIcon('folder')
      : entry.type === 'link'
        ? new vscode.ThemeIcon('link')
        : vscode.ThemeIcon.File;

    if (isFolder) {
      node.tooltip = entry.path;
    } else {
      node.description = formatSize(entry.size);
      const when = entry.mtime ? new Date(entry.mtime).toLocaleString() : '未知';
      node.tooltip = `${entry.path}\n大小：${formatSize(entry.size)}\n修改时间：${when}`;
      node.command = {
        command: 'remoteFile.openRemoteFile',
        title: '查看远程文件',
        arguments: [node],
      };
    }
    return node;
  }

  /** 让某个远程路径在树里定位（目前只做整树刷新，够用且不易出错）。 */
  revealPath(): void {
    this.refresh();
  }
}
