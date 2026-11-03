/**
 * FTP / FTPS 客户端的集成测试。
 *
 * 测试会在本机启动一个真实的 FTP 服务器（ftp-srv），然后让我们的客户端
 * 走完整的网络协议去连它 —— 主动模式、被动模式、显式 FTPS 各跑一遍。
 * 这样测的是真实的字节流，而不是 mock。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import FtpSrv from 'ftp-srv';
import selfsigned from 'selfsigned';
import { FtpClient } from '../src/net/ftpClient';
import { parseList, parseMlsd } from '../src/net/ftpClient';
import { startScriptedFtpServer } from './helpers/scriptedFtpServer';

const REPO_ROOT = path.resolve(__dirname, '..');
const TMP_ROOT = path.join(REPO_ROOT, '.tmp-tests');

const silentLogger = {
  info: () => undefined,
  error: () => undefined,
  warn: () => undefined,
  debug: () => undefined,
  trace: () => undefined,
  fatal: () => undefined,
  child: () => silentLogger,
};

function makeTempDir(label: string): string {
  const dir = path.join(TMP_ROOT, `${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function freePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') return reject(new Error('no port'));
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}

interface RunningFtp {
  port: number;
  root: string;
  stop: () => Promise<void>;
}

async function startFtp(root: string, tlsOptions?: { key: string; cert: string }): Promise<RunningFtp> {
  const port = await freePort();
  const server = new (FtpSrv as unknown as new (opts: Record<string, unknown>) => any)({
    url: `ftp://127.0.0.1:${port}`,
    pasv_url: '127.0.0.1',
    pasv_min: 40500,
    pasv_max: 40600,
    greeting: 'remote-file test',
    anonymous: false,
    log: silentLogger,
    ...(tlsOptions ? { tls: { key: tlsOptions.key, cert: tlsOptions.cert } } : {}),
  });

  server.on('login', ({ username, password }: { username: string; password: string }, resolve: (v: unknown) => void, reject: (e: Error) => void) => {
    if (username === 'tester' && password === 'secret') {
      resolve({ root });
    } else {
      reject(new Error('用户名或密码错误'));
    }
  });

  await server.listen();

  return {
    port,
    root,
    stop: () =>
      new Promise<void>((resolve) => {
        try {
          server.close();
        } catch {
          /* ignore */
        }
        setTimeout(resolve, 120);
      }),
  };
}

function newClient(port: number, overrides: Partial<ConstructorParameters<typeof FtpClient>[0]> = {}) {
  return new FtpClient({
    host: '127.0.0.1',
    port,
    username: 'tester',
    password: 'secret',
    secureMode: 'none',
    allowUnauthorizedTls: true,
    mode: 'passive',
    connectTimeout: 15000,
    encoding: 'utf8',
    // 排查问题时设 FTP_TRACE=1，可以看到每条命令和应答
    log: process.env.FTP_TRACE ? (m: string) => console.error('[ftp]', m) : undefined,
    ...overrides,
  });
}

