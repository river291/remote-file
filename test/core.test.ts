/**
 * 纯逻辑单元测试：远程路径运算、忽略规则、配置解析、目录映射。
 * 这些模块不依赖 VSCode，所以可以直接跑。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { ancestors, isSubPath, posixBasename, posixDirname, posixJoin, posixNormalize, relativePosix } from '../src/core/posixPath';
import { IgnoreMatcher, globToRegExp } from '../src/core/ignore';
import { ConfigError, defaultConfigText, detectFormat, parseConfig, stripJsonComments, type ConfigDefaults } from '../src/core/config';
import { localToRemote, matchLocal, matchRemote, remoteToLocal, resolveRoots } from '../src/core/pathMap';
import type { ServerConfig } from '../src/core/types';

const WORKSPACE = process.platform === 'win32' ? 'C:\\proj' : '/proj';

function defaults(overrides: Partial<ConfigDefaults> = {}): ConfigDefaults {
  return {
    uploadOnSave: true,
    uploadOnCreate: true,
    uploadOnlyWhenChanged: true,
    deleteOnLocalDelete: false,
    connectTimeout: 20000,
    ignore: [],
    encoding: 'utf8',
    concurrency: 0,
    ftpActiveCommand: 'auto',
    ...overrides,
  };
}

function parse(raw: unknown, d: Partial<ConfigDefaults> = {}) {
  return parseConfig(JSON.stringify(raw), '/proj/.vscode/sftp.json', WORKSPACE, defaults(d));
}

// ─────────────────────────── 远程路径 ───────────────────────────

test('posixNormalize 折叠斜杠、处理 . 和 ..', () => {
  assert.equal(posixNormalize('/a/b/../c'), '/a/c');
  assert.equal(posixNormalize('a//b///c'), 'a/b/c');
  assert.equal(posixNormalize('/a/b/'), '/a/b');
  assert.equal(posixNormalize(''), '/');
  assert.equal(posixNormalize('/../..'), '/');
  assert.equal(posixNormalize('./a'), 'a');
  assert.equal(posixNormalize('/a\\b'), '/a/b');
});

test('posixJoin / posixDirname / posixBasename', () => {
  assert.equal(posixJoin('/var/www', 'html', 'index.html'), '/var/www/html/index.html');
  assert.equal(posixJoin('/var/www', '/html'), '/var/www/html');
  assert.equal(posixDirname('/var/www/index.html'), '/var/www');
  assert.equal(posixDirname('/index.html'), '/');
  assert.equal(posixBasename('/var/www/index.html'), 'index.html');
  assert.equal(posixBasename('/var/www/'), 'www');
});

test('isSubPath 与 relativePosix 不会把 /ab 误判成 /a 的子路径', () => {
  assert.equal(isSubPath('/a', '/a/b'), true);
  assert.equal(isSubPath('/a', '/ab'), false);
  assert.equal(isSubPath('/a', '/a'), true);
  assert.equal(relativePosix('/a', '/a/b/c.txt'), 'b/c.txt');
  assert.equal(relativePosix('/a', '/ab'), null);
});

test('ancestors 从最外层列到自身', () => {
  assert.deepEqual(ancestors('/a/b/c'), ['/', '/a', '/a/b', '/a/b/c']);
});

// ─────────────────────────── 忽略规则 ───────────────────────────

test('裸目录名规则会连带忽略它下面的所有内容', () => {
  const m = new IgnoreMatcher(['node_modules', '.git']);
  assert.equal(m.ignores('node_modules'), true);
  assert.equal(m.ignores('node_modules/lodash/index.js'), true);
  assert.equal(m.ignores('a/b/node_modules/x.js'), true);
  assert.equal(m.ignores('.git/config'), true);
  assert.equal(m.ignores('src/index.js'), false);
  assert.equal(m.ignores('my_node_modules_ish.js'), false);
});

test('通配符规则', () => {
  const m = new IgnoreMatcher(['**/*.log', 'dist/**', '*.tmp']);
  assert.equal(m.ignores('a/b/c.log'), true);
  assert.equal(m.ignores('c.log'), true);
  assert.equal(m.ignores('dist/bundle.js'), true);
  assert.equal(m.ignores('dist'), true);
  assert.equal(m.ignores('x.tmp'), true);
  assert.equal(m.ignores('sub/x.tmp'), true);
  assert.equal(m.ignores('src/app.ts'), false);
});

test('带斜杠的规则只从根开始匹配', () => {
  const m = new IgnoreMatcher(['/build']);
  assert.equal(m.ignores('build/out.js'), true);
  assert.equal(m.ignores('src/build/out.js'), false);
});

test('忽略规则能报出命中的那一条', () => {
  const m = new IgnoreMatcher(['.vscode', 'node_modules']);
  assert.equal(m.match('node_modules/foo/bar'), 'node_modules');
  assert.equal(m.match('src/app.ts'), null);
});

test('空规则与注释行不产生匹配', () => {
  const m = new IgnoreMatcher(['', '   ', '# comment', 'keep']);
  assert.equal(m.ignores('anything/at/all'), false);
  assert.equal(m.ignores('keep/me'), true);
  assert.equal(globToRegExp('').test('x'), false);
});

// ─────────────────────────── 配置解析 ───────────────────────────

test('去注释与尾逗号', () => {
  const text = `{
    // 这是注释
    "host": "1.2.3.4", /* 块注释 */
    "port": 22,
  }`;
  assert.deepEqual(JSON.parse(stripJsonComments(text)), { host: '1.2.3.4', port: 22 });
});

test('单服务器配置：常见别名字段都能识别', () => {
  const cfg = parse({
    host: 'example.com',
    user: 'deploy',
    password: 'pw',
    remote_path: '/srv/app',
    sftp: true,
  });
  const p = cfg.profiles[0];
  assert.equal(p.protocol, 'sftp');
  assert.equal(p.port, 22, 'sftp 默认端口应为 22');
  assert.equal(p.username, 'deploy');
  assert.equal(p.remotePath, '/srv/app');
  assert.equal(p.name, 'example.com');
});

test('FTP 默认端口 21，secure 会升级成 ftps', () => {
  const plain = parse({ host: 'h', username: 'u', protocol: 'ftp' }).profiles[0];
  assert.equal(plain.port, 21);
  assert.equal(plain.secure, false);

  const tls = parse({ host: 'h', username: 'u', protocol: 'ftp', secure: true }).profiles[0];
  assert.equal(tls.protocol, 'ftps');
  assert.equal(tls.secure, true);
});

test('passive:false 会被翻译成主动模式', () => {
  const active = parse({ host: 'h', username: 'u', passive: false }).profiles[0];
  assert.equal(active.ftpMode, 'active');
  const passive = parse({ host: 'h', username: 'u' }).profiles[0];
  assert.equal(passive.ftpMode, 'passive');
  const explicit = parse({ host: 'h', username: 'u', ftpMode: 'active' }).profiles[0];
  assert.equal(explicit.ftpMode, 'active');
});

test('全局设置作为默认值，配置文件可以覆盖', () => {
  const cfg = parse(
    { host: 'h', username: 'u', uploadOnSave: false, ignore: ['dist'] },
    { uploadOnSave: true, deleteOnLocalDelete: false, ignore: ['node_modules'] },
  );
  const p = cfg.profiles[0];
  assert.equal(p.uploadOnSave, false, '配置文件优先于全局设置');
  assert.deepEqual(p.ignore.sort(), ['dist', 'node_modules'], '两边忽略规则合并');
  assert.equal(p.deleteOnLocalDelete, false);
});

test('多服务器配置与 defaultProfile', () => {
  const cfg = parse({
    defaultProfile: '生产',
    uploadOnSave: true,
    profiles: [
      { name: '生产', host: 'prod', username: 'u', remotePath: '/prod' },
      { name: '测试', host: 'test', username: 'u', remotePath: '/test', uploadOnSave: false },
    ],
  });
  assert.equal(cfg.profiles.length, 2);
  assert.equal(cfg.defaultProfile, '生产');
  assert.equal(cfg.profiles[0].remotePath, '/prod');
  assert.equal(cfg.profiles[1].uploadOnSave, false, '顶层默认值应合并进每个 profile');
});

test('mappings 支持数组与对象两种写法', () => {
  const arr = parse({
    host: 'h',
    username: 'u',
    mappings: [{ local: 'dist', remote: '/www' }],
  }).profiles[0];
  assert.deepEqual(arr.mappings, [{ local: 'dist', remote: '/www' }]);

  const obj = parse({ host: 'h', username: 'u', mapping: { dist: '/www', 'src/assets': '/static' } }).profiles[0];
  assert.deepEqual(obj.mappings.sort((a, b) => a.local.localeCompare(b.local)), [
    { local: 'dist', remote: '/www' },
    { local: 'src/assets', remote: '/static' },
  ]);
});

test('并发数：SFTP 默认 4，FTP 默认 1，可显式覆盖且有上限', () => {
  // 不是"连接数"，是同一条连接上允许同时进行的操作数
  assert.equal(parse({ host: 'h', username: 'u', protocol: 'sftp' }).profiles[0].concurrency, 4);
  assert.equal(parse({ host: 'h', username: 'u', protocol: 'ftp' }).profiles[0].concurrency, 1);
  assert.equal(parse({ host: 'h', username: 'u', protocol: 'ftps' }).profiles[0].concurrency, 1);

  // 配置里显式写，覆盖默认
  assert.equal(parse({ host: 'h', username: 'u', protocol: 'ftp', concurrency: 3 }).profiles[0].concurrency, 3);
  // 全局设置也能提供默认值
  assert.equal(parse({ host: 'h', username: 'u', protocol: 'sftp' }, { concurrency: 8 }).profiles[0].concurrency, 8);
  // 配置优先于全局
  assert.equal(
    parse({ host: 'h', username: 'u', protocol: 'sftp', concurrency: 2 }, { concurrency: 8 }).profiles[0].concurrency,
    2,
  );

  // 非法值回落到协议默认，超大值被夹到 16
  assert.equal(parse({ host: 'h', username: 'u', protocol: 'sftp', concurrency: 0 }).profiles[0].concurrency, 4);
  assert.equal(parse({ host: 'h', username: 'u', protocol: 'sftp', concurrency: -3 }).profiles[0].concurrency, 4);
  assert.equal(parse({ host: 'h', username: 'u', protocol: 'sftp', concurrency: 999 }).profiles[0].concurrency, 16);
});

test('主动模式命令：默认 auto，可指定 port / eprt，非法值报错', () => {
  assert.equal(parse({ host: 'h', username: 'u', protocol: 'ftp' }).profiles[0].ftpActiveCommand, 'auto');
  assert.equal(
    parse({ host: 'h', username: 'u', protocol: 'ftp', ftpActiveCommand: 'port' }).profiles[0].ftpActiveCommand,
    'port',
  );
  assert.equal(
    parse({ host: 'h', username: 'u', protocol: 'ftp', activeCommand: 'EPRT' }).profiles[0].ftpActiveCommand,
    'eprt',
  );
  assert.throws(() => parse({ host: 'h', username: 'u', ftpActiveCommand: 'pasv' }), /ftpActiveCommand/);
});

test('uploadOnlyWhenChanged：默认 true，配置或全局设置都能关掉', () => {
  assert.equal(parse({ host: 'h', username: 'u' }).profiles[0].uploadOnlyWhenChanged, true);

  // 配置文件里显式关掉
  assert.equal(
    parse({ host: 'h', username: 'u', uploadOnlyWhenChanged: false }).profiles[0].uploadOnlyWhenChanged,
    false,
  );
  // 别名
  assert.equal(parse({ host: 'h', username: 'u', skipUnchanged: false }).profiles[0].uploadOnlyWhenChanged, false);
  // 全局设置兜底
  assert.equal(
    parse({ host: 'h', username: 'u' }, { uploadOnlyWhenChanged: false }).profiles[0].uploadOnlyWhenChanged,
    false,
  );
  // 配置文件优先于全局
  assert.equal(
    parse({ host: 'h', username: 'u', uploadOnlyWhenChanged: true }, { uploadOnlyWhenChanged: false }).profiles[0]
      .uploadOnlyWhenChanged,
    true,
  );
});

test('生成的配置模板能被自己的解析器吃下去，且默认值与文档一致', () => {
  const text = defaultConfigText();

  // 会改变行为的开关必须出现在模板里 —— 用户是从这里知道有这些选项的
  for (const key of [
    'uploadOnSave',
    'uploadOnCreate',
    'uploadOnlyWhenChanged',
    'deleteOnLocalDelete',
    'ftpMode',
    'ignore',
    'mappings',
  ]) {
    assert.ok(text.includes(`"${key}"`), `模板里应该有 ${key}`);
  }
  // 注释里提到的可选开关也不能少
  for (const key of ['concurrency', 'ftpActiveCommand', 'ftpsMode', 'allowUnauthorizedTls', 'encoding', 'privateKeyPath']) {
    assert.ok(text.includes(`"${key}"`), `模板里应该提到 ${key}`);
  }

  // 模板自己必须能被解析器读进去（注释、尾逗号都要处理得掉）
  const cfg = parseConfig(text, '/proj/.vscode/sftp.json', WORKSPACE, defaults());
  const p = cfg.profiles[0];
  assert.equal(p.protocol, 'sftp');
  assert.equal(p.uploadOnSave, true);
  assert.equal(p.uploadOnCreate, true);
  assert.equal(p.uploadOnlyWhenChanged, true, '模板里写出来的默认值必须和代码默认值一致');
  assert.equal(p.deleteOnLocalDelete, false);
  assert.equal(p.ftpMode, 'passive');
  assert.equal(p.context, '.');
  assert.ok(p.ignore.includes('.vscode'), '模板里的忽略规则应该带上 .vscode');
});

// ─────────────────────────── YAML 配置 ───────────────────────────

test('detectFormat：按扩展名判断格式', () => {
  assert.equal(detectFormat('/p/.vscode/sftp.yml'), 'yaml');
  assert.equal(detectFormat('/p/.vscode/sftp.yaml'), 'yaml');
  assert.equal(detectFormat('/p/.vscode/sftp.YML'), 'yaml');
  assert.equal(detectFormat('/p/.vscode/sftp.json'), 'json');
  assert.equal(detectFormat('/p/deploy.conf'), 'json');
});

test('YAML 配置：注释、行尾注释、块列表、嵌套映射都能解析', () => {
  const text = [
    '# 顶层注释',
    'protocol: sftp',
    'host: 1.2.3.4',
    'username: deploy',
    'remotePath: /srv/app   # 行尾注释',
    'uploadOnSave: false',
    'ignore:',
    '  - .vscode',
    '  - node_modules',
    '  - "**/*.log"',
    'mappings:',
    '  - local: dist',
    '    remote: /www',
  ].join('\n');

  const cfg = parseConfig(text, '/proj/.vscode/sftp.yml', WORKSPACE, defaults());
  const p = cfg.profiles[0];
  assert.equal(p.protocol, 'sftp');
  assert.equal(p.host, '1.2.3.4');
  assert.equal(p.username, 'deploy');
  assert.equal(p.remotePath, '/srv/app');
  assert.equal(p.uploadOnSave, false);
  for (const rule of ['.vscode', 'node_modules', '**/*.log']) {
    assert.ok(p.ignore.includes(rule), `忽略规则里应该有 ${rule}，实际 ${JSON.stringify(p.ignore)}`);
  }
  assert.deepEqual(p.mappings, [{ local: 'dist', remote: '/www' }]);
});

test('YAML 配置：密码不会被 YAML 的隐式类型转换坑掉', () => {
  // YAML 默认会把 123456 变成数字、yes/on 变成布尔、0x10 变成 16、09:00 变成 540，
  // 密码一旦被这么转就登不上了。插件用的是 FAILSAFE_SCHEMA，所有标量保持字符串。
  const passwords = ['123456', 'yes', 'no', 'true', 'false', 'on', 'off', '0x10', '1e5', '09:00', 'null', '~'];
  for (const pw of passwords) {
    const text = `host: h\nusername: u\npassword: ${pw}\n`;
    const cfg = parseConfig(text, '/p/.vscode/sftp.yml', WORKSPACE, defaults());
    assert.equal(typeof cfg.profiles[0].password, 'string', `密码 "${pw}" 必须保持字符串`);
    assert.equal(cfg.profiles[0].password, pw, `密码 "${pw}" 应该原样保留`);
  }

  // 数字型的端口/布尔开关仍然是字符串，解析器要能兜住
  const num = parseConfig('host: h\nusername: u\nport: 2222\nuploadOnSave: false\n', '/p/.vscode/sftp.yml', WORKSPACE, defaults());
  assert.equal(num.profiles[0].port, 2222);
  assert.equal(num.profiles[0].uploadOnSave, false);
});

test('YAML 配置：语法错误给的是可读的 YAML 报错', () => {
  assert.throws(
    () => parseConfig('host: "unterminated\n', '/p/.vscode/sftp.yml', WORKSPACE, defaults()),
    (e: unknown) => e instanceof ConfigError && /YAML/.test(e.message),
  );
});

test('两个格式的模板：都能被解析器读进去，且默认值完全一致', () => {
  const yamlText = defaultConfigText('yaml');
  const jsonText = defaultConfigText('json');

  // YAML 模板必须带 # 注释（这正是用户要它的原因）
  assert.ok(yamlText.includes('#'), 'YAML 模板应该带注释');
  for (const key of ['uploadOnlyWhenChanged', 'ftpActiveCommand', 'concurrency', 'encoding', 'mappings']) {
    assert.ok(yamlText.includes(key), `YAML 模板里应该提到 ${key}`);
  }

  const y = parseConfig(yamlText, '/p/.vscode/sftp.yml', WORKSPACE, defaults()).profiles[0];
  const j = parseConfig(jsonText, '/p/.vscode/sftp.json', WORKSPACE, defaults()).profiles[0];

  const keys = [
    'protocol',
    'host',
    'port',
    'username',
    'remotePath',
    'context',
    'uploadOnSave',
    'uploadOnCreate',
    'uploadOnlyWhenChanged',
    'deleteOnLocalDelete',
    'ftpMode',
    'concurrency',
  ] as const;
  const yRec = y as unknown as Record<string, unknown>;
  const jRec = j as unknown as Record<string, unknown>;
  for (const k of keys) {
    assert.deepEqual(yRec[k], jRec[k], `${k} 在两个模板里应该一致`);
  }
  assert.deepEqual(y.ignore, j.ignore, 'ignore 在两个模板里应该一致');
  assert.deepEqual(y.mappings, j.mappings, 'mappings 在两个模板里应该一致');
});

test('配置错误会给出中文提示', () => {
  assert.throws(() => parse({ username: 'u' }), (e: unknown) => e instanceof ConfigError && /host/.test(e.message));
  assert.throws(() => parse({ host: 'h', username: 'u', port: 'abc' }), /port/);
  assert.throws(() => parse({ host: 'h', username: 'u', protocol: 'rsync' }), /protocol/);
  assert.throws(() => parse({ host: 'h', username: 'u', ftpMode: 'turbo' }), /ftpMode/);
  assert.throws(() => parse({ host: 'h' }), /username/);
  assert.throws(() => parse({ host: 'h', username: 'u', ftpsMode: 'weird' }), /ftpsMode/);
  assert.throws(() => parse({ defaultProfile: '不存在的', profiles: [{ host: 'h', username: 'u' }] }), /不存在/);
  assert.throws(
    () => parse({ profiles: [{ name: 'a', host: 'h', username: 'u' }, { name: 'a', host: 'h2', username: 'u' }] }),
    /重名/,
  );
  assert.throws(() => parseConfig('{ 这不是 json', '/x', WORKSPACE, defaults()), /不是合法的 JSON/);
});

// ─────────────────────────── 目录映射 ───────────────────────────

function profileWith(overrides: Partial<ServerConfig>): ServerConfig {
  return {
    name: 'test',
    protocol: 'sftp',
    host: 'h',
    port: 22,
    username: 'u',
    remotePath: '/var/www',
    context: '.',
    uploadOnSave: true,
    uploadOnCreate: true,
    uploadOnlyWhenChanged: true,
    deleteOnLocalDelete: false,
    ftpMode: 'passive',
    secure: false,
    ftpsMode: 'explicit',
    encoding: 'utf8',
    allowUnauthorizedTls: false,
    connectTimeout: 20000,
    concurrency: 4,
    ftpActiveCommand: 'auto',
    ignore: [],
    mappings: [],
    raw: {},
    ...overrides,
  };
}

test('默认根：context 映射到 remotePath', () => {
  const roots = resolveRoots(WORKSPACE, profileWith({}));
  assert.equal(roots.length, 1);
  assert.equal(roots[0].localDir, path.resolve(WORKSPACE));
  assert.equal(roots[0].remoteDir, '/var/www');

  const local = path.join(WORKSPACE, 'src', 'app.js');
  assert.equal(localToRemote(roots, local), '/var/www/src/app.js');
  assert.equal(remoteToLocal(roots, '/var/www/src/app.js'), local);
});

test('context 可以是子目录', () => {
  const roots = resolveRoots(WORKSPACE, profileWith({ context: 'public', remotePath: '/html' }));
  assert.equal(localToRemote(roots, path.join(WORKSPACE, 'public', 'a.css')), '/html/a.css');
  // 不在 context 下的文件不归插件管
  assert.equal(localToRemote(roots, path.join(WORKSPACE, 'server', 'a.js')), undefined);
});

test('mappings 里更深的本地目录优先匹配', () => {
  const roots = resolveRoots(
    WORKSPACE,
    profileWith({
      context: '.',
      remotePath: '/app',
      mappings: [{ local: 'dist', remote: '/www' }, { local: 'dist/assets', remote: '/cdn' }],
    }),
  );
  assert.equal(localToRemote(roots, path.join(WORKSPACE, 'dist', 'index.html')), '/www/index.html');
  assert.equal(localToRemote(roots, path.join(WORKSPACE, 'dist', 'assets', 'a.png')), '/cdn/a.png');
  assert.equal(localToRemote(roots, path.join(WORKSPACE, 'src', 'a.ts')), '/app/src/a.ts');
});

test('远程路径反向映射：远程根更深者优先', () => {
  const roots = resolveRoots(
    WORKSPACE,
    profileWith({ context: '.', remotePath: '/app', mappings: [{ local: 'dist', remote: '/app/dist' }] }),
  );
  assert.equal(remoteToLocal(roots, '/app/dist/x.js'), path.join(WORKSPACE, 'dist', 'x.js'));
  assert.equal(remoteToLocal(roots, '/app/other/x.js'), path.join(WORKSPACE, 'other', 'x.js'));
  assert.equal(remoteToLocal(roots, '/elsewhere/x.js'), undefined);
});

test('matchLocal / matchRemote 返回相对路径', () => {
  const roots = resolveRoots(WORKSPACE, profileWith({ mappings: [{ local: 'dist', remote: '/www' }] }));
  const m = matchLocal(roots, path.join(WORKSPACE, 'dist', 'a', 'b.txt'));
  assert.equal(m?.relative, 'a/b.txt');
  assert.equal(m?.root.remoteDir, '/www');

  const r = matchRemote(roots, '/www/a/b.txt');
  assert.equal(r?.relative, 'a/b.txt');
});
