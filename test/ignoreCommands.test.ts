/**
 * 「忽略该目录 / 忽略该文件 / 忽略该类型文件 / 从忽略规则中移除」几个命令的集成测试。
 *
 * 纯文本手术在 ignoreEdit.test.ts 里已经测透了；这里测的是**胶水**：
 * 右键路径 + 文件/目录判断 → 算出规则 → 写回配置文件 → 各种兜底提示。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as vscode from 'vscode';
import { listIgnoreRules } from '../src/core/ignoreEdit';
import { ConfigStore } from '../src/vscode/configStore';
import { IgnoreRuleCommands } from '../src/vscode/ignoreCommands';
import { Logger } from '../src/vscode/logger';
import { __vscodeTest, createExtensionContext, Uri } from './helpers/vscodeStub';

const REPO_ROOT = path.resolve(__dirname, '..');
const TMP_ROOT = path.join(REPO_ROOT, '.tmp-tests');

const CONFIG = `{
  // 协议：sftp / ftp / ftps
  "protocol": "ftp",
  "host": "127.0.0.1",
  "username": "tester",
  // 密码别提交到 git
  "password": "x",

  "remotePath": "/",
  "context": ".",

  // 上传开关
  "uploadOnSave": true,
  "deleteOnLocalDelete": true,

  // 不上传的东西
  "ignore": [".vscode", ".git"],
  "mappings": []
}
`;

interface Rig {
  dir: string;
  configPath: string;
  config: ConfigStore;
  commands: IgnoreRuleCommands;
  dispose: () => void;
}

async function makeRig(files: Record<string, string> = {}): Promise<Rig> {
  const dir = path.join(TMP_ROOT, `ignore-cmd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(path.join(dir, '.vscode'), { recursive: true });
  // .git / .vscode 在配置里已经是忽略项了，建成真实目录，"忽略该目录"才能正确识别
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.vscode', 'sftp.json'), CONFIG, 'utf8');
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
    configPath: path.join(dir, '.vscode', 'sftp.json'),
    config,
    commands: new IgnoreRuleCommands(config, logger),
    dispose: () => {
      config.dispose();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

const read = (p: string) => fs.readFileSync(p, 'utf8');
const infoText = () => JSON.stringify(__vscodeTest.infoMessages());
const warnText = () => JSON.stringify(__vscodeTest.warningMessages());

// ─────────────────────────── 忽略该目录 ───────────────────────────

test('忽略该目录：右键目录 → 规则是目录路径，注释保留', async () => {
  const rig = await makeRig({ 'storage/cache/a.bin': 'x' });
  try {
    await rig.commands.ignoreFolder(Uri.file(path.join(rig.dir, 'storage', 'cache')));

    const text = read(rig.configPath);
    assert.deepEqual(listIgnoreRules(text, 'json'), ['.vscode', '.git', 'storage/cache']);
    assert.ok(text.includes('// 不上传的东西'), '原有注释必须保留');
    assert.ok(rig.config.ignore().ignores('storage/cache/a.bin'), '新规则应该立刻生效');
  } finally {
    rig.dispose();
  }
});

test('忽略该目录：目录下所有层级都被忽略', async () => {
  const rig = await makeRig({ 'storage/cache/deep/nested/a.bin': 'x' });
  try {
    await rig.commands.ignoreFolder(Uri.file(path.join(rig.dir, 'storage', 'cache')));
    assert.ok(rig.config.ignore().ignores('storage/cache/deep/nested/a.bin'));
  } finally {
    rig.dispose();
  }
});

test('忽略该目录：对一个文件执行 → 提示用「忽略该文件」，不动配置', async () => {
  const rig = await makeRig({ 'api/main.go': 'package main' });
  try {
    const before = read(rig.configPath);
    await rig.commands.ignoreFolder(Uri.file(path.join(rig.dir, 'api', 'main.go')));

    assert.equal(read(rig.configPath), before, '不该改动配置');
    assert.ok(warnText().includes('不是一个目录'), `应该提示用「忽略该文件」，实际：${warnText()}`);
  } finally {
    rig.dispose();
  }
});

// ─────────────────────────── 忽略该文件 ───────────────────────────

test('忽略该文件：右键文件 → 规则是文件路径', async () => {
  const rig = await makeRig({ 'api/admin/main.go': 'package main' });
  try {
    await rig.commands.ignoreFile(Uri.file(path.join(rig.dir, 'api', 'admin', 'main.go')));

    assert.deepEqual(listIgnoreRules(read(rig.configPath), 'json'), ['.vscode', '.git', 'api/admin/main.go']);
    assert.ok(rig.config.ignore().ignores('api/admin/main.go'));
  } finally {
    rig.dispose();
  }
});

test('忽略该文件：对一个目录执行 → 提示用「忽略该目录」', async () => {
  const rig = await makeRig({ 'storage/cache/a.bin': 'x' });
  try {
    const before = read(rig.configPath);
    await rig.commands.ignoreFile(Uri.file(path.join(rig.dir, 'storage', 'cache')));

    assert.equal(read(rig.configPath), before);
    assert.ok(warnText().includes('这是一个目录'), `应该提示用「忽略该目录」，实际：${warnText()}`);
  } finally {
    rig.dispose();
  }
});

// ─────────────────────────── 忽略该类型文件 ───────────────────────────

test('忽略该类型文件：main.go → **/*.go，提示里说明会影响所有 .go', async () => {
  const rig = await makeRig({
    'api/admin/main.go': 'package main',
    'api/admin/other.go': 'package main',
    'internal/deep/x.go': 'package main',
  });
  try {
    await rig.commands.ignoreFileType(Uri.file(path.join(rig.dir, 'api', 'admin', 'main.go')));

    assert.deepEqual(listIgnoreRules(read(rig.configPath), 'json'), ['.vscode', '.git', '**/*.go']);
    // 任意层级的 .go 都被忽略
    for (const p of ['api/admin/main.go', 'api/admin/other.go', 'internal/deep/x.go']) {
      assert.ok(rig.config.ignore().ignores(p), `${p} 应该被忽略`);
    }
    assert.equal(rig.config.ignore().ignores('api/admin/main.txt'), false, '.txt 不该被牵连');
    assert.ok(infoText().includes('会忽略所有 .go 文件'), `提示要说清影响范围，实际：${infoText()}`);
  } finally {
    rig.dispose();
  }
});

