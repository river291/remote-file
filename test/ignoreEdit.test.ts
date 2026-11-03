/**
 * 配置文件文本手术的测试。
 *
 * 这个模块要在**保留注释**的前提下增删 `ignore` 规则，所以每条用例都同时验证两件事：
 *   1. 规则确实增/删了
 *   2. 结果仍然能被解析（合法），而且**原有注释一个字都没少**
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfigObject } from '../src/core/config';
import { addIgnoreRule, listIgnoreRules, removeIgnoreRule, typeRuleFor } from '../src/core/ignoreEdit';

/** 用户真实配置的结构（密码换成占位符）。 */
const USER_JSON = `{
  // 协议：sftp / ftp / ftps
  "protocol": "ftp",
  "host": "192.0.2.10",
  "port": 21,
  "username": "deploy",
  // 密码直接写在这里的话，千万别把这个文件提交到 git
  "password": "占位符",

  // 远程根目录：本地 context 目录下的文件会对应到这里
  "remotePath": "/",
  "context": ".",

  // 保存文件时自动上传
  "uploadOnSave": true,
  "uploadOnCreate": false,
  "deleteOnLocalDelete": true,

  // FTP 传输模式：passive（被动，默认）/ active（主动）
  "ftpMode": "passive",

  // 不上传的文件/目录（glob 语法）
  "ignore": [".vscode", ".git", "node_modules", "**/*.log", ".idea"],

  // 目录映射：把本地某个子目录映射到另一个远程目录。
  "mappings": []
}
`;

function commentsOf(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('//'));
}

test('JSON：加规则 —— 规则进了数组，注释一行不少', () => {
  const result = addIgnoreRule(USER_JSON, 'json', 'storage/cache');
  assert.equal(result.outcome, 'added');

  assert.deepEqual(listIgnoreRules(result.text, 'json'), [
    '.vscode',
    '.git',
    'node_modules',
    '**/*.log',
    '.idea',
    'storage/cache',
  ]);
  // 关键：注释必须还在（这正是不能"解析再序列化"的原因）
  assert.deepEqual(commentsOf(result.text), commentsOf(USER_JSON), '注释不该有任何变化');
  // 而且仍然是合法配置
  assert.ok(parseConfigObject(result.text, 'json'));
});

test('JSON：重复加同一条 → 不动文件', () => {
  const result = addIgnoreRule(USER_JSON, 'json', '.idea');
  assert.equal(result.outcome, 'already-present');
  assert.equal(result.text, USER_JSON, '重复时文本必须原封不动');
});

test('JSON：删规则 —— 中间的、末尾的、唯一的一条', () => {
  const mid = removeIgnoreRule(USER_JSON, 'json', 'node_modules');
  assert.equal(mid.outcome, 'removed');
  assert.deepEqual(listIgnoreRules(mid.text, 'json'), ['.vscode', '.git', '**/*.log', '.idea']);
  assert.deepEqual(commentsOf(mid.text), commentsOf(USER_JSON));

  const last = removeIgnoreRule(USER_JSON, 'json', '.idea');
  assert.equal(last.outcome, 'removed');
  assert.deepEqual(listIgnoreRules(last.text, 'json'), ['.vscode', '.git', 'node_modules', '**/*.log']);
  assert.ok(parseConfigObject(last.text, 'json'));

  let only = addIgnoreRule('{ "ignore": [] }', 'json', 'x').text;
  assert.deepEqual(listIgnoreRules(only, 'json'), ['x']);
  only = removeIgnoreRule(only, 'json', 'x').text;
  assert.deepEqual(listIgnoreRules(only, 'json'), []);
  assert.ok(parseConfigObject(only, 'json'));
});

test('JSON：删不存在的规则 → 不动文件', () => {
  const result = removeIgnoreRule(USER_JSON, 'json', '不存在的规则');
  assert.equal(result.outcome, 'not-present');
  assert.equal(result.text, USER_JSON);
});

