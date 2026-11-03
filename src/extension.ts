import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { posixBasename } from './core/posixPath';
import type { ServerConfig } from './core/types';
import { ConfigStore } from './vscode/configStore';
import { ConnectionManager } from './vscode/connection';
import { Logger } from './vscode/logger';
import { RemoteContentProvider, REMOTE_SCHEME } from './vscode/remoteContentProvider';
import { RemoteNode, RemoteTreeProvider } from './vscode/remoteTree';
import { SyncService, formatSize, type DownloadOutcome, type IncrementalScan } from './vscode/sync';
import { FileSyncWatcher } from './vscode/watchers';
import { ConfigWizard } from './vscode/configWizard';
import { IgnoreRuleCommands } from './vscode/ignoreCommands';
import { publishIgnoredPaths } from './vscode/ignoredPaths';
import { WorkspaceDigestStore } from './vscode/workspaceDigestStore';

let logger: Logger;
let config: ConfigStore;
let connection: ConnectionManager;
let sync: SyncService;
let tree: RemoteTreeProvider;
let content: RemoteContentProvider;
let watcher: FileSyncWatcher;
let status: vscode.StatusBarItem;
let digestStore: WorkspaceDigestStore;
let ignoreRules: IgnoreRuleCommands;
let wizard: ConfigWizard;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  logger = new Logger();
  config = new ConfigStore(context, logger);
  connection = new ConnectionManager(logger);
  digestStore = new WorkspaceDigestStore(context);
  sync = new SyncService(config, connection, logger, digestStore);
  ignoreRules = new IgnoreRuleCommands(config, logger);
  wizard = new ConfigWizard(config, connection, logger);
  tree = new RemoteTreeProvider(config, connection, sync, logger);
  content = new RemoteContentProvider(config, sync, logger);
  watcher = new FileSyncWatcher(config, sync, tree, logger);

  const view = vscode.window.createTreeView('remoteFile.explorer', {
    treeDataProvider: tree,
    showCollapseAll: true,
  });

  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = 'remoteFile.showMenu';
  status.show();

  context.subscriptions.push(
    logger,
    config,
    connection,
    tree,
    content,
    watcher,
    view,
    status,
    vscode.workspace.registerTextDocumentContentProvider(REMOTE_SCHEME, content),
    connection.onDidChangeState(() => updateStatus()),
    config.onDidChange(() => {
      updateStatus();
      tree.refresh();
      // 忽略规则变了，菜单的显示条件也要跟着更新
      void publishIgnoredPaths(config, logger);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('remoteFile')) void reloadConfig();
    }),
    vscode.workspace.onDidOpenTextDocument((doc) => void maybeFixConfigLanguage(doc)),
    vscode.workspace.onDidChangeWorkspaceFolders(() => void reloadConfig()),
    // 侧边栏一露出来就提前把连接建好，这样第一次展开目录不用再等握手
    view.onDidChangeVisibility((e) => {
      if (e.visible) void warmUpConnection();
    }),
    ...registerCommands(context),
  );

  watchConfigFile(context);

  await config.refresh();
  // 已经开着的配置文件也顺手切一下语言模式（去掉 // 注释的语法波浪线）
  for (const doc of vscode.workspace.textDocuments) void maybeFixConfigLanguage(doc);
  // 首次发布一次忽略路径集合，右键菜单的显示条件立刻就是对的
  void publishIgnoredPaths(config, logger);

  // 启动时的增量补同步：VSCode 没开的时候，磁盘上的改动（比如用别的工具或 agent 改的）
  // 会在这时候被发现并补上去。
  void runStartupSync();
  if (view.visible) void warmUpConnection();
  if (config.error) {
    void vscode.window.showErrorMessage(`Remote File：${config.error}`);
  } else if (config.all.length > 0) {
    logger.info(`Remote File 已就绪：${config.all.length} 个服务器配置`);
  }

  watcher.start();
  updateStatus();
}

export function deactivate(): Thenable<void> | undefined {
  // 账本可能有还没落盘的改动，关窗口前刷一次
  return digestStore?.flush();
}

// ─────────────────────────── 状态栏 ───────────────────────────

