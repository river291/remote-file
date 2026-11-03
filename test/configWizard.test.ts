/**
 * 配置向导的测试。
 *
 * 用户的要求：命令面板里生成配置时，**弹输入框让他选协议、端口、填用户名密码和目录**，
 * 而不是丢一个模板文件让他自己改。这个文件把整条问答流程和写出来的结果都钉住。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as vscode from 'vscode';
import { parseConfig } from '../src/core/config';
import { ConfigStore } from '../src/vscode/configStore';
import { ConfigWizard } from '../src/vscode/configWizard';
import { ConnectionManager } from '../src/vscode/connection';
import { Logger } from '../src/vscode/logger';
import { __vscodeTest, createExtensionContext } from './helpers/vscodeStub';

const REPO_ROOT = path.resolve(__dirname, '..');
const TMP_ROOT = path.join(REPO_ROOT, '.tmp-tests');

interface Rig {
  dir: string;
  configPath: string;
  config: ConfigStore;
  wizard: ConfigWizard;
  dispose: () => void;
}

async function makeRig(): Promise<Rig> {
  const dir = path.join(TMP_ROOT, `wizard-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(path.join(dir, 'app'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'public'), { recursive: true });

  __vscodeTest.reset();
  __vscodeTest.setWorkspaceFolder(dir);
  const logger = new Logger();
  const config = new ConfigStore(createExtensionContext() as unknown as vscode.ExtensionContext, logger);
  await config.refresh();

  return {
    dir,
    configPath: path.join(dir, '.vscode', 'sftp.json'),
    config,
    wizard: new ConfigWizard(config, new ConnectionManager(logger), logger),
    dispose: () => {
      config.dispose();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('向导：按顺序问出协议/主机/端口/用户名/密码/远程目录/本地目录，并写出配置', async () => {
  const rig = await makeRig();
  try {
    // 协议（QuickPick）→ 其余都是 InputBox，最后本地目录是 QuickPick
    __vscodeTest.answerQuickPicks('FTP', '.');
    __vscodeTest.answerInputs(
      '192.0.2.10', // 主机
      '21',            // 端口
      'example_com', // 用户名
      'secret-pw',     // 密码
      '/',             // 远程目录
    );

    await rig.wizard.run();

    // ① 配置真的写出来了，而且值都对
    assert.ok(fs.existsSync(rig.configPath), '应该生成 .vscode/sftp.json');
    const text = fs.readFileSync(rig.configPath, 'utf8');
    const cfg = parseConfig(text, rig.configPath, rig.dir, {
      uploadOnSave: true,
      uploadOnCreate: true,
      uploadOnlyWhenChanged: true,
      deleteOnLocalDelete: false,
      connectTimeout: 20000,
      ignore: [],
      encoding: 'utf8',
      concurrency: 0,
      ftpActiveCommand: 'auto',
    });
    const p = cfg.profiles[0];
    assert.equal(p.protocol, 'ftp');
    assert.equal(p.host, '192.0.2.10');
    assert.equal(p.port, 21);
    assert.equal(p.username, 'example_com');
    assert.equal(p.password, 'secret-pw');
    assert.equal(p.remotePath, '/');
    assert.equal(p.context, '.');

    // ② 注释和其余选项都还在（模板的价值不能丢）
    assert.ok(text.includes('// 不上传的东西') || text.includes('"ignore"'), '模板的其余内容要保留');
    assert.ok(text.includes('// ── 自动上传'), '注释要保留');

    // ③ 问的问题顺序和标题对得上
    const titles = __vscodeTest.inputBoxCalls().map((c) => c.title ?? '');
    assert.ok(titles.some((t) => t.includes('主机地址')), `应该问主机，实际：${JSON.stringify(titles)}`);
    assert.ok(titles.some((t) => t.includes('端口')), '应该问端口');
    assert.ok(titles.some((t) => t.includes('用户名')), '应该问用户名');
    assert.ok(titles.some((t) => t.includes('密码')), '应该问密码');
    assert.ok(titles.some((t) => t.includes('远程目录')), '应该问远程目录');

    // ④ 配置写完立刻生效
    assert.equal(rig.config.active?.host, '192.0.2.10');
    assert.equal(rig.config.active?.port, 21);
  } finally {
    rig.dispose();
  }
});

test('向导：端口默认值跟着协议走（选 FTP 不会给你留 22）', async () => {
  const rig = await makeRig();
  try {
    __vscodeTest.answerQuickPicks('FTP', '.');
    __vscodeTest.answerInputs('1.2.3.4', '21', 'u', '', '/');
    await rig.wizard.run();

    // 端口那一问的默认值应该是 21（FTP），不是 22
    const portCall = __vscodeTest.inputBoxCalls().find((c) => (c.title ?? '').includes('端口'));
    assert.equal(portCall?.value, '21', `FTP 的端口默认值应该是 21，实际：${portCall?.value}`);
  } finally {
    rig.dispose();
  }
});

test('向导：SFTP 的端口默认值是 22', async () => {
  const rig = await makeRig();
  try {
    __vscodeTest.answerQuickPicks('SFTP（走 SSH，推荐）', '.');
    __vscodeTest.answerInputs('1.2.3.4', '22', 'root', '', '/');
    await rig.wizard.run();

    const portCall = __vscodeTest.inputBoxCalls().find((c) => (c.title ?? '').includes('端口'));
    assert.equal(portCall?.value, '22');
    assert.equal(rig.config.active?.protocol, 'sftp');
  } finally {
    rig.dispose();
  }
});

test('向导：中途取消（按 Esc）就什么都不写', async () => {
  const rig = await makeRig();
  try {
    __vscodeTest.answerQuickPicks('FTP');
    __vscodeTest.answerInputs('1.2.3.4', '21', 'u');
    // 密码那一问不给答案 → showInputBox 返回 undefined → 取消
    await rig.wizard.run();

    assert.equal(fs.existsSync(rig.configPath), false, '取消了就不该生成任何文件');
  } finally {
    rig.dispose();
  }
});

test('向导：远程目录必须以 / 开头（校验会拦下来）', async () => {
  const rig = await makeRig();
  try {
    __vscodeTest.answerQuickPicks('FTP', '.');
    // 第 5 个答案（远程目录）给一个不合法的值 → validateInput 报错 → 返回 undefined → 取消
    __vscodeTest.answerInputs('1.2.3.4', '21', 'u', '', 'www/html');
    await rig.wizard.run();

    assert.equal(fs.existsSync(rig.configPath), false, '非法远程路径不该写出配置');
  } finally {
    rig.dispose();
  }
});

test('向导：已有配置时先确认再覆盖，不确认就不动文件', async () => {
  const rig = await makeRig();
  try {
    fs.mkdirSync(path.join(rig.dir, '.vscode'), { recursive: true });
    const before = '{\n  // 我手写的注释\n  "host": "old.example.com"\n}\n';
    fs.writeFileSync(rig.configPath, before, 'utf8');
    await rig.config.refresh();

    // modalAnswer 默认 undefined → 用户在"覆盖写入"弹窗上没点确认
    __vscodeTest.answerQuickPicks('FTP', '.');
    __vscodeTest.answerInputs('9.9.9.9', '21', 'u', '', '/');
    await rig.wizard.run();

    assert.equal(fs.readFileSync(rig.configPath, 'utf8'), before, '没确认就不该覆盖已有配置');
    assert.ok(
      __vscodeTest.warningMessages().some((m) => m.includes('已存在')),
      `应该先问一句，实际：${JSON.stringify(__vscodeTest.warningMessages())}`,
    );
  } finally {
    rig.dispose();
  }
});

test('向导：已有配置时用它的值做默认值（方便改而不是重填）', async () => {
  const rig = await makeRig();
  try {
    fs.mkdirSync(path.join(rig.dir, '.vscode'), { recursive: true });
    fs.writeFileSync(
      rig.configPath,
      '{ "protocol": "ftp", "host": "old.example.com", "port": 2121, "username": "olduser", "remotePath": "/site" }\n',
      'utf8',
    );
    await rig.config.refresh();

    __vscodeTest.answerQuickPicks('FTP', '.');
    __vscodeTest.answerInputs('old.example.com', '2121', 'olduser', '', '/site');
    await rig.wizard.run();

    const calls = __vscodeTest.inputBoxCalls();
    assert.equal(calls.find((c) => (c.title ?? '').includes('主机'))?.value, 'old.example.com');
    assert.equal(calls.find((c) => (c.title ?? '').includes('用户名'))?.value, 'olduser');
    assert.equal(calls.find((c) => (c.title ?? '').includes('远程目录'))?.value, '/site');
    // 非标准端口要保留，不能被 21/22 顶掉
    assert.equal(calls.find((c) => (c.title ?? '').includes('端口'))?.value, '2121');
  } finally {
    rig.dispose();
  }
});