test('JSON：多行数组也接得上，缩进跟着已有元素走', () => {
  const src = ['{', '  "protocol": "ftp",', '  "ignore": [', '    ".vscode",', '    ".git"', '  ]', '}', ''].join(
    '\n',
  );
  const added = addIgnoreRule(src, 'json', 'storage/cert');
  assert.equal(added.outcome, 'added');
  assert.deepEqual(listIgnoreRules(added.text, 'json'), ['.vscode', '.git', 'storage/cert']);
  assert.ok(added.text.includes('\n    "storage/cert"'), `缩进应该对齐已有的 4 空格，实际：\n${added.text}`);

  const removed = removeIgnoreRule(added.text, 'json', '.git');
  assert.deepEqual(listIgnoreRules(removed.text, 'json'), ['.vscode', 'storage/cert']);
  assert.ok(parseConfigObject(removed.text, 'json'));
});

test('JSON：没有 ignore 字段时补一个', () => {
  const src = '{\n  // 只有这一项\n  "protocol": "ftp"\n}\n';
  const added = addIgnoreRule(src, 'json', 'logs');
  assert.equal(added.outcome, 'added');
  assert.deepEqual(listIgnoreRules(added.text, 'json'), ['logs']);
  assert.ok(added.text.includes('// 只有这一项'), '原有注释要保留');
  assert.ok(parseConfigObject(added.text, 'json'));
});

test('JSON：ignore 不是数组时拒绝动手（宁可不改，绝不追加重复键）', () => {
  const src = '{ "ignore": "不是数组" }';
  const added = addIgnoreRule(src, 'json', 'x');
  assert.equal(added.outcome, 'unsupported');
  assert.equal(added.text, src, '看不懂就别改');

  const removed = removeIgnoreRule(src, 'json', 'x');
  assert.equal(removed.outcome, 'unsupported');
  assert.equal(removed.text, src);

  // 就算字段在文件中间，也不能冒出第二个 "ignore"
  const mid = '{\n  "ignore": "字符串",\n  "protocol": "ftp"\n}\n';
  const result = addIgnoreRule(mid, 'json', 'x');
  assert.equal(result.outcome, 'unsupported');
  assert.equal((result.text.match(/"ignore"/g) ?? []).length, 1, '不允许出现重复的 ignore 键');
});

test('YAML：ignore 是标量时拒绝动手', () => {
  const src = 'protocol: ftp\nignore: "不是列表"\n';
  const result = addIgnoreRule(src, 'yaml', 'x');
  assert.equal(result.outcome, 'unsupported');
  assert.equal(result.text, src);
  assert.equal((result.text.match(/^ignore:/gm) ?? []).length, 1, '不允许出现重复的 ignore 键');
});

test('JSON：加/删往返能回到原文', () => {
  const added = addIgnoreRule(USER_JSON, 'json', 'storage/cache');
  const back = removeIgnoreRule(added.text, 'json', 'storage/cache');
  assert.equal(back.outcome, 'removed');
  assert.equal(back.text, USER_JSON, '往返之后应该和原文逐字一致');
});

// ─────────────────────────── 按类型生成规则 ───────────────────────────

test('typeRuleFor：按扩展名生成规则，没有扩展名就不生成', () => {
  assert.equal(typeRuleFor('main.go'), '**/*.go');
  assert.equal(typeRuleFor('index.ts'), '**/*.ts');
  assert.equal(typeRuleFor('backup.tar.gz'), '**/*.gz');
  assert.equal(typeRuleFor('LOGO.PNG'), '**/*.PNG');
  assert.equal(typeRuleFor('a.b.c/d/e.sql'), '**/*.sql');
  // 没有扩展名 / 点开头（整个算文件名）/ 结尾是点 → 都不该生成
  assert.equal(typeRuleFor('Makefile'), undefined);
  assert.equal(typeRuleFor('.gitignore'), undefined);
  assert.equal(typeRuleFor('.env'), undefined);
  assert.equal(typeRuleFor('weird.'), undefined);
  assert.equal(typeRuleFor(''), undefined);
});