function updateStatus(): void {
  const profile = config.active;
  if (!profile) {
    status.text = '$(cloud) 远程: 未配置';
    status.tooltip = '点击配置 FTP/SFTP（Remote File）';
    status.backgroundColor = undefined;
    return;
  }
  const connected = connection.isConnected(profile);
  const icon = connected ? '$(cloud-upload)' : '$(cloud)';
  status.text = `${icon} ${profile.name}`;
  status.tooltip = [
    `${profile.protocol.toUpperCase()} ${profile.username}@${profile.host}:${profile.port}`,
    `状态：${connected ? '已连接' : '未连接（按需自动连接）'}`,
    `远程根目录：${profile.remotePath}`,
    '点击打开操作菜单',
  ].join('\n');
  status.backgroundColor = undefined;
}

// ─────────────────────────── 命令 ───────────────────────────

type NodeArg = RemoteNode | vscode.Uri | undefined;

function registerCommands(context: vscode.ExtensionContext): vscode.Disposable[] {
  const register = (id: string, handler: (...args: any[]) => any): vscode.Disposable =>
    vscode.commands.registerCommand(id, handler);

  return [
    register('remoteFile.refresh', async () => {
      await reloadConfig();
      tree.refresh();
    }),

    register('remoteFile.reconnect', async () => {
      await connection.disconnect();
      updateStatus();
      await reloadConfig();
      tree.refresh();
      void vscode.window.showInformationMessage('Remote File：已断开，下次操作会重新连接。');
    }),

    register('remoteFile.uploadCurrentFile', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.uri.scheme !== 'file') {
        void vscode.window.showWarningMessage('没有正在编辑的本地文件。');
        return;
      }
      await withProgress('正在上传…', async () => {
        const result = await sync.uploadFile(editor.document.uri.fsPath, { force: true });
        if (result === 'out-of-scope') {
          void vscode.window.showWarningMessage('这个文件不在同步范围里（可能命中了忽略规则）。');
        } else {
          void vscode.window.setStatusBarMessage('$(check) 已上传', 3000);
          tree.refresh();
        }
      });
    }),

    register('remoteFile.uploadPath', async (arg: unknown) => {
      const localPath = await resolveLocalPathFromArg(arg);
      if (!localPath) return;
      const stat = await fs.promises.stat(localPath).catch(() => undefined);
      if (!stat) {
        void vscode.window.showWarningMessage('本地路径不存在。');
        return;
      }
      if (stat.isDirectory()) {
        const pick = await vscode.window.showWarningMessage(
          `要把整个目录上传到远程吗？\n${localPath}`,
          { modal: true },
          '上传',
        );
        if (pick !== '上传') return;
      }
      await withProgress('正在上传…', async () => {
        const result = await sync.uploadPath(localPath, { force: true });
        reportUpload(logger, result);
        tree.refresh();
      });
    }),

    register('remoteFile.uploadAll', async () => {
      const profile = config.active;
      if (!profile) {
        void vscode.window.showWarningMessage('还没有配置服务器。');
        return;
      }
      const roots = config.roots().map((r) => `${r.localDir}  →  ${r.remoteDir}`);
      const pick = await vscode.window.showWarningMessage(
        `要把以下同步根下面的所有文件都传上去吗？\n\n${roots.join('\n')}\n\n（忽略规则里的内容会跳过）`,
        { modal: true },
        '上传',
      );
      if (pick !== '上传') return;
      await withProgress('正在上传整个项目…', async () => {
        const result = await sync.uploadAll({ force: true });
        reportUpload(logger, result);
        tree.refresh();
      });
    }),

    register('remoteFile.downloadPath', async (arg: unknown) => {
      const node = arg instanceof RemoteNode ? arg : undefined;
      if (!node) {
        void vscode.window.showWarningMessage('请在远程文件列表里右键选择要下载的文件或文件夹。');
        return;
      }
      const target = sync.remoteToLocal(node.remotePath);
      let localPath = target;
      if (!localPath) {
        const chosen = await vscode.window.showOpenDialog({
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: false,
          openLabel: '下载到这个目录',
        });
        if (!chosen || chosen.length === 0) return;
        localPath = path.join(chosen[0].fsPath, path.posix.basename(node.remotePath));
      }

      await withProgress('正在下载…', async () => {
        if (node.kind === 'folder' || node.kind === 'root') {
          // 单个文件下不下来不会中断整体，最后统一汇报
          const result = await sync.downloadInto(node.remotePath, localPath as string);
          reportDownload(logger, result, `已下载到 ${localPath}`);
        } else {
          await sync.downloadRemote(node.remotePath, localPath as string);
          void vscode.window.showInformationMessage(`已下载到 ${localPath}`);
        }
      });
    }),

    register('remoteFile.downloadAll', async () => {
      const profile = config.active;
      const roots = config.roots();
      if (!profile || roots.length === 0) {
        void vscode.window.showWarningMessage('还没有配置好同步目录。');
        return;
      }
      // 这是"用服务器上的覆盖本地"，会动你本地的文件 —— 先说清楚再动手
      const targets = roots.map((r) => `${r.remoteDir}  →  ${r.localDir}`).join('\n');
      const pick = await vscode.window.showWarningMessage(
        `从远程下载整个项目到本地，同名文件会被**覆盖**（本地多余的不会被删）。\n\n${targets}\n\n继续吗？`,
        { modal: true },
        '继续下载',
      );
      if (pick !== '继续下载') return;

      await withProgress('正在从远程下载整个项目…', async () => {
        const result = await sync.downloadAll();
        tree.refresh();
        reportDownload(logger, result, '整个项目已下载到本地');
      });
    }),

    register('remoteFile.deleteRemote', async (arg: unknown) => {
      const node = arg instanceof RemoteNode ? arg : undefined;
      if (!node || !node.remotePath) {
        void vscode.window.showWarningMessage('请在远程文件列表里右键选择要删除的内容。');
        return;
      }
      // 兜底保护：即使将来菜单条件被改坏，也不允许从界面上删掉整个远程根目录
      if (node.kind === 'root') {
        void vscode.window.showWarningMessage('不能直接删除远程根目录。请展开后删除具体的文件或文件夹。');
        return;
      }
      const confirmDelete = vscode.workspace.getConfiguration('remoteFile').get<boolean>('confirmDelete', true);
      if (confirmDelete) {
        const isFolder = node.kind === 'folder';
        const pick = await vscode.window.showWarningMessage(
          isFolder
            ? `确定要删除远程目录及其全部内容吗？\n${node.remotePath}\n\n这个操作不可撤销。`
            : `确定要删除远程文件吗？\n${node.remotePath}`,
          { modal: true },
          '删除',
        );
        if (pick !== '删除') return;
      }
      await withProgress('正在删除…', async () => {
        await sync.deleteRemote(node.remotePath, node.kind === 'folder');
        tree.refresh();
        void vscode.window.setStatusBarMessage('$(check) 已删除远程文件', 3000);
      });
    }),

    register('remoteFile.newRemoteFolder', async (arg: unknown) => {
      const node = arg instanceof RemoteNode ? arg : undefined;
      const parent = node?.remotePath ?? config.active?.remotePath;
      if (!parent) {
        void vscode.window.showWarningMessage('先连接服务器。');
        return;
      }
      const name = await vscode.window.showInputBox({
        prompt: '新文件夹的名字',
        placeHolder: '例如 assets',
        validateInput: (v) => (/[/\\]/.test(v) ? '文件夹名字里不能有斜杠' : v.trim() === '' ? '名字不能为空' : undefined),
      });
      if (!name) return;
      await withProgress('正在创建…', async () => {
        await sync.createRemoteFolder(parent, name.trim());
        tree.refresh();
      });
    }),

    register('remoteFile.openRemoteFile', async (arg: unknown) => {
      const node = arg instanceof RemoteNode ? arg : undefined;
      if (!node || node.kind === 'folder' || node.kind === 'root') return;
      await openRemote(node);
    }),

    register('remoteFile.diffWithLocal', async (arg: unknown) => {
      const node = arg instanceof RemoteNode ? arg : undefined;
      if (!node || node.kind === 'folder' || node.kind === 'root') return;
      await diffRemoteWithLocal(node);
    }),

    register('remoteFile.revealLocal', async (arg: unknown) => {
      const node = arg instanceof RemoteNode ? arg : undefined;
      if (!node || node.kind !== 'file') return;
      const local = sync.remoteToLocal(node.remotePath);
      if (!local) {
        void vscode.window.showWarningMessage(
          `${node.remotePath} 不对应任何本地目录（不在 context / mappings 范围内）。`,
        );
        return;
      }
      if (!fs.existsSync(local)) {
        const pick = await vscode.window.showWarningMessage(`本地还没有这个文件：\n${local}`, '下载到本地');
        if (pick !== '下载到本地') return;
        const written = await withProgress('正在下载…', async () => {
          await sync.downloadRemote(node.remotePath, local);
          return true;
        });
        if (!written) return;
      }
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(local));
      await vscode.window.showTextDocument(doc, { preview: false });
    }),

    register('remoteFile.copyRemotePath', async (arg: unknown) => {
      const node = arg instanceof RemoteNode ? arg : undefined;
      if (!node?.remotePath) return;
      await vscode.env.clipboard.writeText(node.remotePath);
      void vscode.window.setStatusBarMessage(`$(check) 已复制 ${node.remotePath}`, 3000);
    }),

    register('remoteFile.openConfig', async () => {
      await config.openConfig(false);
    }),

    register('remoteFile.initConfig', async () => {
      // 走向导：一步步问出协议/端口/账号/目录，避免手写 JSON 把端口配错
      await wizard.run();
      tree.refresh();
    }),

    register('remoteFile.ignoreFolder', async (uri?: vscode.Uri) => {
      await ignoreRules.ignoreFolder(uri);
    }),

    register('remoteFile.ignoreFile', async (uri?: vscode.Uri) => {
      await ignoreRules.ignoreFile(uri);
    }),

    register('remoteFile.ignoreFileType', async (uri?: vscode.Uri) => {
      await ignoreRules.ignoreFileType(uri);
    }),

    register('remoteFile.removeIgnoreRule', async (uri?: vscode.Uri) => {
      await ignoreRules.remove(uri);
    }),

    register('remoteFile.syncNow', async () => {
      await syncNowManually();
    }),

    register('remoteFile.showOutput', () => {
      logger.show();
    }),

    register('remoteFile.showProtocolLog', () => {
      logger.showTrace();
    }),

    register('remoteFile.selectServer', async () => {
      const profiles = config.all;
      if (profiles.length <= 1) {
        void vscode.window.showInformationMessage('配置里只有一个服务器。');
        return;
      }
      const active = config.active;
      const picked = await vscode.window.showQuickPick(
        profiles.map((p) => ({
          label: p.name === active?.name ? `$(check) ${p.name}` : p.name,
          description: `${p.protocol}://${p.host}:${p.port}`,
          detail: `远程根目录 ${p.remotePath}`,
          profile: p,
        })),
        { placeHolder: '选择要操作的服务器' },
      );
      if (!picked) return;
      await connection.disconnect();
      await config.setActive(picked.profile.name);
      await reloadConfig();
      tree.refresh();
      updateStatus();
    }),

    register('remoteFile.showMenu', async () => {
      const profile = config.active;
      const items: (vscode.QuickPickItem & { run: () => unknown })[] = [
        {
          label: '$(cloud-upload) 上传当前文件',
          detail: '把正在编辑的文件传到远程',
          run: () => vscode.commands.executeCommand('remoteFile.uploadCurrentFile'),
        },
        {
          label: '$(cloud-upload) 上传整个项目',
          detail: '按目录映射把所有文件传上去',
          run: () => vscode.commands.executeCommand('remoteFile.uploadAll'),
        },
        {
          label: '$(refresh) 刷新远程文件列表',
          run: () => vscode.commands.executeCommand('remoteFile.refresh'),
        },
        {
          label: '$(debug-disconnect) 断开连接',
          run: () => vscode.commands.executeCommand('remoteFile.reconnect'),
        },
        {
          label: '$(gear) 打开配置文件',
          detail: config.configPath ?? '还没有配置文件',
          run: () => vscode.commands.executeCommand('remoteFile.openConfig'),
        },
        {
          label: '$(output) 显示运行日志',
          run: () => vscode.commands.executeCommand('remoteFile.showOutput'),
        },
      ];
      if (config.all.length > 1) {
        items.unshift({
          label: '$(server) 切换服务器',
          run: () => vscode.commands.executeCommand('remoteFile.selectServer'),
        });
      }
      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: profile ? `${profile.name}（${profile.protocol}://${profile.host}:${profile.port}）` : '还没有配置服务器',
      });
      if (picked) await picked.run();
    }),
  ];
}

