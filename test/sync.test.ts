/**
 * 端到端集成测试：把「本地文件」到「远程服务器」的完整链路跑一遍。
 *
 * 参与的都是真家伙：
 *   - 真实的 SSH/SFTP 服务器（本机 ssh2 起的）
 *   - 真实的配置文件解析（ConfigStore 读 .vscode/sftp.json）
 *   - 真实的路径映射、忽略规则、上传/下载/删除逻辑（SyncService）
 *   - 真实的文件监听触发路径（FileSyncWatcher）
 *   - 真实的侧边栏数据提供者（RemoteTreeProvider）
 *
 * 只有 VSCode 本身是替身（test/helpers/vscodeStub.ts，通过 esbuild --alias 注入）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as vscode from 'vscode';
import * as vscodeShim from './helpers/vscodeStub';
import { __vscodeTest, createExtensionContext } from './helpers/vscodeStub';
import { startSftpServer, type TestSftpServer } from './helpers/sftpServer';
import { ConfigStore } from '../src/vscode/configStore';
import { ConnectionManager } from '../src/vscode/connection';
import { Logger } from '../src/vscode/logger';
import { RemoteNode, RemoteTreeProvider } from '../src/vscode/remoteTree';
import { SyncService } from '../src/vscode/sync';
import { FileSyncWatcher } from '../src/vscode/watchers';

const REPO_ROOT = path.resolve(__dirname, '..');
const TMP_ROOT = path.join(REPO_ROOT, '.tmp-tests');

function makeTempDir(label: string): string {
  const dir = path.join(TMP_ROOT, `${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeFile(file: string, content: string | Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/**
 * FileSyncWatcher 的事件处理是 fire-and-forget 的（在 VSCode 里事件回调本来也不该
 * 阻塞宿主），所以测试里不能触发完就立刻断言，要等副作用落地。
 */
async function waitFor(predicate: () => boolean, label: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`等待超时：${label}`);
}

async function waitForAsync(predicate: () => Promise<boolean>, label: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`等待超时：${label}`);
}

/** 给"什么都不该发生"的断言留出足够的时间窗。 */
const settle = (ms = 600) => new Promise((r) => setTimeout(r, ms));

/** 超过文件监听的去抖窗口（900ms），让内容比对那一层真正被走到。 */
const pastDebounce = () => new Promise((r) => setTimeout(r, 1000));

interface Rig {
  projectDir: string;
  remoteRoot: string;
  server: TestSftpServer;
  config: ConfigStore;
  connection: ConnectionManager;
  sync: SyncService;
  tree: RemoteTreeProvider;
  watcher: FileSyncWatcher;
  dispose: () => Promise<void>;
}

async function setupRig(profile: Record<string, unknown>): Promise<Rig> {
  const projectDir = makeTempDir('sync-project');
  const remoteRoot = makeTempDir('sync-remote');
  const server = await startSftpServer({ root: remoteRoot });

  fs.mkdirSync(path.join(projectDir, '.vscode'), { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, '.vscode', 'sftp.json'),
    JSON.stringify(
      {
        protocol: 'sftp',
        host: '127.0.0.1',
        port: server.port,
        username: 'tester',
        password: 'secret',
        ...profile,
      },
      null,
      2,
    ),
    'utf8',
  );

  __vscodeTest.reset();
  __vscodeTest.setWorkspaceFolder(projectDir);

  const logger = new Logger();
  const context = createExtensionContext();
  const config = new ConfigStore(context as unknown as vscode.ExtensionContext, logger);
  const connection = new ConnectionManager(logger);
  const sync = new SyncService(config, connection, logger);
  const tree = new RemoteTreeProvider(config, connection, sync, logger);
  const watcher = new FileSyncWatcher(config, sync, tree, logger);

  const loaded = await config.refresh();
  assert.ok(loaded, '配置文件应该能被读到');

  return {
    projectDir,
    remoteRoot,
    server,
    config,
    connection,
    sync,
    tree,
    watcher,
    dispose: async () => {
      watcher.dispose();
      tree.dispose();
      config.dispose();
      connection.dispose();
      await server.close();
      fs.rmSync(projectDir, { recursive: true, force: true });
      fs.rmSync(remoteRoot, { recursive: true, force: true });
    },
  };
}