test('typeRuleFor 生成的规则确实能匹配到任意层级的同类文件', async () => {
  const { IgnoreMatcher } = await import('../src/core/ignore');
  const rule = typeRuleFor('a/b/main.go');
  assert.equal(rule, '**/*.go');
  const matcher = new IgnoreMatcher([rule as string]);
  assert.ok(matcher.ignores('main.go'), '根目录下的 .go 也要匹配');
  assert.ok(matcher.ignores('api/admin/main.go'), '深层目录也要匹配');
  assert.ok(matcher.ignores('x/y/z/a.go'));
  assert.equal(matcher.ignores('main.txt'), false);
  assert.equal(matcher.ignores('main.go.txt'), false);
  // 大小写敏感（服务器是 Linux）
  assert.equal(matcher.ignores('main.GO'), false);
});

// ─────────────────────────── YAML ───────────────────────────

const USER_YAML = `# Remote File 配置
protocol: ftp
host: 192.0.2.10
username: deploy
password: "占位符"

# 远程根目录
remotePath: /
context: .

# 不上传的文件/目录
ignore:
  - .vscode
  - .git
  - "**/*.log"

mappings:
`;

test('YAML：块列表加规则 —— 接在最后一条后面，注释保留', () => {
  const result = addIgnoreRule(USER_YAML, 'yaml', 'storage/cache');
  assert.equal(result.outcome, 'added');
  assert.deepEqual(listIgnoreRules(result.text, 'yaml'), ['.vscode', '.git', '**/*.log', 'storage/cache']);
  assert.ok(result.text.includes('# 不上传的文件/目录'), '注释要保留');
  assert.ok(result.text.includes('  - storage/cache'), '缩进要跟着已有条目');
  // 新增的行要落在 ignore 块里，而不是跑到 mappings 后面
  const lines = result.text.split('\n');
  assert.ok(lines.indexOf('  - storage/cache') < lines.indexOf('mappings:'));
});

test('YAML：需要引号的值会自动加引号（* 开头这种）', () => {
  const result = addIgnoreRule(USER_YAML, 'yaml', '**/*.log.gz');
  assert.equal(result.outcome, 'added');
  assert.ok(result.text.includes('  - "**/*.log.gz"'), `星号开头必须加引号，实际：\n${result.text}`);
  assert.deepEqual(listIgnoreRules(result.text, 'yaml'), ['.vscode', '.git', '**/*.log', '**/*.log.gz']);
});

test('YAML：删规则', () => {
  const result = removeIgnoreRule(USER_YAML, 'yaml', '.git');
  assert.equal(result.outcome, 'removed');
  assert.deepEqual(listIgnoreRules(result.text, 'yaml'), ['.vscode', '**/*.log']);
  assert.ok(result.text.includes('  - .vscode'));
  assert.ok(!result.text.includes('- .git'));

  assert.equal(removeIgnoreRule(USER_YAML, 'yaml', '不存在').outcome, 'not-present');
  assert.equal(addIgnoreRule(USER_YAML, 'yaml', '.git').outcome, 'already-present');
});

test('YAML：没有 ignore 字段时追加到最后', () => {
  const src = '# 配置\nprotocol: ftp\n';
  const added = addIgnoreRule(src, 'yaml', 'logs');
  assert.equal(added.outcome, 'added');
  assert.deepEqual(listIgnoreRules(added.text, 'yaml'), ['logs']);
  assert.ok(added.text.includes('# 配置'));
  assert.ok(added.text.endsWith('\n'));
});

test('YAML：空列表和行内流式列表都能加', () => {
  const empty = addIgnoreRule('ignore:\nprotocol: ftp\n', 'yaml', 'logs');
  assert.equal(empty.outcome, 'added');
  assert.deepEqual(listIgnoreRules(empty.text, 'yaml'), ['logs']);
  assert.ok(parseConfigObject(empty.text, 'yaml'), `结果要能解析：\n${empty.text}`);

  const flow = addIgnoreRule('ignore: [.vscode, .git]\nprotocol: ftp\n', 'yaml', 'logs');
  assert.equal(flow.outcome, 'added');
  assert.deepEqual(listIgnoreRules(flow.text, 'yaml'), ['.vscode', '.git', 'logs']);

  const flowRemoved = removeIgnoreRule(flow.text, 'yaml', '.git');
  assert.deepEqual(listIgnoreRules(flowRemoved.text, 'yaml'), ['.vscode', 'logs']);
});