// ─────────────────────────── 辅助 ───────────────────────────

/**
 * 打开一个远程文件。
 *
 * 默认行为（`remoteFile.openMode = "both"`）：**左边远程、右边本地，分栏显示**。
 *   - 远程那份是虚拟文档（只读），标签名带 "(远程) " 前缀，一眼能区分
 *   - 本地那份是真实文件，可以直接编辑保存 —— VSCode 没有给真实文件改标签名的 API，
 *     所以本地那份保持原文件名，靠"在右边那一栏"来体现
 * 本地对应的文件不存在时，只打开远程那一份。
 */
async function openRemote(node: RemoteNode): Promise<void> {
  const profile = node.profile ?? config.active;
  const mode = vscode.workspace.getConfiguration('remoteFile').get<string>('openMode', 'both');
  const local = sync.remoteToLocal(node.remotePath);
  const localExists = !!local && fs.existsSync(local);

  if (mode === 'diff') {
    if (localExists) await diffRemoteWithLocal(node);
    else await openRemoteOnly(node, profile);
    return;
  }

  await openRemoteOnly(node, profile);

  if (mode === 'both' && local && localExists) {
    const localDoc = await vscode.workspace.openTextDocument(vscode.Uri.file(local));
    await vscode.window.showTextDocument(localDoc, {
      viewColumn: vscode.ViewColumn.Beside,
      preview: true,
      preserveFocus: false,
    });
  }
}