test('端到端：目录映射 + 忽略规则 + 上传整个目录，真的写到远程服务器上', async () => {
  const rig = await setupRig({
    remotePath: '/site',
    context: 'dist',
    mappings: [{ local: 'assets', remote: '/static' }],
    ignore: ['**/*.map', 'secret.txt'],
  });

  try {
    const { projectDir, remoteRoot, sync } = rig;

    // 本地文件：dist → /site，assets → /static
    writeFile(path.join(projectDir, 'dist', 'index.html'), '<h1>首页</h1>');
    writeFile(path.join(projectDir, 'dist', 'css', 'app.css'), 'body{color:red}');
    writeFile(path.join(projectDir, 'dist', 'app.js.map'), '{"version":3}'); // 命中 **/*.map
    writeFile(path.join(projectDir, 'dist', 'secret.txt'), '不要传我'); // 命中 secret.txt
    writeFile(path.join(projectDir, 'assets', 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const distResult = await sync.uploadPath(path.join(projectDir, 'dist'));
    assert.equal(distResult.failed.length, 0, `不该有失败：${JSON.stringify(distResult.failed)}`);
    assert.equal(distResult.uploaded, 2, 'index.html 和 css/app.css 应该被上传');

    const assetsResult = await sync.uploadPath(path.join(projectDir, 'assets'));
    assert.equal(assetsResult.uploaded, 1);

    // 断言真的落到了远程磁盘上
    assert.equal(fs.readFileSync(path.join(remoteRoot, 'site', 'index.html'), 'utf8'), '<h1>首页</h1>');
    assert.equal(fs.readFileSync(path.join(remoteRoot, 'site', 'css', 'app.css'), 'utf8'), 'body{color:red}');
    assert.deepEqual(fs.readFileSync(path.join(remoteRoot, 'static', 'logo.png')), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    // 被忽略的不能被传上去
    assert.equal(fs.existsSync(path.join(remoteRoot, 'site', 'app.js.map')), false, '**/*.map 应该被忽略');
    assert.equal(fs.existsSync(path.join(remoteRoot, 'site', 'secret.txt')), false, 'secret.txt 应该被忽略');
    // 映射之外的目录不能跑到 /site 下面
    assert.equal(fs.existsSync(path.join(remoteRoot, 'site', 'assets')), false);
  } finally {
    await rig.dispose();
  }
});

test('端到端：保存自动上传、新建自动上传、删除同步（含开关关闭时不删）', async () => {
  const rig = await setupRig({
    remotePath: '/site',
    context: '.',
    uploadOnSave: true,
    uploadOnCreate: true,
    deleteOnLocalDelete: true,
    ignore: ['.vscode'],
  });

  try {
    const { projectDir, remoteRoot, sync, watcher } = rig;
    watcher.start();

    // ── 保存触发上传
    const saved = path.join(projectDir, 'src', 'main.js');
    const remoteSaved = path.join(remoteRoot, 'site', 'src', 'main.js');
    writeFile(saved, 'console.log("保存触发");');
    await __vscodeTest.fireSave(saved);
    await waitFor(() => fs.existsSync(remoteSaved), '保存后应该自动上传');
    assert.equal(fs.readFileSync(remoteSaved, 'utf8'), 'console.log("保存触发");');

    // ── 新建触发上传
    const created = path.join(projectDir, 'src', 'new.txt');
    const remoteCreated = path.join(remoteRoot, 'site', 'src', 'new.txt');
    writeFile(created, '新建的文件');
    await __vscodeTest.fireCreate(created);
    await waitFor(() => fs.existsSync(remoteCreated), '新建文件后应该自动上传');
    assert.equal(fs.readFileSync(remoteCreated, 'utf8'), '新建的文件');

    // ── 重命名同步
    const renamed = path.join(projectDir, 'src', 'renamed.txt');
    const remoteRenamed = path.join(remoteRoot, 'site', 'src', 'renamed.txt');
    fs.renameSync(created, renamed);
    await __vscodeTest.fireRename(created, renamed);
    await waitFor(() => fs.existsSync(remoteRenamed) && !fs.existsSync(remoteCreated), '远程应该跟着重命名');
    assert.equal(fs.readFileSync(remoteRenamed, 'utf8'), '新建的文件');

    // ── 删除同步（开关打开）
    fs.rmSync(saved);
    await __vscodeTest.fireDelete(saved);
    await waitFor(() => !fs.existsSync(remoteSaved), '本地删了远程也要删');

    // ── 配置文件自己永远不上传
    assert.equal(fs.existsSync(path.join(remoteRoot, 'site', '.vscode', 'sftp.json')), false);

    // ── 关掉开关后不删远程
    const keep = path.join(projectDir, 'keep.txt');
    const remoteKeep = path.join(remoteRoot, 'site', 'keep.txt');
    writeFile(keep, 'x');
    await sync.uploadFile(keep);
    assert.ok(fs.existsSync(remoteKeep));

    const raw = JSON.parse(fs.readFileSync(path.join(projectDir, '.vscode', 'sftp.json'), 'utf8'));
    raw.deleteOnLocalDelete = false;
    fs.writeFileSync(path.join(projectDir, '.vscode', 'sftp.json'), JSON.stringify(raw), 'utf8');
    await rig.config.refresh();
    assert.equal(rig.config.active?.deleteOnLocalDelete, false);

    fs.rmSync(keep);
    await __vscodeTest.fireDelete(keep);
    await settle();
    assert.ok(fs.existsSync(remoteKeep), '开关关闭时不应该删远程文件');
  } finally {
    await rig.dispose();
  }
});

test('端到端：侧边栏远程文件树能列出真实目录，并能打开远程文件内容', async () => {
  const rig = await setupRig({ remotePath: '/site', context: '.' });

  try {
    const { projectDir, remoteRoot, tree, sync } = rig;
    writeFile(path.join(projectDir, 'index.html'), '<p>hello</p>');
    writeFile(path.join(projectDir, 'css', 'a.css'), 'body{}');
    await sync.uploadFile(path.join(projectDir, 'index.html'));
    await sync.uploadFile(path.join(projectDir, 'css', 'a.css'));
    assert.ok(fs.existsSync(path.join(remoteRoot, 'site', 'css', 'a.css')));

    // 顶层：一个同步根
    const roots = await tree.getChildren();
    assert.equal(roots.length, 1);
    assert.equal(roots[0].remotePath, '/site');
    assert.equal(roots[0].contextValue, 'remoteFile.root');
    assert.equal(roots[0].kind, 'root');

    // 展开根目录
    const top = await tree.getChildren(roots[0]);
    const names = top.map((n) => n.label).sort();
    assert.deepEqual(names, ['css', 'index.html']);

    const cssNode = top.find((n) => n.label === 'css') as RemoteNode;
    assert.equal(cssNode.kind, 'folder');
    assert.equal(cssNode.contextValue, 'remoteFile.folder');

    const cssChildren = await tree.getChildren(cssNode);
    assert.deepEqual(
      cssChildren.map((n) => n.label),
      ['a.css'],
    );
    assert.equal(cssChildren[0].contextValue, 'remoteFile.file');

    // 点文件时面板里能看到内容
    const content = await sync.readRemote('/site/index.html');
    assert.equal(content.toString('utf8'), '<p>hello</p>');

    // 「在本地打开对应文件」依赖的反向映射：远程路径要能找回本地那一份
    const counterpart = sync.remoteToLocal('/site/index.html');
    assert.equal(counterpart, path.join(projectDir, 'index.html'));
    assert.ok(counterpart && fs.existsSync(counterpart), '反向映射应该指向真实存在的本地文件');
    // 映射范围外的远程路径返回 undefined（命令据此提示用户，而不是静默失败）
    assert.equal(sync.remoteToLocal('/elsewhere/x.txt'), undefined);

    // 根节点不允许被当成普通文件夹删除（防止右键误删整个远程根目录）
    assert.equal(roots[0].contextValue, 'remoteFile.root');
    assert.notEqual(roots[0].contextValue, 'remoteFile.folder');
  } finally {
    await rig.dispose();
  }
});

test('端到端：下载远程目录到本地（含子目录）', async () => {
  const rig = await setupRig({ remotePath: '/site', context: 'public' });

  try {
    const { projectDir, remoteRoot, sync } = rig;
    writeFile(path.join(remoteRoot, 'site', 'a.txt'), 'A');
    writeFile(path.join(remoteRoot, 'site', 'sub', 'b.txt'), 'B');
    writeFile(path.join(remoteRoot, 'site', 'sub', 'deep', 'c.txt'), 'C');

    const local = sync.remoteToLocal('/site');
    assert.equal(local, path.join(projectDir, 'public'));

    // 递归下载
    const download = async (remote: string, localDir: string): Promise<number> => {
      const entries = await sync.listRemote(remote);
      fs.mkdirSync(localDir, { recursive: true });
      let count = 0;
      for (const e of entries) {
        if (e.type === 'folder') count += await download(e.path, path.join(localDir, e.name));
        else {
          await sync.downloadRemote(e.path, path.join(localDir, e.name));
          count++;
        }
      }
      return count;
    };

    const count = await download('/site', local as string);
    assert.equal(count, 3);
    assert.equal(fs.readFileSync(path.join(projectDir, 'public', 'a.txt'), 'utf8'), 'A');
    assert.equal(fs.readFileSync(path.join(projectDir, 'public', 'sub', 'deep', 'c.txt'), 'utf8'), 'C');
  } finally {
    await rig.dispose();
  }
});

test('端到端：保存自动上传后，侧边栏只重列受影响的那一个远程目录（定向刷新）', async () => {
  const rig = await setupRig({
    remotePath: '/site',
    context: '.',
    uploadOnSave: true,
    ignore: ['.vscode'],
  });

  try {
    const { projectDir, remoteRoot, tree, sync, watcher } = rig;

    // 记录所有"向服务器要目录列表"的调用，用来证明刷新是定向的而不是整树重拉
    const listCalls: string[] = [];
    const originalList = sync.listRemote.bind(sync);
    (sync as unknown as { listRemote: (p: string) => Promise<unknown> }).listRemote = async (p: string) => {
      listCalls.push(p);
      return originalList(p);
    };

    watcher.start();

    // 先造一个子目录，并把 /site 和 /site/css 都在树里展开一次，让缓存填上
    writeFile(path.join(projectDir, 'css', 'a.css'), 'body{}');
    await sync.uploadFile(path.join(projectDir, 'css', 'a.css'));

    const roots = await tree.getChildren();
    const rootNode = roots[0];
    assert.equal(rootNode.remotePath, '/site');
    const top = await tree.getChildren(rootNode);
    assert.deepEqual(
      top.map((n) => n.label),
      ['css'],
    );
    const cssNode = top.find((n) => n.label === 'css') as RemoteNode;
    const cssChildren = await tree.getChildren(cssNode);
    assert.deepEqual(
      cssChildren.map((n) => n.label),
      ['a.css'],
    );

    // 现在保存一个新文件，它会落到 /site
    listCalls.length = 0;
    const file = path.join(projectDir, 'index.html');
    writeFile(file, '<p>自动刷新</p>');
    await __vscodeTest.fireSave(file);
    await waitFor(() => fs.existsSync(path.join(remoteRoot, 'site', 'index.html')), '上传应该完成');

    // 如果没做定向刷新，下面这句会一直命中旧缓存（只有 css）然后超时
    await waitForAsync(
      async () => (await tree.getChildren(rootNode)).some((n) => n.label === 'index.html'),
      '保存自动上传后，远程树里那个目录应该自动更新',
    );

    // 定向刷新的证据：重列了 /site，但没有重列不受影响的 /site/css
    assert.ok(listCalls.includes('/site'), `应该重新列出 /site，实际：${JSON.stringify(listCalls)}`);
    assert.ok(!listCalls.includes('/site/css'), `不该重列不受影响的 /site/css，实际：${JSON.stringify(listCalls)}`);

    // css 子目录仍然能正常读到（走缓存）
    assert.deepEqual(
      (await tree.getChildren(cssNode)).map((n) => n.label),
      ['a.css'],
    );
  } finally {
    await rig.dispose();
  }
});

test('端到端：一次性保存多个文件（Ctrl+K S「全部保存」）会全部上传', async () => {
  const rig = await setupRig({
    remotePath: '/site',
    context: '.',
    uploadOnSave: true,
    ignore: ['.vscode'],
  });

  try {
    const { projectDir, remoteRoot, watcher } = rig;
    watcher.start();

    // VSCode 的 onDidSaveTextDocument 是"每个文档各触发一次"，
    // 「全部保存」会连发多个事件 —— 这里原样模拟。
    const files = ['a.js', 'b.js', 'c.js', 'css/main.css', 'css/theme.css', 'js/deep/nested/mod.js'];
    for (const rel of files) writeFile(path.join(projectDir, rel), `// ${rel}`);

    await Promise.all(files.map((rel) => __vscodeTest.fireSave(path.join(projectDir, rel))));

    // 注意：不能只等"文件存在"。远程文件在 OPEN 那一刻就存在了，内容可能还没写完；
    // 所以这里等到内容真的正确为止。
    await waitFor(
      () =>
        files.every((rel) => {
          try {
            return fs.readFileSync(path.join(remoteRoot, 'site', rel), 'utf8') === `// ${rel}`;
          } catch {
            return false;
          }
        }),
      `这些文件都应该完整上传：${files.join(', ')}`,
    );
  } finally {
    await rig.dispose();
  }
});

test('端到端：同一个文件在 900ms 内被重复触发，只上传一次（去抖）', async () => {
  const rig = await setupRig({
    remotePath: '/site',
    context: '.',
    uploadOnSave: true,
    uploadOnCreate: true,
    ignore: ['.vscode'],
  });

  try {
    const { projectDir, remoteRoot, sync, watcher } = rig;

    // 数一数真正发生了多少次上传
    let uploads = 0;
    const originalUpload = sync.uploadFile.bind(sync);
    (sync as unknown as { uploadFile: (p: string) => Promise<unknown> }).uploadFile = async (p: string) => {
      uploads++;
      return originalUpload(p);
    };

    watcher.start();

    const file = path.join(projectDir, 'dup.js');
    writeFile(file, 'same file');

    // 保存事件 + 新建事件几乎同时到达（新文件第一次保存时真实会发生）
    await __vscodeTest.fireSave(file);
    await __vscodeTest.fireCreate(file);
    await waitFor(() => fs.existsSync(path.join(remoteRoot, 'site', 'dup.js')), '文件应该上传');
    await settle();

    assert.equal(uploads, 1, '同一文件短时间内的重复触发只应该上传一次');
  } finally {
    await rig.dispose();
  }
});

test('端到端：SFTP 默认并发上传（不等串行），内容仍然正确', async () => {
  const rig = await setupRig({
    remotePath: '/site',
    context: '.',
    uploadOnSave: true,
    ignore: ['.vscode'],
  });

  try {
    const { projectDir, remoteRoot, watcher } = rig;
    watcher.start();

    assert.equal(rig.config.active?.concurrency, 4, 'SFTP 默认并发数应该是 4');

    let inFlight = 0;
    let maxInFlight = 0;
    const originalRun = rig.connection.run.bind(rig.connection);
    (rig.connection as unknown as { run: unknown }).run = ((profile: unknown, op: (c: unknown) => Promise<unknown>) =>
      originalRun(profile as never, async (client) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try {
          return await op(client);
        } finally {
          inFlight--;
        }
      })) as never;

    // 故意放两个文件在同一个新目录里：并发 ensureDir 会有 mkdir 竞争，必须被正确处理
    const files = ['1.txt', '2.txt', '3.txt', 'same/a.txt', 'same/b.txt', 'same/c.txt'];
    for (const rel of files) writeFile(path.join(projectDir, rel), rel);
    await Promise.all(files.map((rel) => __vscodeTest.fireSave(path.join(projectDir, rel))));

    await waitFor(
      () =>
        files.every((rel) => {
          try {
            return fs.readFileSync(path.join(remoteRoot, 'site', rel), 'utf8') === rel;
          } catch {
            return false;
          }
        }),
      `并发上传后内容都必须正确：${files.join(', ')}`,
    );

    assert.ok(maxInFlight > 1, `SFTP 应该真的并发起来，实际峰值：${maxInFlight}`);
    assert.ok(maxInFlight <= 4, `并发数不应该超过配置的 4，实际峰值：${maxInFlight}`);
  } finally {
    await rig.dispose();
  }
});

test('端到端：把并发数设成 1 就恢复严格串行', async () => {
  const rig = await setupRig({
    remotePath: '/site',
    context: '.',
    uploadOnSave: true,
    concurrency: 1,
    ignore: ['.vscode'],
  });

  try {
    const { projectDir, remoteRoot, watcher } = rig;
    watcher.start();

    assert.equal(rig.config.active?.concurrency, 1);

    let inFlight = 0;
    let maxInFlight = 0;
    const originalRun = rig.connection.run.bind(rig.connection);
    (rig.connection as unknown as { run: unknown }).run = ((profile: unknown, op: (c: unknown) => Promise<unknown>) =>
      originalRun(profile as never, async (client) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try {
          return await op(client);
        } finally {
          inFlight--;
        }
      })) as never;

    const files = ['1.txt', '2.txt', '3.txt', '4.txt'];
    for (const rel of files) writeFile(path.join(projectDir, rel), rel);
    await Promise.all(files.map((rel) => __vscodeTest.fireSave(path.join(projectDir, rel))));

    await waitFor(
      () => files.every((rel) => fs.existsSync(path.join(remoteRoot, 'site', rel))),
      '四个文件都应该上传',
    );

    assert.equal(maxInFlight, 1, `并发数设为 1 时应该严格串行，实际峰值：${maxInFlight}`);
  } finally {
    await rig.dispose();
  }
});

test('端到端：远程文件列表的默认展开层数可配置', async () => {
  const rig = await setupRig({ remotePath: '/site', context: '.' });

  try {
    const { projectDir, remoteRoot, tree, sync, config } = rig;
    writeFile(path.join(projectDir, 'index.html'), 'x');
    writeFile(path.join(projectDir, 'css', 'a.css'), 'x');
    await sync.uploadFile(path.join(projectDir, 'index.html'));
    await sync.uploadFile(path.join(projectDir, 'css', 'a.css'));
    assert.ok(fs.existsSync(path.join(remoteRoot, 'site', 'css', 'a.css')));

    const Collapsed = vscodeShim.TreeItemCollapsibleState.Collapsed;
    const Expanded = vscodeShim.TreeItemCollapsibleState.Expanded;

    // 默认 1：同步根自动展开，第一层目录仍然是折叠的
    assert.equal(new Set([config.active?.name]).size, 1);
    const roots = await tree.getChildren();
    assert.equal(roots[0].depth, 0);
    assert.equal(roots[0].collapsibleState, Expanded, '默认应该自动展开同步根');

    const level1 = await tree.getChildren(roots[0]);
    const css = level1.find((n) => n.label === 'css') as RemoteNode;
    assert.equal(css.depth, 1);
    assert.equal(css.collapsibleState, Collapsed, '默认不应该自动展开第一层目录');

    // 设成 2：第一层目录也自动展开
    __vscodeTest.setSetting('expandDepth', 2);
    tree.refresh();
    const roots2 = await tree.getChildren();
    const level1b = await tree.getChildren(roots2[0]);
    const css2 = level1b.find((n) => n.label === 'css') as RemoteNode;
    assert.equal(css2.collapsibleState, Expanded);
    // 第二层的内容仍然折叠（这里 a.css 是文件，用 depth 验证）
    assert.equal(css2.depth, 1);

    // 设成 0：全部折叠
    __vscodeTest.setSetting('expandDepth', 0);
    tree.refresh();
    const roots3 = await tree.getChildren();
    assert.equal(roots3[0].collapsibleState, Collapsed, '设为 0 时应该全部折叠');
  } finally {
    __vscodeTest.setSetting('expandDepth', 1);
    await rig.dispose();
  }
});

test('端到端：远程列表是按需加载 + 缓存的（不点开就不列，点过就记住）', async () => {
  const rig = await setupRig({ remotePath: '/site', context: '.', ignore: ['.vscode'] });

  try {
    const { projectDir, tree, sync } = rig;

    // 造两层目录，让"是否按需加载"看得出来
    writeFile(path.join(projectDir, 'index.html'), 'x');
    writeFile(path.join(projectDir, 'css', 'a.css'), 'x');
    writeFile(path.join(projectDir, 'css', 'deep', 'b.css'), 'x');
    await sync.uploadPath(path.join(projectDir, 'css'));
    await sync.uploadFile(path.join(projectDir, 'index.html'));

    const listCalls: string[] = [];
    const originalList = sync.listRemote.bind(sync);
    (sync as unknown as { listRemote: (p: string) => Promise<unknown> }).listRemote = async (p: string) => {
      listCalls.push(p);
      return originalList(p);
    };

    const Collapsed = vscodeShim.TreeItemCollapsibleState.Collapsed;
    const Expanded = vscodeShim.TreeItemCollapsibleState.Expanded;

    // ① 打开面板：只拿到同步根节点，一次列目录都不该发生
    const roots = await tree.getChildren();
    assert.equal(roots.length, 1);
    assert.equal(roots[0].collapsibleState, Expanded, '同步根默认展开，所以会列第一层');
    assert.deepEqual(listCalls, [], '只是打开面板、还没渲染第一层时，不应该列任何目录');

    // ② 渲染第一层：正好 1 次，只列了 /site
    const level1 = await tree.getChildren(roots[0]);
    assert.deepEqual(listCalls, ['/site'], `第一层只该列一次，实际：${JSON.stringify(listCalls)}`);
    assert.deepEqual(
      level1.map((n) => n.label).sort(),
      ['css', 'index.html'],
    );

    // ③ 第一层的目录是折叠的 —— 没点开就绝不去列它
    const css = level1.find((n) => n.label === 'css') as RemoteNode;
    assert.equal(css.collapsibleState, Collapsed);
    assert.equal(css.depth, 1);
    assert.deepEqual(listCalls, ['/site'], `没点开 css 就不该列 /site/css，实际：${JSON.stringify(listCalls)}`);

    // ④ 点开 css：只新增 1 次，而且只列它自己
    const level2 = await tree.getChildren(css);
    assert.deepEqual(listCalls, ['/site', '/site/css'], `点开才列，实际：${JSON.stringify(listCalls)}`);
    const deep = level2.find((n) => n.label === 'deep') as RemoteNode;
    assert.equal(deep.collapsibleState, Collapsed, '第二层目录仍然是折叠的');
    assert.deepEqual(listCalls, ['/site', '/site/css'], 'deep 没点开，不应该被列');

    // ⑤ 折叠再展开、以及重新渲染父目录：全部命中缓存，0 次新请求
    await tree.getChildren(deep);
    assert.deepEqual(listCalls, ['/site', '/site/css', '/site/css/deep']);
    await tree.getChildren(css);
    await tree.getChildren(roots[0]);
    await tree.getChildren(css);
    assert.deepEqual(
      listCalls,
      ['/site', '/site/css', '/site/css/deep'],
      `重复展开必须命中缓存，实际：${JSON.stringify(listCalls)}`,
    );

    // ⑥ 刷新工具栏会清缓存（这是显式行为），之后会重新列一次
    tree.refresh();
    await tree.getChildren(roots[0]);
    assert.equal(listCalls.length, 4, `刷新后应该重新列一次第一层，实际：${JSON.stringify(listCalls)}`);
  } finally {
    await rig.dispose();
  }
});

test('端到端：内容没改动时按 Ctrl+S 不会再上传一次', async () => {
  const rig = await setupRig({
    remotePath: '/site',
    context: '.',
    uploadOnSave: true,
    ignore: ['.vscode'],
  });

  try {
    const { projectDir, remoteRoot, sync, connection, watcher } = rig;
    watcher.start();

    // 数"真的发起了远程写操作"的次数（跳过的情况根本不会走到 connection.run）
    let remoteWrites = 0;
    const originalRun = connection.run.bind(connection);
    (connection as unknown as { run: unknown }).run = ((profile: unknown, op: (c: unknown) => Promise<unknown>) =>
      originalRun(profile as never, async (client) => {
        remoteWrites++;
        return op(client);
      })) as never;

    const file = path.join(projectDir, 'main.go');
    writeFile(file, 'package main\n');
    const remote = path.join(remoteRoot, 'site', 'main.go');

    // 第一次保存：应该上传
    await __vscodeTest.fireSave(file);
    await waitFor(() => fs.existsSync(remote), '第一次保存应该上传');
    assert.equal(remoteWrites, 1, '第一次保存应该真的传一次');

    // 内容没动，再按两次 Ctrl+S：一次都不该发起远程写
    // （先等过文件监听的 900ms 去抖窗口，否则会被那一层先拦下，测不到内容比对）
    await pastDebounce();
    await __vscodeTest.fireSave(file);
    await __vscodeTest.fireSave(file);
    await settle();
    assert.equal(remoteWrites, 1, `内容没变时不该重复上传，实际发起了 ${remoteWrites} 次远程写`);

    // 日志里要说明为什么跳过，否则用户以为插件坏了
    assert.ok(
      __vscodeTest.outputLines().some((l) => /内容没有变化，跳过上传：main\.go/.test(l)),
      `日志里应该说明跳过的原因，实际：${__vscodeTest.outputLines().slice(-5).join(' | ')}`,
    );

    // 真改了内容：必须上传，而且远程内容要跟着变
    await pastDebounce();
    writeFile(file, 'package main\n\nfunc main() {}\n');
    await __vscodeTest.fireSave(file);
    await waitFor(
      () => fs.readFileSync(remote, 'utf8') === 'package main\n\nfunc main() {}\n',
      '改动后必须上传新内容',
    );
    assert.equal(remoteWrites, 2);

    // 再保存一次没改动的：又应该被跳过
    await pastDebounce();
    await __vscodeTest.fireSave(file);
    await settle();
    assert.equal(remoteWrites, 2, '改完传过之后，再次保存没改动的内容仍然不该上传');
    void sync;
  } finally {
    await rig.dispose();
  }
});

test('端到端：显式上传命令会强制上传，不受"内容没变"影响', async () => {
  const rig = await setupRig({ remotePath: '/site', context: '.', ignore: ['.vscode'] });

  try {
    const { projectDir, remoteRoot, sync } = rig;
    const file = path.join(projectDir, 'app.js');
    writeFile(file, 'console.log(1)\n');

    // 自动上传语义：第一次传、第二次跳过
    assert.equal(await sync.uploadFile(file), 'uploaded');
    assert.equal(await sync.uploadFile(file), 'unchanged');

    // 显式命令语义：说了传就一定要传上去
    assert.equal(await sync.uploadFile(file, { force: true }), 'uploaded');
    assert.equal(await sync.uploadFile(file, { force: true }), 'uploaded');

    // 目录/整个项目的显式上传同样带 force
    const result = await sync.uploadPath(path.join(projectDir), { force: true });
    assert.equal(result.uploaded, 1, '显式上传目录时文件应该被真的传上去');
    assert.equal(result.skipped, 0);
    assert.equal(fs.readFileSync(path.join(remoteRoot, 'site', 'app.js'), 'utf8'), 'console.log(1)\n');
  } finally {
    await rig.dispose();
  }
});

test('端到端：上传到不同服务器时不会因为"内容没变"被误跳过', async () => {
  const rig = await setupRig({ remotePath: '/site', context: '.', ignore: ['.vscode'] });

  try {
    const { projectDir, remoteRoot, sync, config } = rig;
    const file = path.join(projectDir, 'shared.js');
    writeFile(file, 'x\n');

    assert.equal(await sync.uploadFile(file), 'uploaded');
    assert.equal(await sync.uploadFile(file), 'unchanged');
    void config;

    // 指纹是按「服务器 + 远程路径」存的，换一份配置（不同 remotePath）就不该命中
    const raw = JSON.parse(fs.readFileSync(path.join(projectDir, '.vscode', 'sftp.json'), 'utf8'));
    raw.remotePath = '/other';
    fs.writeFileSync(path.join(projectDir, '.vscode', 'sftp.json'), JSON.stringify(raw), 'utf8');
    await rig.config.refresh();

    assert.equal(rig.config.active?.remotePath, '/other');
    assert.equal(await sync.uploadFile(file), 'uploaded', '换到别的远程路径必须重新传一次');
    assert.ok(fs.existsSync(path.join(remoteRoot, 'other', 'shared.js')));
    assert.ok(fs.existsSync(path.join(remoteRoot, 'site', 'shared.js')));
  } finally {
    await rig.dispose();
  }
});

test('端到端：把 profile 指向另一台服务器后，不会被"内容没变"误跳过', async () => {
  // 场景：profile 名字还叫"生产"，但 host/端口已经改成另一台机器。
  // 指纹如果只按名字存，就会以为"已经传过了"，导致新服务器上一个文件都没有。
  const secondRoot = makeTempDir('sync-remote-second');
  const second = await startSftpServer({ root: secondRoot });
  const rig = await setupRig({ name: '生产', remotePath: '/site', context: '.', ignore: ['.vscode'] });

  try {
    const { projectDir, sync } = rig;
    const file = path.join(projectDir, 'deploy.sh');
    writeFile(file, '#!/bin/sh\necho hi\n');

    assert.equal(await sync.uploadFile(file), 'uploaded');
    assert.equal(await sync.uploadFile(file), 'unchanged');

    // 换服务器：只改端口，名字保持"生产"
    const cfgPath = path.join(projectDir, '.vscode', 'sftp.json');
    const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    assert.equal(raw.name, '生产');
    raw.port = second.port;
    fs.writeFileSync(cfgPath, JSON.stringify(raw), 'utf8');
    await rig.config.refresh();
    assert.equal(rig.config.active?.name, '生产', '名字没变');
    assert.equal(rig.config.active?.port, second.port, '端口变了');

    assert.equal(await sync.uploadFile(file), 'uploaded', '换了服务器必须重新传一次');
    assert.ok(
      fs.existsSync(path.join(secondRoot, 'site', 'deploy.sh')),
      '新服务器上必须真的有这个文件',
    );
  } finally {
    await rig.dispose();
    await second.close();
    fs.rmSync(secondRoot, { recursive: true, force: true });
  }
});

test('端到端：uploadOnlyWhenChanged=false 时，每次保存都会重新上传', async () => {
  const rig = await setupRig({
    remotePath: '/site',
    context: '.',
    uploadOnSave: true,
    uploadOnlyWhenChanged: false,
    ignore: ['.vscode'],
  });

  try {
    const { projectDir, sync } = rig;
    assert.equal(rig.config.active?.uploadOnlyWhenChanged, false);

    const file = path.join(projectDir, 'always.js');
    writeFile(file, 'same\n');

    // 关掉之后，"内容没变"不该再拦着
    assert.equal(await sync.uploadFile(file), 'uploaded');
    assert.equal(await sync.uploadFile(file), 'uploaded');
    assert.equal(await sync.uploadFile(file), 'uploaded');
  } finally {
    await rig.dispose();
  }
});

test('增量同步：VSCode 关着时改的/新增的/删掉的，打开项目后一次补上', async () => {
  const rig = await setupRig({
    remotePath: '/site',
    context: '.',
    deleteOnLocalDelete: true,
    ignore: ['.vscode'],
  });

  try {
    const { projectDir, remoteRoot, sync } = rig;

    // 先把账本状态摆成"正常用了一阵"的样子：建过基线，文件也都传过
    writeFile(path.join(projectDir, 'a.txt'), 'A');
    writeFile(path.join(projectDir, 'b.txt'), 'B');
    sync.rememberBaseline(await sync.scanForChanges());
    await sync.uploadAll({ force: true });
    assert.equal(fs.readFileSync(path.join(remoteRoot, 'site', 'a.txt'), 'utf8'), 'A');

    // ① 什么都没动 → 扫描结果为空
    let scan = await sync.scanForChanges();
    assert.equal(scan.baselineOnly, false, '已经建过基线，不该再是首次');
    assert.equal(scan.toUpload.length, 0, '没有变化就不该有待上传');
    assert.equal(scan.toDelete.length, 0, '没有删除就不该有待删除');
    assert.equal(scan.unchanged, 2);

    // ② 模拟 VSCode 没开时的外部改动：改一个、加一个、删一个
    writeFile(path.join(projectDir, 'a.txt'), 'A changed');
    writeFile(path.join(projectDir, 'c.txt'), 'C');
    fs.rmSync(path.join(projectDir, 'b.txt'));

    scan = await sync.scanForChanges();
    assert.deepEqual(
      scan.toUpload.map((i) => path.basename(i.localPath)).sort(),
      ['a.txt', 'c.txt'],
      '改动和新增都要被发现',
    );
    assert.deepEqual(
      scan.toDelete.map((i) => path.basename(i.localPath)),
      ['b.txt'],
      '本地已删的也要被发现',
    );

    // ③ 执行
    const result = await sync.applyScan(scan);
    assert.equal(result.uploaded, 2);
    assert.equal(result.deleted, 1);
    assert.deepEqual(result.failed, []);

    // ④ 远程真的跟着变了
    assert.equal(fs.readFileSync(path.join(remoteRoot, 'site', 'a.txt'), 'utf8'), 'A changed');
    assert.equal(fs.readFileSync(path.join(remoteRoot, 'site', 'c.txt'), 'utf8'), 'C');
    assert.equal(fs.existsSync(path.join(remoteRoot, 'site', 'b.txt')), false, '远程对应文件也应该被删掉');

    // ⑤ 再扫一遍：已经干净了
    scan = await sync.scanForChanges();
    assert.equal(scan.toUpload.length, 0);
    assert.equal(scan.toDelete.length, 0);
  } finally {
    await rig.dispose();
  }
});

test('增量同步：deleteOnLocalDelete 关着时，绝不删远程', async () => {
  const rig = await setupRig({
    remotePath: '/site',
    context: '.',
    deleteOnLocalDelete: false,
    ignore: ['.vscode'],
  });

  try {
    const { projectDir, remoteRoot, sync } = rig;
    writeFile(path.join(projectDir, 'keep.txt'), 'K');
    await sync.uploadAll({ force: true });
    assert.ok(fs.existsSync(path.join(remoteRoot, 'site', 'keep.txt')));

    // 本地删掉，但开关是关的
    fs.rmSync(path.join(projectDir, 'keep.txt'));
    const scan = await sync.scanForChanges();
    assert.equal(scan.toDelete.length, 0, 'deleteOnLocalDelete=false 时不该产生任何删除计划');
    assert.ok(fs.existsSync(path.join(remoteRoot, 'site', 'keep.txt')), '远程文件必须还在');
  } finally {
    await rig.dispose();
  }
});

test('增量同步：首次同步对"已经部署好"的项目不会全量重传（只登记远程已有的）', async () => {
  const rig = await setupRig({ remotePath: '/site', context: '.', deleteOnLocalDelete: true, ignore: ['.vscode'] });

  try {
    const { projectDir, remoteRoot, sync } = rig;
    // 远程上已经有这两个文件（早就部署过），本地内容也一致
    writeFile(path.join(remoteRoot, 'site', 'x1.txt'), '1');
    writeFile(path.join(remoteRoot, 'site', 'x2.txt'), '2');
    writeFile(path.join(projectDir, 'x1.txt'), '1');
    writeFile(path.join(projectDir, 'x2.txt'), '2');

    // 账本里还没有这台服务器的基线（模拟刚启用）
    let scan = await sync.scanForChanges();
    assert.equal(scan.baselineOnly, true, '账本里没有基线时要标记成"首次"');
    assert.equal(scan.toBaseline.length, 2, '远程已有的两个文件按基线登记');
    assert.deepEqual(scan.toUpload, [], '远程都有 → 一个都不该重传');

    sync.rememberBaseline(scan);
    assert.equal(sync.ledgerCount(), 2, '基线要真的记进账本');
    assert.equal(fs.existsSync(path.join(remoteRoot, 'site', 'x1.txt')), true, '远程文件当然还在');

    // 之后再扫：不是首次了，也没有要传的
    scan = await sync.scanForChanges();
    assert.equal(scan.baselineOnly, false, '有基线之后就不该再是首次');
    assert.equal(scan.toUpload.length, 0);

    // 真改了才会上报
    writeFile(path.join(projectDir, 'x1.txt'), '1 changed');
    scan = await sync.scanForChanges();
    assert.deepEqual(scan.toUpload.map((i) => path.basename(i.localPath)), ['x1.txt']);
  } finally {
    await rig.dispose();
  }
});

test('增量同步：远程内容和基线记录不一致时绝不删（那可能是别人的文件）', async () => {
  // 危险场景：远程 /site/shared.txt 是别人放的；本地也有一个同名的、但从没被本插件传过。
  // 建基线时它会被记下来 —— 如果拿它做删除判断，本地一删就会把别人的远程文件删掉。
  const rig = await setupRig({
    remotePath: '/site',
    context: '.',
    deleteOnLocalDelete: true,
    ignore: ['.vscode'],
  });

  try {
    const { projectDir, remoteRoot, sync } = rig;

    // 模拟"别人传的"远程文件 + 本地同名文件（从没被本插件上传过）
    writeFile(path.join(remoteRoot, 'site', 'shared.txt'), '别人放的');
    writeFile(path.join(projectDir, 'shared.txt'), '我本地的');

    // 第一次启用 → 建基线
    const baseline = await sync.scanForChanges();
    assert.equal(baseline.baselineOnly, true);
    sync.rememberBaseline(baseline);

    // 本地把那个从没传过的文件删掉
    fs.rmSync(path.join(projectDir, 'shared.txt'));

    const scan = await sync.scanForChanges();
    const result = await sync.applyScan(scan);

    // 关键：远程内容和基线记录（"我本地的"）不一致 → 那不是我们的文件，跳过
    assert.equal(result.deleted, 0, `别人的文件不该被删，实际删了 ${result.deleted} 个`);
    assert.equal(result.skipped, 1, '应该被记成"跳过"');
    assert.equal(
      fs.readFileSync(path.join(remoteRoot, 'site', 'shared.txt'), 'utf8'),
      '别人放的',
      '别人的远程文件必须原封不动',
    );

    // 而且跳过一次之后就不再反复提出来（本地文件已经没了，这条记录没用了）
    const again = await sync.scanForChanges();
    assert.equal(again.toDelete.length, 0, '跳过之后不该每次启动都重新提出来');
  } finally {
    await rig.dispose();
  }
});

test('增量同步：基线记录过、且远程内容一致的文件，本地删除会同步删远程', async () => {
  // 这是最实际的场景：项目早就部署好了（远程就是本地那份），装上插件建了基线，
  // 然后本地删掉某个文件 —— 用户期望远程也跟着删。
  const rig = await setupRig({
    remotePath: '/site',
    context: '.',
    deleteOnLocalDelete: true,
    ignore: ['.vscode'],
  });

  try {
    const { projectDir, remoteRoot, sync } = rig;

    // 模拟"早就部署好了"：远程已有和本地一模一样的内容
    writeFile(path.join(projectDir, 'old.js'), 'let a = 1;\n');
    writeFile(path.join(projectDir, 'keep.js'), 'keep\n');
    fs.mkdirSync(path.join(remoteRoot, 'site'), { recursive: true });
    writeFile(path.join(remoteRoot, 'site', 'old.js'), 'let a = 1;\n');
    writeFile(path.join(remoteRoot, 'site', 'keep.js'), 'keep\n');

    // 建基线（本地和远程内容一致，所以删除核对能通过）
    const baseline = await sync.scanForChanges();
    assert.equal(baseline.baselineOnly, true);
    sync.rememberBaseline(baseline);
    assert.equal(sync.ledgerCount(), 2);

    // 本地删掉 old.js
    fs.rmSync(path.join(projectDir, 'old.js'));

    const scan = await sync.scanForChanges();
    assert.deepEqual(scan.toDelete.map((i) => i.remotePath), ['/site/old.js']);

    const result = await sync.applyScan(scan);
    assert.equal(result.deleted, 1, '内容和基线一致 → 应该真的删掉');
    assert.equal(fs.existsSync(path.join(remoteRoot, 'site', 'old.js')), false);
    assert.ok(fs.existsSync(path.join(remoteRoot, 'site', 'keep.js')), '没删的文件必须还在');
  } finally {
    await rig.dispose();
  }
});

test('增量同步：一旦自己传过，之后再删本地就会同步删远程', async () => {
  const rig = await setupRig({
    remotePath: '/site',
    context: '.',
    deleteOnLocalDelete: true,
    ignore: ['.vscode'],
  });

  try {
    const { projectDir, remoteRoot, sync } = rig;
    const file = path.join(projectDir, 'mine.txt');
    writeFile(file, 'mine');

    // 真的传一次（不是建基线）
    assert.equal(await sync.uploadFile(file), 'uploaded');
    assert.equal(fs.readFileSync(path.join(remoteRoot, 'site', 'mine.txt'), 'utf8'), 'mine');

    // 本地删掉 → 应该进删除计划
    fs.rmSync(file);
    const scan = await sync.scanForChanges();
    assert.deepEqual(scan.toDelete.map((i) => i.remotePath), ['/site/mine.txt']);

    const result = await sync.applyScan(scan);
    assert.equal(result.deleted, 1);
    assert.equal(fs.existsSync(path.join(remoteRoot, 'site', 'mine.txt')), false);
  } finally {
    await rig.dispose();
  }
});

test('增量同步：建基线之后内容没变，不该被当成"变了"重传', async () => {
  const rig = await setupRig({ remotePath: '/site', context: '.', ignore: ['.vscode'] });

  try {
    const { projectDir, remoteRoot, sync } = rig;
    writeFile(path.join(projectDir, 'steady.txt'), 'steady');
    // 远程上也有这个文件（部署时就传过）
    writeFile(path.join(remoteRoot, 'site', 'steady.txt'), 'steady');

    const baseline = await sync.scanForChanges();
    assert.equal(baseline.baselineOnly, true);
    assert.equal(baseline.toBaseline.length, 1, '远程已有 → 按基线登记');
    assert.deepEqual(baseline.toUpload, [], '远程已有就不该重传');
    sync.rememberBaseline(baseline);

    // 基线记的是"当前本地内容"，所以内容没变时不该再被列出来
    const after = await sync.scanForChanges();
    assert.equal(after.toUpload.length, 0, '基线记下的内容不该被当成变化');
    assert.equal(after.unchanged, 1);
  } finally {
    await rig.dispose();
  }
});

test('增量同步：账本能报告条目数（日志靠它证明"基线到底建上了没有"）', async () => {
  const rig = await setupRig({ remotePath: '/site', context: '.', ignore: ['.vscode'] });

  try {
    const { projectDir, remoteRoot, sync } = rig;
    // 三个文件在远程上都已经有了
    for (const n of ['n1.txt', 'n2.txt', 'n3.txt']) {
      writeFile(path.join(projectDir, n), n);
      writeFile(path.join(remoteRoot, 'site', n), n);
    }

    assert.equal(sync.ledgerCount(), 0, '还没建基线时应该是 0');

    const scan = await sync.scanForChanges();
    assert.equal(scan.baselineOnly, true);
    sync.rememberBaseline(scan);
    assert.equal(sync.ledgerCount(), 3, '建完基线应该记下 3 条');

    // 再扫一遍没有变化，账本条目数不变（日志里会打出来，用户能据此确认基线还在）
    await sync.scanForChanges();
    assert.equal(sync.ledgerCount(), 3);

    // 真的传一个文件之后，条目数依然对得上
    assert.equal(await sync.uploadFile(path.join(projectDir, 'n1.txt'), { force: true }), 'uploaded');
    assert.equal(sync.ledgerCount(), 3);
  } finally {
    await rig.dispose();
  }
});

test('增量同步：中途传过几个文件之后再启用，第一次扫描仍然是基线（不会误报"全都变了"）', async () => {
  // 这是真实会踩到的路径：装上插件后正常用了一阵（账本里已经有几条记录），
  // 这时才打开 syncOnStartup。如果靠"账本是不是空的"判断首次，就会把
  // 剩下所有文件都当成新增报出来。
  const rig = await setupRig({ remotePath: '/site', context: '.', ignore: ['.vscode'] });

  try {
    const { projectDir, remoteRoot, sync } = rig;
    writeFile(path.join(projectDir, 'touched.txt'), 'touched');
    writeFile(path.join(projectDir, 'never.txt'), 'never uploaded');
    writeFile(path.join(projectDir, 'also-never.txt'), 'also never');
    // 这两个在远程上已经有了（部署时就传过），只是账本里还没记录
    writeFile(path.join(remoteRoot, 'site', 'never.txt'), 'never uploaded');
    writeFile(path.join(remoteRoot, 'site', 'also-never.txt'), 'also never');

    // 用户按了一次 Ctrl+S（自动上传）→ 账本里有了 1 条记录，但还没建过基线
    assert.equal(await sync.uploadFile(path.join(projectDir, 'touched.txt')), 'uploaded');
    assert.equal(sync.hasBaseline(), false, '传过一个文件不等于建过基线');
    assert.equal(sync.ledgerCount(), 1, '账本里已经有 1 条记录了');

    // 现在启用自动同步，第一次扫描应该仍然是"首次"，只建基线
    const scan = await sync.scanForChanges();
    assert.equal(scan.baselineOnly, true, '账本非空也不能算"已建基线"');
    // 三个文件在远程上都已经有了（touched 是刚传上去的），所以三个都按基线登记
    assert.equal(scan.toBaseline.length, 3, '远程已有的都按基线登记');
    assert.deepEqual(scan.toUpload, [], '远程都有 → 没有要上传的');

    sync.rememberBaseline(scan);
    assert.equal(sync.hasBaseline(), true);
    assert.equal(sync.ledgerCount(), 3, '两个文件 + 之前那条 = 3 条（基线标记不算条目）');

    // 建完基线之后：没有变化，也不该上传任何东西
    const after = await sync.scanForChanges();
    assert.equal(after.baselineOnly, false, '建过基线之后就不该再是首次');
    assert.equal(after.toUpload.length, 0, '内容没变 → 没有要上传的');

    // 之后真的改了才会上报
    writeFile(path.join(projectDir, 'never.txt'), 'now changed');
    const changed = await sync.scanForChanges();
    assert.deepEqual(changed.toUpload.map((i) => path.basename(i.localPath)), ['never.txt']);
  } finally {
    await rig.dispose();
  }
});

test('增量同步：基线标记不会被当成"本地已删的远程文件"', async () => {
  const rig = await setupRig({
    remotePath: '/site',
    context: '.',
    deleteOnLocalDelete: true,
    ignore: ['.vscode'],
  });

  try {
    const { projectDir, remoteRoot, sync } = rig;
    writeFile(path.join(projectDir, 'seed.txt'), 'seed');
    writeFile(path.join(remoteRoot, 'site', 'seed.txt'), 'seed');

    const scan = await sync.scanForChanges();
    sync.rememberBaseline(scan);
    assert.equal(sync.hasBaseline(), true);

    // 基线标记是账本内部的假路径，绝不能冒出一个 /site/\u0001__baseline__ 的删除计划
    const next = await sync.scanForChanges();
    assert.equal(next.toDelete.length, 0, `基线标记不该产生删除计划：${JSON.stringify(next.toDelete)}`);
    assert.equal(sync.ledgerCount(), 1, 'ledgerCount 不该把标记算进去');
  } finally {
    await rig.dispose();
  }
});

test('增量同步：加进 ignore 的路径连删除也不管（避免误删服务器上的证书/缓存）', async () => {
  const rig = await setupRig({
    remotePath: '/site',
    context: '.',
    deleteOnLocalDelete: true,
    ignore: ['.vscode'],
  });

  try {
    const { projectDir, remoteRoot, sync, config } = rig;

    // 模拟"服务器上的运行时数据"：本地有一份、远程也有一份、内容一致
    fs.mkdirSync(path.join(projectDir, 'storage', 'cert'), { recursive: true });
    writeFile(path.join(projectDir, 'storage', 'cert', 'site.crt'), 'CERT-CONTENT');
    fs.mkdirSync(path.join(remoteRoot, 'site', 'storage', 'cert'), { recursive: true });
    writeFile(path.join(remoteRoot, 'site', 'storage', 'cert', 'site.crt'), 'CERT-CONTENT');

    // 先建基线，把这份证书记进账本
    sync.rememberBaseline(await sync.scanForChanges());

    // 现在把它加进 ignore
    const cfgPath = path.join(projectDir, '.vscode', 'sftp.json');
    const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    raw.ignore = ['.vscode', 'storage/cert'];
    fs.writeFileSync(cfgPath, JSON.stringify(raw), 'utf8');
    await config.refresh();
    assert.ok(config.ignore().ignores('storage/cert/site.crt'), '忽略规则应该生效');

    // 本地这份不见了（比如被清理脚本删了）
    fs.rmSync(path.join(projectDir, 'storage', 'cert', 'site.crt'));

    const scan = await sync.scanForChanges();
    assert.equal(
      scan.toDelete.length,
      0,
      `被 ignore 的路径不该进删除计划，实际：${JSON.stringify(scan.toDelete.map((i) => i.remotePath))}`,
    );

    const result = await sync.applyScan(scan);
    assert.equal(result.deleted, 0);
    assert.ok(
      fs.existsSync(path.join(remoteRoot, 'site', 'storage', 'cert', 'site.crt')),
      '服务器上的证书必须原封不动',
    );
  } finally {
    await rig.dispose();
  }
});

test('下载：一个文件下不下来，其余照样下完，最后汇总失败清单', async () => {
  // 真实场景：宝塔生成的 `.user.ini` 属主是 root，服务器对它的 RETR 直接回 550，
  // 以前会把整个下载打断，用户只看到"下载到一半停了"。
  const rig = await setupRig({ remotePath: '/site', context: '.', ignore: ['.vscode'] });

  try {
    const { projectDir, remoteRoot, sync } = rig;

    // 在"远程"造一棵树
    writeFile(path.join(remoteRoot, 'site', 'a.txt'), 'A');
    writeFile(path.join(remoteRoot, 'site', 'sub', 'b.txt'), 'B');
    writeFile(path.join(remoteRoot, 'site', 'sub', 'deep', 'c.txt'), 'C');
    writeFile(path.join(remoteRoot, 'site', '.user.ini'), '不让下');

    // 只让 .user.ini 失败，其它都正常
    const original = sync.downloadRemote.bind(sync);
    let attempts = 0;
    (sync as unknown as { downloadRemote: (r: string, l: string) => Promise<void> }).downloadRemote = async (r, l) => {
      attempts++;
      if (r.endsWith('.user.ini')) {
        throw new Error("远程操作失败：RETR .user.ini → 550 Can't open .user.ini: No such file or directory");
      }
      return original(r, l);
    };

    const dest = path.join(projectDir, 'pull');
    const result = await sync.downloadInto('/site', dest);

    // ① 其余文件一个不少
    assert.equal(result.downloaded, 3, `其它文件必须照样下完，实际成功 ${result.downloaded} 个`);
    assert.equal(fs.readFileSync(path.join(dest, 'a.txt'), 'utf8'), 'A');
    assert.equal(fs.readFileSync(path.join(dest, 'sub', 'b.txt'), 'utf8'), 'B');
    assert.equal(fs.readFileSync(path.join(dest, 'sub', 'deep', 'c.txt'), 'utf8'), 'C');
    assert.equal(fs.existsSync(path.join(dest, '.user.ini')), false);

    // ② 失败被记下来，且带着服务器的原话
    assert.equal(result.failed.length, 1);
    assert.ok(result.failed[0].remotePath.endsWith('.user.ini'));
    assert.match(result.failed[0].error, /550/);
    assert.equal(result.failed[0].localPath, path.join(dest, '.user.ini'));
    assert.equal(attempts, 4, '四个文件都要尝试过');

    // ③ 日志里能看出"这个文件失败了，但流程继续"
    const out = __vscodeTest.outputLines().join('\n');
    assert.match(out, /下载失败（继续处理其它文件）.*\.user\.ini/s);
    assert.ok(
      out.indexOf('.user.ini') < out.indexOf('/site/a.txt'),
      '失败发生在 a.txt 之前，说明没有中断、后面的文件照样下了',
    );
  } finally {
    await rig.dispose();
  }
});

test('下载：命中忽略规则的远程路径不下载（那是服务器自己生成的）', async () => {
  const rig = await setupRig({ remotePath: '/site', context: '.', ignore: ['.vscode', 'runtime'] });

  try {
    const { projectDir, remoteRoot, sync } = rig;
    writeFile(path.join(remoteRoot, 'site', 'app.php'), '<?php');
    writeFile(path.join(remoteRoot, 'site', 'runtime', 'cache', 'x.php'), '缓存');

    const dest = path.join(projectDir, 'pull2');
    const result = await sync.downloadInto('/site', dest);

    assert.equal(result.downloaded, 1, '只有 app.php 该下来');
    assert.equal(result.skipped, 1, 'runtime 整个目录算跳过一次');
    assert.ok(fs.existsSync(path.join(dest, 'app.php')));
    assert.equal(fs.existsSync(path.join(dest, 'runtime')), false, '被忽略的目录不该落到本地');
  } finally {
    await rig.dispose();
  }
});

test('下载：downloadAll 把整个远程根拉到本地 context 目录', async () => {
  const rig = await setupRig({ remotePath: '/site', context: '.', ignore: ['.vscode'] });

  try {
    const { projectDir, remoteRoot, sync } = rig;
    writeFile(path.join(remoteRoot, 'site', 'index.php'), '<?php echo 1;');
    writeFile(path.join(remoteRoot, 'site', 'lib', 'helper.php'), '<?php');
    writeFile(path.join(remoteRoot, 'site', 'public', 'assets', 'app.css'), 'body{}');

    const result = await sync.downloadAll();
    assert.equal(result.downloaded, 3);
    assert.deepEqual(result.failed, []);
    assert.equal(fs.readFileSync(path.join(projectDir, 'index.php'), 'utf8'), '<?php echo 1;');
    assert.equal(fs.readFileSync(path.join(projectDir, 'lib', 'helper.php'), 'utf8'), '<?php');
    assert.equal(fs.readFileSync(path.join(projectDir, 'public', 'assets', 'app.css'), 'utf8'), 'body{}');
  } finally {
    await rig.dispose();
  }
});

test('下载：本地已有的同名文件会被覆盖，但本地多余的不会被删', async () => {
  const rig = await setupRig({ remotePath: '/site', context: '.', ignore: ['.vscode'] });

  try {
    const { projectDir, remoteRoot, sync } = rig;
    writeFile(path.join(remoteRoot, 'site', 'same.php'), '服务器版本');
    writeFile(path.join(projectDir, 'same.php'), '本地版本');
    writeFile(path.join(projectDir, 'only-local.php'), '本地独有');

    const result = await sync.downloadAll();
    assert.equal(result.downloaded, 1);
    assert.equal(fs.readFileSync(path.join(projectDir, 'same.php'), 'utf8'), '服务器版本', '同名文件要被覆盖');
    assert.equal(
      fs.readFileSync(path.join(projectDir, 'only-local.php'), 'utf8'),
      '本地独有',
      '本地多出来的文件不该被删（这个功能只下载、不删本地）',
    );
  } finally {
    await rig.dispose();
  }
});

test('下载后要记账：从远程下载下来的文件，按 Ctrl+S 不该再传回去', async () => {
  // 用户报过的问题：从远程拉了一份新代码下来，没动过的文件 Ctrl+S 不会传，
  // 但"远程上变过、刚下载下来"的文件一保存又会被传回去 —— 因为下载没记账本。
  const rig = await setupRig({ remotePath: '/site', context: '.', ignore: ['.vscode'] });

  try {
    const { projectDir, remoteRoot, sync } = rig;

    // 远程上有"服务器变过"的内容，本地还没有
    writeFile(path.join(remoteRoot, 'site', 'index.php'), '<?php // 服务器版本');
    writeFile(path.join(remoteRoot, 'site', 'lib', 'helper.php'), '<?php // 服务器版本');

    const downloaded = await sync.downloadAll();
    assert.equal(downloaded.downloaded, 2);
    assert.equal(fs.readFileSync(path.join(projectDir, 'index.php'), 'utf8'), '<?php // 服务器版本');

    // 紧接着保存：内容和刚下载的一模一样 → 不该再传
    assert.equal(
      await sync.uploadFile(path.join(projectDir, 'index.php')),
      'unchanged',
      '刚下载下来的文件按 Ctrl+S 不该再上传',
    );
    assert.equal(
      await sync.uploadFile(path.join(projectDir, 'lib', 'helper.php')),
      'unchanged',
      '子目录里的也一样',
    );

    // 真的改了再保存：必须传上去
    writeFile(path.join(projectDir, 'index.php'), '<?php // 本地改的');
    assert.equal(await sync.uploadFile(path.join(projectDir, 'index.php')), 'uploaded');
    assert.equal(
      fs.readFileSync(path.join(remoteRoot, 'site', 'index.php'), 'utf8'),
      '<?php // 本地改的',
      '改了之后要真的传上去',
    );

    // 传完之后再保存一次没改动的：又该被跳过
    assert.equal(await sync.uploadFile(path.join(projectDir, 'index.php')), 'unchanged');
  } finally {
    await rig.dispose();
  }
});

test('下载到别处时不计账（否则会让增量同步误以为本地没了这个文件）', async () => {
  const rig = await setupRig({
    remotePath: '/site',
    context: '.',
    deleteOnLocalDelete: true,
    ignore: ['.vscode'],
  });

  try {
    const { projectDir, remoteRoot, sync } = rig;
    writeFile(path.join(remoteRoot, 'site', 'x.php'), 'X');

    // 下载到"项目之外"的某个位置 —— 路径映射该去的地方（projectDir/x.php）仍然空着
    const elsewhere = path.join(TMP_ROOT, `elsewhere-${Date.now().toString(36)}`, 'x.php');
    await sync.downloadRemote('/site/x.php', elsewhere);
    assert.equal(fs.readFileSync(elsewhere, 'utf8'), 'X', '文件确实下来了');
    fs.rmSync(path.dirname(elsewhere), { recursive: true, force: true });

    // 不能因为"下到别处了"就以为远程那个该删 —— 账本里不该有它的记录
    const scan = await sync.scanForChanges();
    assert.equal(scan.toDelete.length, 0, '不该提议删远程');
    assert.equal(scan.toUpload.length, 0, '本地映射位置没有这个文件，也不该有待上传');
    assert.ok(fs.existsSync(path.join(remoteRoot, 'site', 'x.php')), '远程文件必须原封不动');
  } finally {
    await rig.dispose();
  }
});

test('下载后删本地：远程内容核对通过，仍然会同步删远程', async () => {
  // 下载记的是"基线"印记（内容来自远程、不是我们写的），
  // 所以删本地时仍要先核对远程内容 —— 核对通过就该删。
  const rig = await setupRig({
    remotePath: '/site',
    context: '.',
    deleteOnLocalDelete: true,
    ignore: ['.vscode'],
  });

  try {
    const { projectDir, remoteRoot, sync } = rig;
    writeFile(path.join(remoteRoot, 'site', 'del.php'), 'D');
    await sync.downloadAll();
    assert.ok(fs.existsSync(path.join(projectDir, 'del.php')));

    fs.rmSync(path.join(projectDir, 'del.php'));
    const scan = await sync.scanForChanges();
    assert.deepEqual(scan.toDelete.map((i) => i.remotePath), ['/site/del.php']);

    const result = await sync.applyScan(scan);
    assert.equal(result.deleted, 1);
    assert.equal(fs.existsSync(path.join(remoteRoot, 'site', 'del.php')), false);
  } finally {
    await rig.dispose();
  }
});

test('首次增量同步：远程上还没有的新文件必须被传上去（不该被基线吞掉）', async () => {
  // 用户报的问题：VSCode 关着时新建了文件，打开后跑增量同步却不传。
  // 根因：首次同步（账本里还没有这台服务器的基线）会把**本地所有文件**都按
  // "已经同步过"登记然后就结束了，"远程上其实没有"的文件被一起吞掉。
  // 而"首次"是按连接标识（协议+主机+端口+用户名）算的 —— 改过端口就会重新触发。
  const rig = await setupRig({ remotePath: '/site', context: '.', ignore: ['.vscode'] });

  try {
    const { projectDir, remoteRoot, sync } = rig;

    // 远程上已经部署好的文件
    writeFile(path.join(remoteRoot, 'site', 'existing.php'), '<?php // 远程已有');
    // 本地：一份和远程一致的 + 一个"VSCode 关着时新建的"
    writeFile(path.join(projectDir, 'existing.php'), '<?php // 远程已有');
    writeFile(path.join(projectDir, 'brand-new.txt'), '新建的');

    const scan = await sync.scanForChanges();
    assert.equal(scan.baselineOnly, true, '账本里没有这台服务器的基线，所以是首次');

    assert.deepEqual(
      scan.toUpload.map((i) => path.basename(i.localPath)),
      ['brand-new.txt'],
      '远程上还没有的新文件必须出现在待上传里（不能被基线吞掉）',
    );
  } finally {
    await rig.dispose();
  }
});

test('首次增量同步：远程已有的文件不该被当成"要全量重传"', async () => {
  // 上一条的反面：修完之后 toUpload 会被真正执行，
  // 所以必须保证"早就部署好的项目"首次同步时不会把整个项目重传一遍。
  const rig = await setupRig({ remotePath: '/site', context: '.', ignore: ['.vscode'] });

  try {
    const { projectDir, remoteRoot, sync } = rig;
    for (const name of ['a.php', 'b.php', 'lib/c.php']) {
      writeFile(path.join(remoteRoot, 'site', name), '<?php');
      writeFile(path.join(projectDir, name), '<?php');
    }

    const scan = await sync.scanForChanges();
    assert.equal(scan.baselineOnly, true);
    assert.deepEqual(
      scan.toUpload.map((i) => i.relative),
      [],
      `远程都有，就不该有待上传，实际：${JSON.stringify(scan.toUpload.map((i) => i.relative))}`,
    );
  } finally {
    await rig.dispose();
  }
});

test('端到端：异常路径不会炸 —— 目录映射之外的文件、不存在的远程目录', async () => {
  const rig = await setupRig({ remotePath: '/site', context: 'dist' });

  try {
    const { projectDir, sync } = rig;

    // 同步范围之外的文件：明确返回"不归我管"
    const outside = path.join(projectDir, 'server', 'app.js');
    writeFile(outside, 'x');
    assert.equal(sync.plan(outside), undefined);
    assert.equal(await sync.uploadFile(outside), 'out-of-scope');

    // 列出不存在的远程目录：抛错但要可读
    await assert.rejects(
      () => sync.listRemote('/nope/nothing'),
      (err: unknown) => err instanceof Error && /读取远程目录失败|远程操作失败|不存在/.test(err.message),
    );
  } finally {
    await rig.dispose();
  }
});
