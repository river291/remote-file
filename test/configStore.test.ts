/**
 * 配置文件查找与语言模式的测试。
 *
 * 两件想钉住的事：
 *   1. 把 sftp.json 改名成 sftp.yml 之后，不用改任何设置就能被找到（YAML 也是）
 *   2. 打开配置文件时会被切到「带注释」的语言模式 —— .json 用 jsonc、.yml 用 yaml，
 *      这样 `//` / `#` 注释不会再被标成语法错误
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as vscode from 'vscode';
import { ConfigStore } from '../src/vscode/configStore';
import { Logger } from '../src/vscode/logger';
import { __vscodeTest, createExtensionContext, languageModes } from './helpers/vscodeStub';

const REPO_ROOT = path.resolve(__dirname, '..');
const TMP_ROOT = path.join(REPO_ROOT, '.tmp-tests');

function makeProject(label: string, files: Record<string, string>): string {
  const dir = path.join(TMP_ROOT, `${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
  return dir;
}

function makeStore(projectDir: string): { config: ConfigStore; logger: Logger } {
  __vscodeTest.reset();
  languageModes.length = 0;
  __vscodeTest.setWorkspaceFolder(projectDir);
  const logger = new Logger();
  const config = new ConfigStore(createExtensionContext() as unknown as vscode.ExtensionContext, logger);
  return { config, logger };
}

const YAML_CFG = ['# YAML 配置', 'protocol: sftp', 'host: 1.2.3.4', 'username: u', 'remotePath: /srv'].join('\n');
const JSON_CFG = ['{', '  // JSON 带注释', '  "protocol": "sftp",', '  "host": "1.2.3.4",', '  "username": "u"', '}'].join('\n');

test('配置文件：只放了 sftp.yml 时也能被找到（不用改任何设置）', async () => {
  const dir = makeProject('cfg-yaml', { '.vscode/sftp.yml': YAML_CFG });
  const { config } = makeStore(dir);
  try {
    assert.equal(await config.refresh(), true);
    assert.ok(config.configPath?.endsWith('sftp.yml'), `应该加载 yml，实际 ${config.configPath}`);
    assert.equal(config.active?.host, '1.2.3.4');
    assert.equal(config.active?.remotePath, '/srv');
  } finally {
    config.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('配置文件：json 和 yml 同时存在时，用户指定的那个（json）优先', async () => {
  const dir = makeProject('cfg-both', {
    '.vscode/sftp.json': JSON_CFG,
    '.vscode/sftp.yml': YAML_CFG.replace('1.2.3.4', '9.9.9.9'),
  });
  const { config } = makeStore(dir);
  try {
    assert.equal(await config.refresh(), true);
    assert.ok(config.configPath?.endsWith('sftp.json'));
    assert.equal(config.active?.host, '1.2.3.4', '应该用 JSON 里的值');
  } finally {
    config.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('配置文件：不改任何设置时，新项目生成的是 .vscode/sftp.json', async () => {
  const dir = makeProject('cfg-default', {});
  const { config } = makeStore(dir);
  try {
    await config.openConfig(true);

    assert.ok(
      fs.existsSync(path.join(dir, '.vscode', 'sftp.json')),
      `默认应该生成 sftp.json，实际：${JSON.stringify(fs.readdirSync(path.join(dir, '.vscode')))}`,
    );
    assert.equal(fs.existsSync(path.join(dir, '.vscode', 'sftp.yml')), false, '不该顺手生成 yml');

    const text = fs.readFileSync(path.join(dir, '.vscode', 'sftp.json'), 'utf8');
    assert.ok(text.includes('//'), 'JSON 模板里带 // 注释');
    assert.ok(text.includes('"uploadOnlyWhenChanged"'), '模板要包含会改行为的开关');

    // 关键：生成之后打开时会切成 jsonc，所以模板里的 // 注释不会被标成语法错误
    assert.equal(
      languageModes.find((m) => m.uri.endsWith('sftp.json'))?.languageId,
      'jsonc',
      '打开 json 配置应该自动切成 jsonc',
    );
  } finally {
    config.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('配置文件：设成 .yml 之后，生成模板也是 YAML，而且带注释', async () => {
  const dir = makeProject('cfg-init', {});
  const { config } = makeStore(dir);
  __vscodeTest.setSetting('configFile', '.vscode/sftp.yml');
  try {
    await config.openConfig(true);
    const target = path.join(dir, '.vscode', 'sftp.yml');
    assert.ok(fs.existsSync(target), `应该生成 sftp.yml，实际目录：${JSON.stringify(fs.readdirSync(path.join(dir, '.vscode')))}`);
    const text = fs.readFileSync(target, 'utf8');
    assert.ok(text.includes('#'), 'YAML 模板应该带 # 注释');
    assert.ok(/^host:/m.test(text), 'YAML 模板应该是 key: value 形式而不是 JSON');
  } finally {
    config.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('语言模式：打开 .json 配置切成 jsonc，打开 .yml 配置切成 yaml', async () => {
  const dir = makeProject('cfg-lang', {
    '.vscode/sftp.json': JSON_CFG,
    '.vscode/sftp.yml': YAML_CFG,
  });
  const { config } = makeStore(dir);
  try {
    await config.refresh();

    // openConfig 内部就会顺手把语言模式切好 —— 这是 // 注释不再报错的关键
    await config.openConfig(false);
    assert.deepEqual(
      languageModes.map((m) => [path.basename(m.uri), m.languageId]),
      [['sftp.json', 'jsonc']],
      '打开 json 配置时应该切成 jsonc',
    );

    // yml 走 yaml
    const yamlDoc = { uri: { fsPath: path.join(dir, '.vscode', 'sftp.yml') }, languageId: 'plaintext' };
    await config.fixLanguageMode(yamlDoc as unknown as vscode.TextDocument);
    assert.equal(
      languageModes.find((m) => m.uri.endsWith('.yml'))?.languageId,
      'yaml',
      'yml 配置应该被切成 yaml',
    );

    // 已经是目标语言模式时不该重复设置
    const before = languageModes.length;
    await config.fixLanguageMode(yamlDoc as unknown as vscode.TextDocument);
    assert.equal(languageModes.length, before, '已经是 yaml 就不该再设置一次');
  } finally {
    config.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('配置文件自己（json 和 yml）都不会被上传', async () => {
  const dir = makeProject('cfg-ignore', {
    '.vscode/sftp.json': JSON_CFG,
    '.vscode/sftp.yml': YAML_CFG,
  });
  const { config } = makeStore(dir);
  try {
    await config.refresh();
    assert.equal(config.isConfigFile(path.join(dir, '.vscode', 'sftp.json')), true);
    assert.equal(config.isConfigFile(path.join(dir, '.vscode', 'sftp.yml')), true);
    assert.equal(config.isConfigFile(path.join(dir, 'main.go')), false);
  } finally {
    config.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
