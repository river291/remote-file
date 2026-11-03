/**
 * 忽略路径集合（菜单 when 条件的数据源）的测试。
 *
 * 用途：VSCode 的 `in` / `not in` 操作符可以拿 `resourcePath` 去一个**动态上下文键**里查，
 * 于是菜单能做到：
 *   - 已经被忽略的路径 → 不显示「忽略该目录/该文件/该类型」，只显示「从忽略规则中移除」
 *   - 没被忽略的路径   → 反过来
 *
 * 所以这个集合必须**准**：被忽略目录里的深层文件也要算进去，否则右键它们时菜单会判断错。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as vscode from 'vscode';
import { ConfigStore } from '../src/vscode/configStore';
import { IGNORED_PATHS_KEY, publishIgnoredPaths } from '../src/vscode/ignoredPaths';
import { Logger } from '../src/vscode/logger';
import { __vscodeTest, createExtensionContext, Uri } from './helpers/vscodeStub';

const REPO_ROOT = path.resolve(__dirname, '..');
const TMP_ROOT = path.join(REPO_ROOT, '.tmp-tests');

const CONFIG = `{
  "protocol": "ftp",
  "host": "127.0.0.1",
  "username": "tester",
  "password": "x",
  "remotePath": "/",
  "context": ".",
  "ignore": [".vscode", ".git", "storage/cache", "**/*.log"],
  "mappings": []
}
`;

interface Rig {
  dir: string;
  config: ConfigStore;
  logger: Logger;
  dispose: () => void;
}

async function makeRig(files: Record<string, string>): Promise<Rig> {
  const dir = path.join(TMP_ROOT, `ignored-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(path.join(dir, '.vscode'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.vscode', 'sftp.json'), CONFIG, 'utf8');
  fs.writeFileSync(path.join(dir, '.vscode', 'notes.md'), 'x', 'utf8');
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }

  __vscodeTest.reset();
  __vscodeTest.setWorkspaceFolder(dir);
  const logger = new Logger();
  const config = new ConfigStore(createExtensionContext() as unknown as vscode.ExtensionContext, logger);
  await config.refresh();

  return {
    dir,
    config,
    logger,
    dispose: () => {
      config.dispose();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * 本地文件在菜单里的 `resourcePath` 就是 fsPath
 * （VSCode 内部：`scheme === 'file' ? fsPath : path`）。
 */
const asResourcePath = (abs: string) => Uri.file(abs).fsPath;

function paths(): string[] {
  const value = __vscodeTest.contextKey(IGNORED_PATHS_KEY);
  assert.ok(Array.isArray(value), `上下文键应该是个数组，实际：${JSON.stringify(value)}`);
  return value as string[];
}

test('忽略路径集合：被忽略的目录、目录里的深层文件、按类型忽略的文件都在里面', async () => {
  const rig = await makeRig({
    '.git/config': '[core]\n',
    'storage/cache/a.bin': 'x',
    'storage/cache/deep/nested/b.bin': 'x',
    'logs/app.log': 'x',
    'api/main.go': 'package main',
    'api/admin/handler.go': 'package main',
  });

  try {
    await publishIgnoredPaths(rig.config, rig.logger);
    const set = paths();

    // 被忽略的目录本身
    for (const rel of ['storage/cache', 'storage/cache/a.bin', 'storage/cache/deep', 'storage/cache/deep/nested/b.bin', '.git', '.vscode']) {
      assert.ok(set.includes(asResourcePath(path.join(rig.dir, rel))), `${rel} 应该在集合里`);
    }
    // 按 glob 忽略的文件（`**/*.log`）
    assert.ok(set.includes(asResourcePath(path.join(rig.dir, 'logs', 'app.log'))), 'logs/app.log 应该在集合里');

    // 没被忽略的源码不该进去
    for (const rel of ['api/main.go', 'api/admin/handler.go', 'api']) {
      assert.ok(!set.includes(asResourcePath(path.join(rig.dir, rel))), `${rel} 不该在集合里`);
    }
  } finally {
    rig.dispose();
  }
});

test('忽略路径集合：改了忽略规则之后跟着变', async () => {
  const rig = await makeRig({ 'api/main.go': 'package main', 'storage/cache/a.bin': 'x' });

  try {
    await publishIgnoredPaths(rig.config, rig.logger);
    assert.ok(!paths().includes(asResourcePath(path.join(rig.dir, 'api', 'main.go'))), '一开始 api/main.go 没被忽略');

    // 加一条规则（走真实配置文件）
    const cfgPath = path.join(rig.dir, '.vscode', 'sftp.json');
    const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    raw.ignore = [...raw.ignore, 'api'];
    fs.writeFileSync(cfgPath, JSON.stringify(raw), 'utf8');
    await rig.config.refresh();
    await publishIgnoredPaths(rig.config, rig.logger);

    assert.ok(
      paths().includes(asResourcePath(path.join(rig.dir, 'api', 'main.go'))),
      '加了规则后 api/main.go 应该进集合',
    );
  } finally {
    rig.dispose();
  }
});

test('忽略路径集合：没有任何忽略规则时是空数组（不做无谓的扫描）', async () => {
  const rig = await makeRig({ 'api/main.go': 'package main' });
  try {
    const cfgPath = path.join(rig.dir, '.vscode', 'sftp.json');
    const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    raw.ignore = [];
    fs.writeFileSync(cfgPath, JSON.stringify(raw), 'utf8');
    await rig.config.refresh();

    await publishIgnoredPaths(rig.config, rig.logger);
    assert.deepEqual(paths(), []);
  } finally {
    rig.dispose();
  }
});

/**
 * 集合里的路径形式和 `resourcePath` 的取值规则一致。
 *
 * 这条用例钉的是一个**真实踩过的坑**：VSCode 的实现是
 *     uriToPath(o) { return o.scheme === 'file' ? o.fsPath : o.path }
 * 所以本地文件的 `resourcePath` 是 **fsPath**（Windows 上带反斜杠），
 * 只发 URI path（正斜杠）会导致 `in` 永远为假、菜单静默退化成"全都显示"。
 * 现在两种形式都发，这里两种都要检查到。
 */
test('忽略路径集合：fsPath 和 URI path 两种形式都在（少一种 in 就永远为假）', async () => {
  const rig = await makeRig({ 'storage/cache/a.bin': 'x' });
  try {
    await publishIgnoredPaths(rig.config, rig.logger);
    const set = paths();
    const abs = path.join(rig.dir, 'storage', 'cache');
    const uri = Uri.file(abs);

    assert.ok(set.includes(uri.fsPath), `必须包含 fsPath 形式（本地文件的 resourcePath 用的就是它）：${uri.fsPath}`);
    assert.ok(set.includes(uri.path), `也要包含 URI path 形式（非 file scheme 用）：${uri.path}`);

    // 在 Windows 上这两种形式确实不同 —— 正是这一点决定了必须两个都发
    if (process.platform === 'win32') {
      assert.notEqual(uri.fsPath, uri.path);
      assert.ok(uri.fsPath.includes('\\'), `Windows 的 fsPath 应该带反斜杠，实际：${uri.fsPath}`);
    }
  } finally {
    rig.dispose();
  }
});