async function openRemoteOnly(node: RemoteNode, profile: ServerConfig | undefined): Promise<void> {
  const uri = RemoteContentProvider.uriFor(node.remotePath, profile?.name);
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Active, preview: true });
}

/** 用 VSCode 的差异视图对比远程和本地。 */
async function diffRemoteWithLocal(node: RemoteNode): Promise<void> {
  const local = sync.remoteToLocal(node.remotePath);
  if (!local || !fs.existsSync(local)) {
    void vscode.window.showWarningMessage(`本地还没有这个文件，先下载一份再对比：\n${local ?? node.remotePath}`);
    return;
  }
  const profile = node.profile ?? config.active;
  const remoteUri = RemoteContentProvider.uriFor(node.remotePath, profile?.name);
  const name = posixBasename(node.remotePath);
  await vscode.commands.executeCommand('vscode.diff', remoteUri, vscode.Uri.file(local), `(远程 ↔ 本地) ${name}`);
}

/** 侧边栏可见时提前建立连接，把握手时间移出"第一次展开目录"的关键路径。 */
async function warmUpConnection(): Promise<void> {
  const profile = config.active;
  if (!profile || connection.isConnected(profile)) return;
  try {
    await connection.get(profile);
  } catch (err) {
    // 预连接失败不打扰用户：真正的操作会按需重连并给出完整错误
    logger.warn(`预连接失败（后续操作会按需重试）：${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * 如果打开的是配置文件，就把它切到"带注释"的语言模式。
 * `.json` 默认按严格 JSON 解析，`//` 注释会被标红；切成 JSONC 波浪线就没了。
 * YAML 文件本来就没有这个问题，切一下只是保证语法高亮正确。
 */
async function maybeFixConfigLanguage(doc: vscode.TextDocument): Promise<void> {
  if (doc.uri.scheme !== 'file') return;
  try {
    if (!config.isConfigFile(doc.uri.fsPath)) return;
    await config.fixLanguageMode(doc);
  } catch {
    /* 纯粹是显示层面的优化，失败不影响任何功能 */
  }
}

/**
 * 启动时的增量补同步。
 *
 * 场景：VSCode 没开的时候，文件被别的工具（或 agent）改过、新增过、删过。
 * 打开项目时把差异补上去。
 *
 * 行为由 `remoteFile.syncOnStartup` 控制：off（默认）/ ask（有变化时问一下）/ auto（直接同步）。
 */
async function runStartupSync(): Promise<void> {
  const mode = vscode.workspace.getConfiguration('remoteFile').get<string>('syncOnStartup', 'off');
  if (mode !== 'ask' && mode !== 'auto') return;
  if (!config.active) return;

  // 让窗口先起来，别和启动抢资源
  await new Promise((resolve) => setTimeout(resolve, 2500));
  if (!config.active) return;

  logger.info('启动同步：开始比对本地内容与同步账本…');
  let scan;
  try {
    scan = await sync.scanForChanges();
  } catch (err) {
    logger.error('启动同步：扫描失败', err);
    return;
  }

  // 第一次同步（账本里还没有这台服务器的基线）：
  // 先登记"远程已经有"的，**但"远程上还没有"的要真传上去** ——
  // 否则 VSCode 关着时新建的文件会被当成"已经同步过"吞掉。
  // （"第一次"是按连接标识算的，所以改过端口/账号也会重新触发。）
  if (scan.baselineOnly) {
    sync.rememberBaseline(scan);
    if (scan.toUpload.length === 0) {
      logger.info(
        `启动同步：首次同步 —— 远程已有的 ${scan.toBaseline.length} 个文件已登记为基线，没有需要上传的（账本现有 ${sync.ledgerCount()} 条）。`,
      );
      return;
    }
    logger.info(
      `启动同步：首次同步 —— 远程已有的 ${scan.toBaseline.length} 个文件登记为基线；` +
        `远程上还没有 ${scan.toUpload.length} 个文件，需要传上去。`,
    );
  } else if (scan.toUpload.length === 0 && scan.toDelete.length === 0) {
    logger.info(`启动同步：没有变化（比对 ${scan.unchanged} 个文件，账本现有 ${sync.ledgerCount()} 条）。`);
    return;
  } else {
    logger.info(
      `启动同步：发现 ${scan.toUpload.length} 个待上传、${scan.toDelete.length} 个待删除（未变化 ${scan.unchanged} 个，账本现有 ${sync.ledgerCount()} 条）。`,
    );
  }

  if (mode === 'ask' && !(await confirmIncrementalSync(scan))) return;
  await executeIncrementalSync(scan);
}

/** 有改动要同步时问一句。删除会额外标出来，因为它不可撤销。 */
async function confirmIncrementalSync(scan: IncrementalScan): Promise<boolean> {
  const parts: string[] = [];
  if (scan.toUpload.length > 0) {
    parts.push(
      scan.baselineOnly
        ? `${scan.toUpload.length} 个文件远程上还没有`
        : `${scan.toUpload.length} 个文件有改动或新增`,
    );
  }
  if (scan.toDelete.length > 0) parts.push(`${scan.toDelete.length} 个文件本地已删除`);

  const detail =
    scan.toDelete.length > 0
      ? `\n\n其中删除本地的 ${scan.toDelete.length} 个文件会**同时删掉远程对应文件**（不可撤销）。`
      : '';
  const pick = await vscode.window.showWarningMessage(
    `Remote File：检测到 ${parts.join('、')}。要同步到远程吗？${detail}`,
    { modal: false },
    '同步',
    '取消',
  );
  return pick === '同步';
}

/** 执行扫描结果，并把结果汇报给用户。 */
async function executeIncrementalSync(scan: IncrementalScan): Promise<void> {
  const result = await withProgress('正在与远程同步…', () => sync.applyScan(scan));
  if (!result) return;

  tree.refresh();

  const summary = `同步完成：上传 ${result.uploaded} 个，删除 ${result.deleted} 个${result.skipped ? `，跳过 ${result.skipped} 个` : ''}`;
  if (result.failed.length === 0) {
    logger.info(summary);
    void vscode.window.showInformationMessage(`Remote File：${summary}`);
    return;
  }
  logger.error(`${summary}，但有 ${result.failed.length} 个失败`);
  for (const f of result.failed) logger.error(`  ${f.target}：${f.error}`);
  void vscode.window
    .showErrorMessage(`Remote File：${summary}，${result.failed.length} 个失败`, '查看日志', '查看协议细节')
    .then((pick) => {
      if (pick === '查看日志') logger.show(false);
      if (pick === '查看协议细节') logger.showTrace(false);
    });
}

/** 手动触发一次增量同步。 */
async function syncNowManually(): Promise<void> {
  if (!config.active) {
    void vscode.window.showWarningMessage('还没有配置服务器。');
    return;
  }
  await withProgress('正在比对本地与远程…', async () => {
    logger.info('手动同步：开始比对本地内容与同步账本…');
    const scan = await sync.scanForChanges();
    if (scan.baselineOnly) {
      sync.rememberBaseline(scan);
      if (scan.toUpload.length === 0) {
        logger.info(
          `手动同步：首次同步 —— 远程已有的 ${scan.toBaseline.length} 个文件已登记为基线，没有需要上传的（账本现有 ${sync.ledgerCount()} 条）。`,
        );
        void vscode.window.showInformationMessage(
          `Remote File：首次同步完成。远程已有的 ${scan.toBaseline.length} 个文件已登记为基线，之后只同步真正变化的文件。`,
        );
        return;
      }
      // 首次同步时"远程上还没有"的文件要真传上去（否则新建的文件会被吞掉）。
      // 但用户也可能是**想把远程拉下来**而不是把本地推上去，所以这里必须问一句。
      logger.info(
        `手动同步：首次同步 —— 远程已有的 ${scan.toBaseline.length} 个文件登记为基线；远程上还没有 ${scan.toUpload.length} 个文件。`,
      );
      const pick = await vscode.window.showWarningMessage(
        `Remote File：首次同步，远程上还没有 ${scan.toUpload.length} 个文件。要把它们传上去吗？\n\n` +
          `· 「上传」= 把本地这些文件推到服务器\n` +
          `· 「只建基线」= 一个都不传，只登记远程已有的（**想从远程拉代码时选这个**，然后用「从远程下载整个项目」）`,
        { modal: true },
        '上传',
        '只建基线',
      );
      if (pick !== '上传') {
        logger.info('手动同步：按用户选择只建立基线，本次没有上传任何文件。');
        void vscode.window.showInformationMessage(
          `Remote File：已只建立基线（远程已有的 ${scan.toBaseline.length} 个文件）。没有上传任何文件。`,
        );
        return;
      }
      await executeIncrementalSync(scan);
      return;
    }
    if (scan.toUpload.length === 0 && scan.toDelete.length === 0) {
      logger.info(`手动同步：没有变化（比对 ${scan.unchanged} 个文件，账本现有 ${sync.ledgerCount()} 条）。`);
      void vscode.window.showInformationMessage(
        `Remote File：本地和远程一致，没有需要同步的内容（比对 ${scan.unchanged} 个文件）。`,
      );
      return;
    }
    logger.info(
      `手动同步：发现 ${scan.toUpload.length} 个待上传、${scan.toDelete.length} 个待删除（未变化 ${scan.unchanged} 个）。`,
    );
    // 手动触发也要为"删除"单独确认一次 —— 它不可撤销
    if (scan.toDelete.length > 0) {
      const pick = await vscode.window.showWarningMessage(
        `Remote File：有 ${scan.toDelete.length} 个文件本地已删除，会同时删掉远程对应文件（不可撤销）。${scan.toUpload.length > 0 ? `另外还有 ${scan.toUpload.length} 个文件待上传。` : ''}\n\n继续吗？`,
        { modal: true },
        '继续',
      );
      if (pick !== '继续') return;
    }
    await executeIncrementalSync(scan);
  });
}

async function reloadConfig(): Promise<void> {
  const had = config.configPath;
  const ok = await config.refresh();
  if (config.error) {
    void vscode.window.showErrorMessage(`Remote File：${config.error}`);
  } else if (!ok && had) {
    logger.warn('配置文件不见了，插件已停用。');
  }
  updateStatus();
}

/** 配置文件（无论叫什么名字）变更时刷新。 */
function watchConfigFile(context: vscode.ExtensionContext): void {
  const rel = config.configRelativePath();
  const watcher = vscode.workspace.createFileSystemWatcher(`**/${rel}`);
  const onChange = async () => {
    logger.info('检测到配置文件变化，重新加载。');
    await connection.disconnect();
    await reloadConfig();
    tree.refresh();
  };
  context.subscriptions.push(
    watcher,
    watcher.onDidChange(() => void onChange()),
    watcher.onDidCreate(() => void onChange()),
    watcher.onDidDelete(() => void onChange()),
  );
}

/** 从命令参数里解析出本地路径：可能是资源管理器里的 Uri，也可能是树上的远程节点。 */
async function resolveLocalPathFromArg(arg: unknown): Promise<string | undefined> {
  if (arg instanceof vscode.Uri && arg.scheme === 'file') return arg.fsPath;
  if (arg instanceof RemoteNode) {
    if (arg.kind === 'root' || arg.kind === 'folder') {
      const local = sync.remoteToLocal(arg.remotePath);
      if (local) return local;
      void vscode.window.showWarningMessage(`${arg.remotePath} 没有对应的本地目录（不在目录映射里）。`);
      return undefined;
    }
    const local = sync.remoteToLocal(arg.remotePath);
    if (local) return local;
    return undefined;
  }
  // 命令面板直接调用时，用当前编辑器或让用户选
  const editor = vscode.window.activeTextEditor;
  if (editor && editor.document.uri.scheme === 'file') return editor.document.uri.fsPath;
  const picked = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: true, canSelectMany: false, openLabel: '上传' });
  return picked?.[0]?.fsPath;
}



export function reportUpload(logger: Logger, result: { uploaded: number; skipped: number; failed: { localPath: string; error: string }[] }): void {
  const skipped = result.skipped > 0 ? `，跳过 ${result.skipped} 个` : '';
  if (result.failed.length === 0) {
    logger.info(`上传完成：成功 ${result.uploaded} 个${skipped}`);
    void vscode.window.showInformationMessage(`上传完成：${result.uploaded} 个文件（跳过 ${result.skipped} 个）`);
    return;
  }
  // 日志里也要有成功数 —— 用户翻日志时想一眼看到"成功多少、失败多少"，而不是只有失败清单
  logger.error(`上传完成：成功 ${result.uploaded} 个，失败 ${result.failed.length} 个${skipped}`);
  logger.error('以下是没能上传的文件（其余都已上传成功）：');
  for (const f of result.failed) logger.error(`  ${f.localPath}：${f.error}`);
  void vscode.window
    .showErrorMessage(
      `上传完成：成功 ${result.uploaded} 个，失败 ${result.failed.length} 个${skipped}。其余文件都已上传。`,
      '查看日志',
      '查看协议细节',
    )
    .then((pick) => {
      if (pick === '查看日志') logger.show(false);
      if (pick === '查看协议细节') logger.showTrace(false);
    });
}

/**
 * 汇报一次批量下载的结果。
 *
 * 关键点：**失败不等于整体失败**。服务器上总有下不下来的东西（比如宝塔生成的 `.user.ini`，
 * `RETR` 直接回 550）。所以这里报的是"成功多少、失败多少"，并把失败的文件逐个列到日志里，
 * 而不是弹一个"下载失败"让人以为全没下成。
 */
export function reportDownload(logger: Logger, result: DownloadOutcome, okMessage: string): void {
  const skipped = result.skipped > 0 ? `，跳过 ${result.skipped} 个（命中忽略规则）` : '';
  if (result.failed.length === 0) {
    logger.info(`${okMessage}：成功 ${result.downloaded} 个${skipped}`);
    void vscode.window.showInformationMessage(`下载完成：成功 ${result.downloaded} 个${skipped}`);
    return;
  }

  logger.warn(`下载完成：成功 ${result.downloaded} 个，失败 ${result.failed.length} 个${skipped}`);
  logger.warn('以下是没能下载的文件（其余都已下载成功）：');
  for (const f of result.failed) logger.warn(`  ${f.remotePath} —— ${f.error}`);

  void vscode.window
    .showWarningMessage(
      `下载完成：成功 ${result.downloaded} 个，失败 ${result.failed.length} 个${skipped}。其余文件都已下载。`,
      '查看失败清单',
      '查看协议细节',
    )
    .then((pick) => {
      if (pick === '查看失败清单') logger.show(false);
      if (pick === '查看协议细节') logger.showTrace(false);
    });
}

async function withProgress<T>(title: string, task: () => Promise<T>): Promise<T | undefined> {
  try {
    return await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: false }, task);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`${title} 失败`, err);
    void vscode.window.showErrorMessage(`Remote File：${message}`);
    return undefined;
  }
}