test('忽略该类型文件：没有扩展名的文件 → 提示，不动配置', async () => {
  const rig = await makeRig({ Makefile: 'all:\n\techo hi\n' });
  try {
    const before = read(rig.configPath);
    await rig.commands.ignoreFileType(Uri.file(path.join(rig.dir, 'Makefile')));

    assert.equal(read(rig.configPath), before);
    assert.ok(infoText().includes('没有扩展名'), `应该提示没有扩展名，实际：${infoText()}`);
  } finally {
    rig.dispose();
  }
});

test('忽略该类型文件：.gitignore 这种点开头的也不算"类型"', async () => {
  const rig = await makeRig({ '.gitignore': 'x' });
  try {
    const before = read(rig.configPath);
    await rig.commands.ignoreFileType(Uri.file(path.join(rig.dir, '.gitignore')));
    assert.equal(read(rig.configPath), before, '.gitignore 不该被当成扩展名 gitignore');
  } finally {
    rig.dispose();
  }
});

// ─────────────────────────── 移除 ───────────────────────────

test('移除：右键被忽略目录下面的文件 → 移除覆盖它的那条规则', async () => {
  const rig = await makeRig({ 'storage/cache/a.bin': 'x' });
  try {
    await rig.commands.ignoreFolder(Uri.file(path.join(rig.dir, 'storage', 'cache')));
    assert.ok(rig.config.ignore().ignores('storage/cache/a.bin'));

    await rig.commands.remove(Uri.file(path.join(rig.dir, 'storage', 'cache', 'a.bin')));

    assert.deepEqual(listIgnoreRules(read(rig.configPath), 'json'), ['.vscode', '.git']);
    assert.equal(rig.config.ignore().ignores('storage/cache/a.bin'), false, '移除后应该不再被忽略');
    assert.ok(read(rig.configPath).includes('// 不上传的东西'), '注释仍然保留');
  } finally {
    rig.dispose();
  }
});

test('移除：右键被类型规则覆盖的文件 → 移除那条类型规则', async () => {
  const rig = await makeRig({ 'api/main.go': 'package main' });
  try {
    await rig.commands.ignoreFileType(Uri.file(path.join(rig.dir, 'api', 'main.go')));
    await rig.commands.remove(Uri.file(path.join(rig.dir, 'api', 'main.go')));

    assert.deepEqual(listIgnoreRules(read(rig.configPath), 'json'), ['.vscode', '.git']);
    assert.equal(rig.config.ignore().ignores('api/main.go'), false);
  } finally {
    rig.dispose();
  }
});

test('移除：右键一个没被忽略的文件 → 明确说没有这一条', async () => {
  const rig = await makeRig({ 'api/main.go': 'package main' });
  try {
    const before = read(rig.configPath);
    await rig.commands.remove(Uri.file(path.join(rig.dir, 'api', 'main.go')));

    assert.equal(read(rig.configPath), before);
    assert.ok(infoText().includes('当前没有被忽略'), `实际：${infoText()}`);
  } finally {
    rig.dispose();
  }
});

// ─────────────────────────── 兜底 ───────────────────────────

test('重复添加 → 提示已存在，文件不动', async () => {
  const rig = await makeRig();
  try {
    const before = read(rig.configPath);
    await rig.commands.ignoreFolder(Uri.file(path.join(rig.dir, '.git')));

    assert.equal(read(rig.configPath), before);
    assert.ok(infoText().includes('已经在忽略规则里了'), `实际：${infoText()}`);
  } finally {
    rig.dispose();
  }
});

test('路径不在同步范围内 → 提示，不动配置', async () => {
  const rig = await makeRig();
  try {
    const before = read(rig.configPath);
    await rig.commands.ignoreFile(Uri.file(path.join(rig.dir, '..', '别的地方', 'x.txt')));

    assert.equal(read(rig.configPath), before);
    assert.ok(warnText().includes('不在同步范围内'), `实际：${warnText()}`);
  } finally {
    rig.dispose();
  }
});

test('没有指定路径 → 提示，不动配置', async () => {
  const rig = await makeRig();
  try {
    const before = read(rig.configPath);
    await rig.commands.ignoreFile(undefined);

    assert.equal(read(rig.configPath), before);
    assert.ok(warnText().includes('先指定一个文件'), `实际：${warnText()}`);
  } finally {
    rig.dispose();
  }
});
