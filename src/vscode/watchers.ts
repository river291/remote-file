import * as vscode from 'vscode';
import { posixDirname } from '../core/posixPath';
import type { ConfigStore } from './configStore';
import type { Logger } from './logger';
import type { RemoteTreeProvider } from './remoteTree';
import type { SyncService } from './sync';

/**
 * 文件系统监听：保存自动上传、新建自动上传、删除同步、重命名同步。
 *
 * 为什么不只监听 onDidSaveTextDocument：
 *   - 新建的文件（还没保存过）不会触发 save，但用户期望它在磁盘上出现就传上去
 *   - 删除和重命名只能靠 FileSystemWatcher
 */
export class FileSyncWatcher implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly recent = new Map<string, number>();
  private started = false;

  constructor(
    private readonly config: ConfigStore,
    private readonly sync: SyncService,
    private readonly tree: RemoteTreeProvider,
    private readonly logger: Logger,
  ) {}

  start(): void {
    if (this.started) return;
    this.started = true;

    this.disposables.push(
      vscode.workspace.onDidSaveTextDocument((doc) => {
        void this.onSaved(doc);
      }),
    );

    // 重命名事件只有 workspace 级别的 API，注册一次即可（每个工作区注册会导致重复执行）
    this.disposables.push(vscode.workspace.onDidRenameFiles((e) => void this.onRename(e)));

    const folders = vscode.workspace.workspaceFolders ?? [];
    for (const folder of folders) {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(folder, '**/*'),
        false,
        true,
        false,
      );
      this.disposables.push(watcher, watcher.onDidCreate((uri) => void this.onCreate(uri)), watcher.onDidDelete((uri) => void this.onDelete(uri)));
    }

    this.logger.info(`已启动文件监听（${folders.length} 个工作区）`);
  }

  /** 短时间内同一个文件的重复触发只上传一次（保存和新建有时会同时触发）。 */
  private isDuplicate(localPath: string): boolean {
    const now = Date.now();
    const last = this.recent.get(localPath);
    if (last && now - last < 900) return true;
    this.recent.set(localPath, now);
    if (this.recent.size > 500) {
      for (const [k, t] of this.recent) {
        if (now - t > 60_000) this.recent.delete(k);
      }
    }
    return false;
  }

  private async onSaved(doc: vscode.TextDocument): Promise<void> {
    if (doc.uri.scheme !== 'file') return;
    const profile = this.config.active;
    if (!profile?.uploadOnSave) return;
    if (this.isDuplicate(doc.uri.fsPath)) return;
    await this.upload(doc.uri.fsPath, '保存');
  }

  private async onCreate(uri: vscode.Uri): Promise<void> {
    if (uri.scheme !== 'file') return;
    const profile = this.config.active;
    if (!profile?.uploadOnCreate) return;
    if (this.isDuplicate(uri.fsPath)) return;
    // 目录新建时不传（目录会随里面的文件一起建出来）
    let isDirectory = false;
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      isDirectory = stat.type === vscode.FileType.Directory;
    } catch {
      return;
    }
    if (isDirectory) return;
    await this.upload(uri.fsPath, '新建');
  }

  private async onDelete(uri: vscode.Uri): Promise<void> {
    if (uri.scheme !== 'file') return;
    const profile = this.config.active;
    if (!profile?.deleteOnLocalDelete) return;
    try {
      const done = await this.sync.deleteRemoteForLocal(uri.fsPath);
      if (done) {
        const plan = this.sync.plan(uri.fsPath, true);
        if (plan) this.tree.invalidateRemoteDir(plan.profile, posixDirname(plan.remotePath));
      }
    } catch (err) {
      this.logger.error(`同步删除远程文件失败：${uri.fsPath}`, err);
      void vscode.window.showErrorMessage(`同步删除远程文件失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async onRename(e: vscode.FileRenameEvent): Promise<void> {
    const profile = this.config.active;
    if (!profile) return;
    const touched = new Set<string>();
    for (const file of e.files) {
      if (file.oldUri.scheme !== 'file' || file.newUri.scheme !== 'file') continue;
      try {
        await this.sync.renameRemoteForLocal(file.oldUri.fsPath, file.newUri.fsPath);
      } catch (err) {
        this.logger.error(`同步重命名失败：${file.oldUri.fsPath}`, err);
      }
      // 改名会同时影响旧目录和新目录的列表
      for (const local of [file.oldUri.fsPath, file.newUri.fsPath]) {
        const plan = this.sync.plan(local, true);
        if (!plan) continue;
        const dir = posixDirname(plan.remotePath);
        if (touched.has(plan.profile.name + dir)) continue;
        touched.add(plan.profile.name + dir);
        this.tree.invalidateRemoteDir(plan.profile, dir);
      }
    }
  }

  private async upload(localPath: string, reason: string): Promise<void> {
    try {
      const result = await this.sync.uploadFile(localPath, { silent: true });
      // unchanged：内容跟上次传上去的一模一样（按了 Ctrl+S 但没改东西），日志里已经写过了
      if (result !== 'uploaded') return;
      this.logger.info(`（${reason}触发）已上传 ${localPath}`);
      // 定向刷新：只让文件落到的那一个远程目录重新列一次，
      // 侧边栏立刻能看到新文件/新大小，又不会为一次 Ctrl+S 把整棵树重拉。
      const plan = this.sync.plan(localPath, true);
      if (plan) this.tree.invalidateRemoteDir(plan.profile, posixDirname(plan.remotePath));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`${reason}自动上传失败：${localPath}`, err);
      void vscode.window.showErrorMessage(`自动上传失败：${message}`);
    }
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }
}
