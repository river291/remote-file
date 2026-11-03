/**
 * 打包产物冒烟测试。
 *
 * 这一步的意义：`src` 里的代码能跑，不代表 `dist/extension.js` 这个
 * 真正装进 VSCode 的单文件能跑（bundle 可能漏依赖、路径不对、顶层初始化炸掉）。
 * 这里把 dist/extension.js 用真实的 Node require 加载进来，并调用 activate()，
 * 顺便校验 package.json 里声明的每个命令都确实注册了。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import Module from 'node:module';
import * as vscodeShim from './helpers/vscodeStub';
import { __vscodeTest, createExtensionContext } from './helpers/vscodeStub';

const REPO_ROOT = path.resolve(__dirname, '..');
const BUNDLE = path.join(REPO_ROOT, 'dist', 'extension.js');

interface ExtensionModule {
  activate: (ctx: unknown) => Promise<void>;
  deactivate: () => void;
}

/** 用替身模块顶上 `require('vscode')`，然后把 bundle 加载进来。 */
function loadBundle(): ExtensionModule {
  const moduleAny = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
  const original = moduleAny._load;
  moduleAny._load = function (request: string, parent: unknown, isMain: boolean) {
    if (request === 'vscode') return vscodeShim;
    return original.call(this, request, parent, isMain);
  };
  try {
    const requireAny = require as unknown as { cache: Record<string, unknown> };
    delete requireAny.cache[BUNDLE];
    return require(BUNDLE) as ExtensionModule;
  } finally {
    moduleAny._load = original;
  }
}

test('dist/extension.js 存在且导出了 activate / deactivate', () => {
  __vscodeTest.reset();
  assert.ok(fs.existsSync(BUNDLE), '请先运行 node esbuild.mjs 生成 dist/extension.js');
  const mod = loadBundle();
  assert.equal(typeof mod.activate, 'function');
  assert.equal(typeof mod.deactivate, 'function');
});

test('activate() 能正常跑完，并且注册了 package.json 里声明的所有命令', async () => {
  __vscodeTest.reset();
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
    contributes: { commands: { command: string }[] };
  };
  const declared = pkg.contributes.commands.map((c) => c.command).sort();
  assert.ok(declared.length > 10, 'contributes.commands 看起来不对');

  // 指向一个没有配置文件的目录，走"未配置"这条最常见的启动路径
  __vscodeTest.setWorkspaceFolder(path.join(REPO_ROOT, '.tmp-tests', 'no-such-workspace'));

  const mod = loadBundle();
  const context = createExtensionContext();
  await mod.activate(context);

  const missing = declared.filter((id) => !__vscodeTest.registeredCommands().includes(id));
  assert.deepEqual(missing, [], `这些命令没有注册：${missing.join(', ')}`);

  // 内部命令（不在 package.json 里，供状态栏点击使用）
  assert.ok(__vscodeTest.registeredCommands().includes('remoteFile.showMenu'));

  // 订阅都挂上了，说明资源回收是有效的
  const subscriptions = context.subscriptions as unknown[];
  assert.ok(subscriptions.length > 10, `subscriptions 数量偏少：${subscriptions.length}`);

  // 没有配置时不应该报错，只应在日志里说明
  assert.deepEqual(__vscodeTest.errorMessages(), []);
  assert.ok(
    __vscodeTest.outputLines().some((l) => /没有找到配置文件/.test(l)),
    `日志里应该说明没有找到配置文件，实际：${__vscodeTest.outputLines().join(' | ')}`,
  );

  mod.deactivate();
});

test('菜单：按文件/目录分开显示，标签和 when 条件都对', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
    contributes: {
      commands: { command: string; title: string }[];
      menus: Record<string, { command: string; when?: string }[]>;
    };
  };

  const titles = Object.fromEntries(pkg.contributes.commands.map((c) => [c.command, c.title]));
  assert.equal(titles['remoteFile.ignoreFolder'], '忽略该目录');
  assert.equal(titles['remoteFile.ignoreFile'], '忽略该文件');
  assert.equal(titles['remoteFile.ignoreFileType'], '忽略该类型文件');
  // 旧的含糊命令应该已经没了
  assert.equal(titles['remoteFile.addIgnoreRule'], undefined, '旧的「添加到上传忽略规则」应该已被替换');

  const explorer = pkg.contributes.menus['explorer/context'];
  const find = (cmd: string) => explorer.find((i) => i.command === cmd);

  // 目录项只在目录上出现
  const folderItem = find('remoteFile.ignoreFolder');
  assert.ok(folderItem?.when?.includes('explorerResourceIsFolder'), '目录项必须要求 explorerResourceIsFolder');
  assert.ok(!folderItem?.when?.includes('!'), '目录项的 when 不该有取反（否则文件上也会出现）');

  // 文件项只在文件上出现
  for (const cmd of ['remoteFile.ignoreFile', 'remoteFile.ignoreFileType']) {
    const item = find(cmd);
    assert.ok(item?.when?.includes('!explorerResourceIsFolder'), `${cmd} 必须排除目录`);
  }
  // "该类型"还要求有扩展名（Makefile / .gitignore 不显示）
  assert.ok(
    find('remoteFile.ignoreFileType')?.when?.includes("resourceExtname != ''"),
    '「忽略该类型文件」应该只在有扩展名的文件上出现',
  );

  // 编辑器右键里不该出现"忽略该目录"（那里只会是文件）
  const editor = pkg.contributes.menus['editor/context'];
  assert.equal(
    editor.some((i) => i.command === 'remoteFile.ignoreFolder'),
    false,
    '编辑器右键里不该出现目录项',
  );
  assert.ok(editor.some((i) => i.command === 'remoteFile.ignoreFile'), '编辑器右键要有「忽略该文件」');

  // 已经被忽略的路径：不显示"忽略该项"，只显示"移除"；没被忽略时反过来。
  // 靠 setContext 发布的 remoteFile.ignoredPaths + when 子句的 in / not in 实现。
  for (const menu of ['explorer/context', 'editor/context', 'editor/title/context']) {
    const items = pkg.contributes.menus[menu];
    for (const item of items) {
      if (item.command === 'remoteFile.removeIgnoreRule') {
        assert.ok(
          item.when?.includes('resourcePath in remoteFile.ignoredPaths'),
          `${menu} 的「移除」应该只在已忽略的路径上出现，实际：${item.when}`,
        );
      } else if (item.command.startsWith('remoteFile.ignore')) {
        assert.ok(
          item.when?.includes('resourcePath not in remoteFile.ignoredPaths'),
          `${menu} 的 ${item.command} 应该在已忽略的路径上隐藏，实际：${item.when}`,
        );
      }
    }
  }
});

test('activate() 在配置文件不合法时报出可读的中文错误', async () => {
  __vscodeTest.reset();
  const workspace = path.join(REPO_ROOT, '.tmp-tests', 'bad-config-workspace');
  fs.mkdirSync(path.join(workspace, '.vscode'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.vscode', 'sftp.json'), '{ "username": "u" }', 'utf8');

  try {
    __vscodeTest.setWorkspaceFolder(workspace);
    const mod = loadBundle();
    await mod.activate(createExtensionContext());

    const errors = __vscodeTest.errorMessages();
    assert.equal(errors.length, 1, `应该有一条错误提示，实际：${JSON.stringify(errors)}`);
    assert.match(errors[0], /缺少必填项 "host"/);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
