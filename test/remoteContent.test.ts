/**
 * 远程文件预览 URI 的回归测试。
 *
 * 背景：曾经用字符串拼 `remote-file:/${remotePath}` 生成预览 URI，而 remotePath
 * 本身以 `/` 开头，拼出来是 `remote-file://www/index.html` —— `//` 在 URI 语法里
 * 是 authority 分隔符，于是：
 *   - `/www/index.html` → authority="www"，path="/index.html"，第一层目录被吞掉
 *   - `/index.html`     → authority="index.html"，path=""，变成读取整个根目录
 * 后者在真实 FTP 服务器上的表现就是 `RETR /` →
 * "I can only retrieve regular files"。
 *
 * 这个测试用贴近 VSCode 真实语义的 Uri 替身，把这些路径钉死。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as vscodeShim from './helpers/vscodeStub';
import { __vscodeTest } from './helpers/vscodeStub';
import { RemoteContentProvider } from '../src/vscode/remoteContentProvider';
import { ConfigStore } from '../src/vscode/configStore';
import { Logger } from '../src/vscode/logger';
import { SyncService } from '../src/vscode/sync';
import { ConnectionManager } from '../src/vscode/connection';
import type * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';

const CASES = [
  '/index.html', // 根目录下的文件 —— 用户遇到的 RETR / 就是这个
  '/www/index.html',
  '/a/b/c/d.txt',
  '/site/assets/img/logo.png',
  '/www/中文 文件.txt',
  '/www/100%.txt',
  '/www/a?b#c.txt',
  '/www/[方括号].txt',
  '/www/plus+and&amp.txt',
  '/www/eq=sign&amp2.txt',
  '/',
];

test('预览 URI：远程路径往返必须无损，且不能产生 authority', () => {
  for (const remotePath of CASES) {
    const uri = RemoteContentProvider.uriFor(remotePath, '生产');

    // 这是本次 bug 的核心断言：uri 一旦有 authority，第一层目录就被吞了
    assert.equal(uri.authority, '', `不应该产生 authority：${remotePath} → ${uri.toString()}`);
    assert.equal(
      RemoteContentProvider.remotePathOf(uri),
      remotePath,
      `uriFor → remotePathOf 往返失败：${remotePath}`,
    );

    // VSCode 会通过 toString()/parse() 往返一次 URI，往返后仍必须一致
    const roundTripped = vscodeShim.Uri.parse(uri.toString());
    assert.equal(
      RemoteContentProvider.remotePathOf(roundTripped),
      remotePath,
      `toString → parse 往返失败：${remotePath}（${uri.toString()}）`,
    );
    assert.equal(RemoteContentProvider.profileNameOf(roundTripped), '生产', `服务器名应该能取回：${remotePath}`);
  }
});

test('预览 URI：标签名带「(远程)」前缀，用来和本地那份区分', () => {
  const uri = RemoteContentProvider.uriFor('/var/www/html/index.html', '生产');
  assert.equal(uri.path, '/(远程) index.html');

  const deep = RemoteContentProvider.uriFor('/a/b/deep.txt');
  assert.equal(deep.path, '/(远程) deep.txt');

  // 可以自定义显示名
  const custom = RemoteContentProvider.uriFor('/a/b.txt', undefined, '(远程) 自定义名');
  assert.equal(custom.path, '/(远程) 自定义名');
  assert.equal(RemoteContentProvider.remotePathOf(custom), '/a/b.txt');
});

test('预览 URI：两台服务器上的同名路径是两个不同文档', () => {
  const a = RemoteContentProvider.uriFor('/index.html', '生产');
  const b = RemoteContentProvider.uriFor('/index.html', '测试');
  assert.notEqual(a.toString(), b.toString(), '不同服务器的同一路径必须是不同的文档');
  assert.equal(RemoteContentProvider.remotePathOf(a), '/index.html');
  assert.equal(RemoteContentProvider.remotePathOf(b), '/index.html');
  assert.equal(RemoteContentProvider.profileNameOf(a), '生产');
  assert.equal(RemoteContentProvider.profileNameOf(b), '测试');
});

test('预览 URI：明确复现老写法会吞掉第一层目录（防止以后改回去）', () => {
  // 老写法的等价形式
  const buggy = (remotePath: string) => vscodeShim.Uri.parse(`remote-file:/${remotePath}`);

  const deep = buggy('/www/index.html');
  assert.equal(deep.authority, 'www', '老写法会把第一层目录解析成 authority');
  assert.equal(deep.path, '/index.html', '老写法会丢掉第一层目录');

  const rootFile = buggy('/index.html');
  assert.equal(rootFile.path, '', '老写法的根目录文件会变成空 path，也就是读取 /');

  // 新写法没有这个问题
  const fixed = RemoteContentProvider.uriFor('/index.html');
  assert.equal(fixed.authority, '');
  assert.equal(RemoteContentProvider.remotePathOf(fixed), '/index.html');
});

test('预览内容：能读到正确的远程路径，读不到时报可读错误而不是抛出', async () => {
  __vscodeTest.reset();
  const logger = new Logger();
  const context = { workspaceState: { get: () => undefined, update: async () => undefined } };
  const config = new ConfigStore(context as unknown as vscode.ExtensionContext, logger);
  const connection = new ConnectionManager(logger);
  const sync = new SyncService(config, connection, logger);
  const provider = new RemoteContentProvider(config, sync, logger);

  try {
    // 没有任何配置 → 应该把错误写进文档内容里，而不是抛异常炸掉编辑器
    const text = await provider.provideTextDocumentContent(RemoteContentProvider.uriFor('/index.html', '生产'));
    assert.match(text, /读取远程文件失败/);

    // 每次失败都要记日志，方便排查
    assert.ok(
      __vscodeTest.outputLines().some((l) => /读取远程文件失败 \/index\.html/.test(l)),
      `日志里应该记录失败的远程路径，实际：${__vscodeTest.outputLines().join(' | ')}`,
    );
  } finally {
    provider.dispose();
    config.dispose();
    connection.dispose();
    fs.rmSync(path.join(process.cwd(), '.tmp-tests'), { recursive: true, force: true });
  }
});