/** 当前目录下这个编辑器环境可能没有稳定网络权限，所有测试都在本机回环上跑。 */
for (const mode of ['passive', 'active'] as const) {
  test(`FTP ${mode === 'passive' ? '被动' : '主动'}模式：连接、列目录、上传、下载、重命名、删除`, async () => {
    const root = makeTempDir(`ftp-${mode}`);
    const server = await startFtp(root);
    const client = newClient(server.port, { mode });

    try {
      await client.connect();
      assert.equal(client.isConnected(), true);

      // 建多级目录
      await client.ensureDir('/sub/deep');
      assert.equal(fs.existsSync(path.join(root, 'sub', 'deep')), true, '远程目录应该被真的建出来');
      // 重复调用不应报错
      await client.ensureDir('/sub/deep');

      // 上传（含中文内容与中文文件名）
      const payload = Buffer.from('你好，remote-file！\n第二行\n', 'utf8');
      await client.writeFile('/sub/deep/说明.txt', payload);
      assert.equal(fs.readFileSync(path.join(root, 'sub', 'deep', '说明.txt'), 'utf8'), payload.toString('utf8'));

      // 列根目录
      const top = await client.list('/');
      const sub = top.find((e) => e.name === 'sub');
      assert.ok(sub, `根目录里应该有 sub，实际：${JSON.stringify(top.map((e) => e.name))}`);
      assert.equal(sub?.type, 'folder');

      // 列子目录
      const deep = await client.list('/sub/deep');
      assert.deepEqual(
        deep.map((e) => e.name).sort(),
        ['说明.txt'],
      );
      assert.equal(deep[0].type, 'file');

      // 读取
      const back = await client.readFile('/sub/deep/说明.txt');
      assert.equal(back.toString('utf8'), payload.toString('utf8'));

      // stat
      const info = await client.stat('/sub/deep/说明.txt');
      assert.equal(info?.type, 'file');
      assert.equal(info?.size, payload.length);

      // 不存在的路径
      assert.equal(await client.stat('/sub/deep/nope.txt'), undefined);

      // 重命名
      await client.rename('/sub/deep/说明.txt', '/sub/deep/renamed.txt');
      assert.equal(fs.existsSync(path.join(root, 'sub', 'deep', 'renamed.txt')), true);
      assert.equal(fs.existsSync(path.join(root, 'sub', 'deep', '说明.txt')), false);

      // 删除文件
      await client.deleteFile('/sub/deep/renamed.txt');
      assert.equal(fs.existsSync(path.join(root, 'sub', 'deep', 'renamed.txt')), false);

      // 递归删除目录
      await client.writeFile('/sub/keep.txt', Buffer.from('x'));
      await client.removeDir('/sub');
      assert.equal(fs.existsSync(path.join(root, 'sub')), false, '整个目录树应该被删掉');

      await client.end();
      assert.equal(client.isConnected(), false);
    } finally {
      await client.end().catch(() => undefined);
      await server.stop();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test('FTPS 显式加密（AUTH TLS + PROT P）能完成上传下载', async () => {
  const root = makeTempDir('ftps');
  const pems = await (selfsigned as unknown as { generate: (a: unknown, o: unknown) => Promise<{ private: string; cert: string }> }).generate(
    [{ name: 'commonName', value: '127.0.0.1' }],
    { days: 2, keySize: 2048 },
  );
  const server = await startFtp(root, { key: pems.private, cert: pems.cert });
  const client = newClient(server.port, { secureMode: 'explicit' });

  try {
    await client.connect();
    await client.ensureDir('/tls');
    await client.writeFile('/tls/secret.txt', Buffer.from('加密传输的内容'));
    const text = (await client.readFile('/tls/secret.txt')).toString('utf8');
    assert.equal(text, '加密传输的内容');
    const entries = await client.list('/tls');
    assert.deepEqual(
      entries.map((e) => e.name),
      ['secret.txt'],
    );
    await client.removeDir('/tls');
    await client.end();
  } finally {
    await client.end().catch(() => undefined);
    await server.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('FTP：stat 一个文件不应该去列父目录（SIZE 一次往返就够）', async () => {
  const root = makeTempDir('ftp-stat');
  const server = await startFtp(root);

  const commands: string[] = [];
  const client = newClient(server.port, {
    log: (m: string) => {
      if (m.startsWith('> ')) commands.push(m.slice(2));
    },
  });

  try {
    await client.connect();
    await client.ensureDir('/docs');
    await client.writeFile('/docs/readme.txt', Buffer.from('hello'));

    // 列一次父目录让它自己缓存好，然后看 stat 会不会又去列
    await client.list('/docs');
    commands.length = 0;

    const info = await client.stat('/docs/readme.txt');
    assert.equal(info?.type, 'file');
    assert.equal(info?.size, 5);
    assert.ok(
      !commands.some((c) => /^(LIST|MLSD|NLST)\b/.test(c)),
      `stat 文件不该列目录，实际发了：${JSON.stringify(commands)}`,
    );

    // 目录仍然要能被正确识别（SIZE 对目录会失败，走兜底）
    const dir = await client.stat('/docs');
    assert.equal(dir?.type, 'folder');

    // 不存在的路径要返回 undefined，而不是抛错
    assert.equal(await client.stat('/docs/nope.txt'), undefined);

    await client.end();
  } finally {
    await client.end().catch(() => undefined);
    await server.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('FTP：确认过的远程目录会被记住，不重复探测（上传很多文件时的关键优化）', async () => {
  const root = makeTempDir('ftp-dircache');
  const server = await startFtp(root);

  // 记录所有发出去的命令
  const commands: string[] = [];
  const client = newClient(server.port, {
    log: (m: string) => {
      if (m.startsWith('> ')) commands.push(m.slice(2));
    },
  });

  try {
    await client.connect();
    commands.length = 0;

    // 第一次：需要逐级 CWD 探测 + MKD
    await client.ensureDir('/a/b/c');
    const first = commands.filter((c) => /^(CWD|MKD) /.test(c));
    assert.ok(first.length > 0, '第一次应该真的去探测/创建');

    // 第二次同一个目录：应该直接命中缓存，一条命令都不发
    commands.length = 0;
    await client.ensureDir('/a/b/c');
    assert.deepEqual(commands, [], `重复 ensureDir 不该再发命令，实际：${JSON.stringify(commands)}`);

    // 更深一层的子目录：只探测新增的那一段
    commands.length = 0;
    await client.ensureDir('/a/b/c/d');
    const deeper = commands.filter((c) => /^(CWD|MKD) /.test(c));
    assert.equal(deeper.length, 2, `只该探测新增的一段（CWD+MKD），实际：${JSON.stringify(deeper)}`);

    // 目录被删掉之后，缓存必须失效，否则再上传会以为目录还在
    await client.removeDir('/a');
    commands.length = 0;
    await client.ensureDir('/a/b/c');
    const afterDelete = commands.filter((c) => /^(CWD|MKD) /.test(c));
    assert.ok(afterDelete.length > 0, '目录删掉后缓存必须失效，重新创建要真的发命令');

    await client.end();
  } finally {
    await client.end().catch(() => undefined);
    await server.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('登录失败会给出可读的中文错误', async () => {
  const root = makeTempDir('ftp-badauth');
  const server = await startFtp(root);
  const client = newClient(server.port, { password: 'wrong-password' });
  try {
    await assert.rejects(
      () => client.connect(),
      (err: unknown) => err instanceof Error && /登录失败/.test(err.message),
    );
  } finally {
    await client.end().catch(() => undefined);
    await server.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ─────────────────── 复现真实服务器的不规范时序 ───────────────────

test('FTP：主动模式下数据连接卡住时，给出「改用被动模式」的提示，且不再退化成 LIST 多等一轮', async () => {
  // 复现用户日志里的场景：主动模式下服务器接受了 PORT，回了 150，
  // 然后因为 NAT 原因数据连接再也拿不到东西，也等不到结束应答。
  const server = await startScriptedFtpServer((ctx) => {
    if (/^MLSD/i.test(ctx.command)) {
      ctx.say('150 Opening data connection');
      ctx.closeData(); // 关掉数据连接但**不发 226**：客户端只能等到超时
    }
  });

  const client = newClient(server.port, { mode: 'active', connectTimeout: 700 });

  try {
    await client.connect();

    const started = Date.now();
    await assert.rejects(
      () => client.list('/resource'),
      (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        // 错误信息必须直接告诉用户怎么办，而不是只说"超时"
        assert.match(msg, /passive|被动/, `错误信息应该给出改用被动模式的建议，实际：${msg}`);
        return true;
      },
    );
    const elapsed = Date.now() - started;

    // 关键：不能退回 LIST 重来一遍，否则用户要白等两个超时周期
    assert.ok(
      !server.commands.some((c) => /^LIST/i.test(c)),
      `数据连接不通时不该退化成 LIST，实际收到的命令：${JSON.stringify(server.commands)}`,
    );
    assert.ok(server.commands.some((c) => /^MLSD/i.test(c)), '应该确实尝试过 MLSD');
    assert.ok(elapsed < 2000, `只应等一个超时周期（约 700ms），实际 ${elapsed}ms`);
  } finally {
    await client.end().catch(() => undefined);
    await server.close();
  }
});

test('FTP：服务器明确说 MLSD 不支持（5xx）时才退化成 LIST', async () => {
  const server = await startScriptedFtpServer((ctx) => {
    if (/^MLSD/i.test(ctx.command)) {
      ctx.say('504 Command not implemented for that parameter');
      return;
    }
    if (/^LIST/i.test(ctx.command)) {
      void ctx.sendData('-rw-r--r-- 1 owner group 12 Jan 1 2024 index.html\r\n');
    }
  });

  const client = newClient(server.port, { mode: 'active', connectTimeout: 2000 });

  try {
    await client.connect();
    const entries = await client.list('/');

    assert.deepEqual(
      entries.map((e) => [e.name, e.type]),
      [['index.html', 'file']],
    );
    assert.ok(server.commands.some((c) => /^MLSD/i.test(c)), '应该先试 MLSD');
    assert.ok(server.commands.some((c) => /^LIST/i.test(c)), '被拒绝后才用 LIST');
  } finally {
    await client.end().catch(() => undefined);
    await server.close();
  }
});

test('FTP：EPRT 被拒绝后回退到 PORT，并在本条连接上不再重复尝试 EPRT', async () => {
  const logs: string[] = [];
  const server = await startScriptedFtpServer((ctx) => {
    if (/^MLSD/i.test(ctx.command)) {
      void ctx.sendData('type=file;size=3;modify=20240101000000; a.txt\r\n');
    }
  });
  const client = newClient(server.port, {
    mode: 'active',
    connectTimeout: 2000,
    log: (m: string) => logs.push(m),
  });

  try {
    await client.connect();
    await client.list('/'); // 第一次：EPRT 被拒 → 回退 PORT
    await client.list('/'); // 第二次：应该直接用 PORT

    const eprtCount = server.commands.filter((c) => /^EPRT/i.test(c)).length;
    const portCount = server.commands.filter((c) => /^PORT\b/i.test(c)).length;

    assert.equal(eprtCount, 1, `EPRT 只该试一次（试过被拒就该记住），实际发了 ${eprtCount} 次`);
    assert.equal(portCount, 2, `两次传输都该走 PORT，实际发了 ${portCount} 次`);
    assert.ok(
      logs.some((l) => /不接受 EPRT/.test(l)),
      `日志里应该写清楚为什么走了 PORT，实际：${JSON.stringify(logs.filter((l) => /EPRT/.test(l)))}`,
    );
  } finally {
    await client.end().catch(() => undefined);
    await server.close();
  }
});

test('FTP：被动模式连不上服务器的数据端口时，明确指出这是服务器端的问题', async () => {
  // EPSV 报一个没人监听的端口 → 客户端连过去被拒。
  // 被动模式是客户端主动连服务器，所以连不上的责任基本都在服务器那侧。
  const server = await startScriptedFtpServer(
    (ctx) => {
      if (/^MLSD/i.test(ctx.command)) ctx.say('150 Opening data connection');
    },
    { epsvPort: 1 },
  );

  const client = newClient(server.port, { mode: 'passive', connectTimeout: 1500 });

  try {
    await client.connect();
    await assert.rejects(
      () => client.list('/'),
      (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        assert.match(msg, /被动数据端口/, `应该说明是哪个端口连不上，实际：${msg}`);
        assert.match(msg, /安全组|pasv_min_port|防火墙/, `应该指出是服务器端的放行问题，实际：${msg}`);
        return true;
      },
    );
  } finally {
    await client.end().catch(() => undefined);
    await server.close();
  }
});

test('FTP：ftpActiveCommand=port 时一条 EPRT 都不发（给老 ALG 路由器用）', async () => {
  const server = await startScriptedFtpServer((ctx) => {
    if (/^MLSD/i.test(ctx.command)) {
      void ctx.sendData('type=file;size=3;modify=20240101000000; a.txt\r\n');
    }
  });
  const client = newClient(server.port, { mode: 'active', connectTimeout: 2000, activeCommand: 'port' });

  try {
    await client.connect();
    await client.list('/');
    await client.list('/');

    assert.equal(
      server.commands.filter((c) => /^EPRT/i.test(c)).length,
      0,
      `配置成 port 就一条 EPRT 都不该发，实际：${JSON.stringify(server.commands)}`,
    );
    assert.equal(server.commands.filter((c) => /^PORT\b/i.test(c)).length, 2);
  } finally {
    await client.end().catch(() => undefined);
    await server.close();
  }
});

for (const mode of ['active', 'passive'] as const) {
  test(`FTP（${mode === 'active' ? '主动' : '被动'}）：服务器把 226 发在 150 前面也不能返回空列表`, async () => {
    // 用户的服务器就是这种时序：结束应答先到、开始应答后到。
    // 如果把它当成"开始应答"就急着收摊，目录会变成空的。
    const listing =
      'type=file;size=1;modify=20240101000000; a.txt\r\n' +
      'type=file;size=2;modify=20240101000000; b.txt\r\n' +
      'type=file;size=3;modify=20240101000000; c.txt\r\n';

    const server = await startScriptedFtpServer((ctx) => {
      if (/^MLSD/i.test(ctx.command) || /^LIST/i.test(ctx.command)) {
        ctx.say('226 3 matches total'); // 结束应答先来
        ctx.say('150 Opening data connection'); // 开始应答后到
        void ctx.writeData(listing);
      }
    });

    const client = newClient(server.port, { mode, connectTimeout: 3000 });

    try {
      await client.connect();
      const entries = await client.list('/data');
      assert.deepEqual(
        entries.map((e) => [e.name, e.size]),
        [
          ['a.txt', 1],
          ['b.txt', 2],
          ['c.txt', 3],
        ],
        `${mode} 模式下乱序应答也必须拿到真实内容，不能返回空列表`,
      );
    } finally {
      await client.end().catch(() => undefined);
      await server.close();
    }
  });
}

// ─────────────────────────── 目录列表解析 ───────────────────────────

test('MLSD 解析', () => {
  const text = [
    'type=dir;size=0;modify=20240102030405; sub',
    'type=file;size=1234;modify=20240102030405.123; report final.pdf',
    'type=cdir;modify=20240102030405; .',
    'type=pdir;modify=20240102030405; ..',
  ].join('\r\n');
  const entries = parseMlsd(text, '/docs');
  assert.equal(entries.length, 2);
  const dir = entries.find((e) => e.name === 'sub');
  assert.equal(dir?.type, 'folder');
  const file = entries.find((e) => e.name === 'report final.pdf');
  assert.equal(file?.type, 'file');
  assert.equal(file?.size, 1234);
  assert.equal(file?.path, '/docs/report final.pdf');
});

test('UNIX 风格 LIST 解析（含带空格的文件名）', () => {
  const text = [
    'total 8',
    'drwxr-xr-x    2 root     root         4096 Jan 12 10:30 public_html',
    '-rw-r--r--    1 root     root          512 Jan 12 2024 index.html',
    '-rw-r--r--    1 root     root          128 Jan 12 10:31 my report final.txt',
  ].join('\r\n');
  const entries = parseList(text, '/var/www');
  assert.deepEqual(
    entries.map((e) => [e.name, e.type]).sort(),
    [
      ['index.html', 'file'],
      ['my report final.txt', 'file'],
      ['public_html', 'folder'],
    ].sort(),
  );
  assert.equal(entries.find((e) => e.name === 'index.html')?.size, 512);
  assert.equal(entries.find((e) => e.name === 'my report final.txt')?.path, '/var/www/my report final.txt');
});

test('DOS 风格 LIST 解析', () => {
  const text = [
    '01-12-24  10:30AM       <DIR>          images',
    '01-12-24  10:31AM                 2048 logo.png',
  ].join('\r\n');
  const entries = parseList(text, '/site');
  assert.equal(entries.find((e) => e.name === 'images')?.type, 'folder');
  const png = entries.find((e) => e.name === 'logo.png');
  assert.equal(png?.type, 'file');
  assert.equal(png?.size, 2048);
});
