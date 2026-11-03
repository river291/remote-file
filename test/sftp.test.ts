/**
 * SFTP 客户端的集成测试。
 *
 * 本机起一个真实的 SSH/SFTP 服务器（基于 ssh2 的 server 能力），
 * 让 SftpRemoteClient 走完整的 SSH 握手 + SFTP 协议去读写文件。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SftpRemoteClient } from '../src/net/sftpClient';
import { startSftpServer, type TestSftpServer } from './helpers/sftpServer';

const REPO_ROOT = path.resolve(__dirname, '..');
const TMP_ROOT = path.join(REPO_ROOT, '.tmp-tests');

function makeTempDir(label: string): string {
  const dir = path.join(TMP_ROOT, `${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function newClient(port: number, overrides: Record<string, unknown> = {}) {
  return new SftpRemoteClient({
    host: '127.0.0.1',
    port,
    username: 'tester',
    password: 'secret',
    connectTimeout: 15000,
    ...overrides,
  });
}

test('SFTP：连接、建目录、上传、列目录、下载、重命名、删除', async () => {
  const root = makeTempDir('sftp');
  let server: TestSftpServer | undefined;
  let client: SftpRemoteClient | undefined;
  try {
    server = await startSftpServer({ root });
    client = newClient(server.port);

    await client.connect();
    assert.equal(client.isConnected(), true);

    // 多级目录
    await client.ensureDir('/a/b/c');
    assert.equal(fs.existsSync(path.join(root, 'a', 'b', 'c')), true);
    await client.ensureDir('/a/b/c'); // 重复调用不报错

    // 上传二进制内容（故意带中文和 0x00，验证不被当文本处理）
    const payload = Buffer.concat([Buffer.from('中文内容\n', 'utf8'), Buffer.from([0x00, 0x01, 0xff, 0xfe])]);
    await client.writeFile('/a/b/c/数据.bin', payload);
    assert.deepEqual(fs.readFileSync(path.join(root, 'a', 'b', 'c', '数据.bin')), payload);

    // 列目录
    const top = await client.list('/');
    const a = top.find((e) => e.name === 'a');
    assert.ok(a, `根目录应有 a，实际：${JSON.stringify(top.map((e) => e.name))}`);
    assert.equal(a?.type, 'folder');

    const entries = await client.list('/a/b/c');
    assert.deepEqual(
      entries.map((e) => e.name),
      ['数据.bin'],
    );
    assert.equal(entries[0].size, payload.length);
    assert.equal(entries[0].path, '/a/b/c/数据.bin');

    // 下载
    const back = await client.readFile('/a/b/c/数据.bin');
    assert.deepEqual(back, payload);

    // stat
    const info = await client.stat('/a/b/c/数据.bin');
    assert.equal(info?.type, 'file');
    assert.equal(info?.size, payload.length);
    assert.equal(await client.stat('/a/b/c/不存在.txt'), undefined);

    // 重命名
    await client.rename('/a/b/c/数据.bin', '/a/b/c/renamed.bin');
    assert.equal(fs.existsSync(path.join(root, 'a', 'b', 'c', 'renamed.bin')), true);

    // 删除文件
    await client.deleteFile('/a/b/c/renamed.bin');
    assert.equal(fs.existsSync(path.join(root, 'a', 'b', 'c', 'renamed.bin')), false);

    // 递归删除目录
    await client.writeFile('/a/keep.txt', Buffer.from('x'));
    await client.removeDir('/a');
    assert.equal(fs.existsSync(path.join(root, 'a')), false);

    await client.end();
    assert.equal(client.isConnected(), false);
  } finally {
    await client?.end().catch(() => undefined);
    await server?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('SFTP：上传大文件（多轮 READ/WRITE），内容一致', async () => {
  const root = makeTempDir('sftp-big');
  let server: TestSftpServer | undefined;
  let client: SftpRemoteClient | undefined;
  try {
    server = await startSftpServer({ root });
    client = newClient(server.port);
    await client.connect();

    // 1.5 MB，远超单个 SFTP 数据包，必然走多轮读写
    const size = 1_500_000;
    const payload = Buffer.alloc(size);
    for (let i = 0; i < size; i++) payload[i] = (i * 31) % 256;

    await client.writeFile('/big.bin', payload);
    const onDisk = fs.readFileSync(path.join(root, 'big.bin'));
    assert.equal(onDisk.length, size);
    assert.deepEqual(onDisk, payload);

    const back = await client.readFile('/big.bin');
    assert.equal(back.length, size);
    assert.deepEqual(back, payload);
  } finally {
    await client?.end().catch(() => undefined);
    await server?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('SFTP：认证失败给出可读的中文错误', async () => {
  const root = makeTempDir('sftp-badauth');
  let server: TestSftpServer | undefined;
  let client: SftpRemoteClient | undefined;
  try {
    server = await startSftpServer({ root });
    const bad = newClient(server.port, { password: 'wrong' });
    client = bad;
    await assert.rejects(
      () => bad.connect(),
      (err: unknown) => err instanceof Error && /SFTP 连接/.test(err.message) && /认证失败/.test(err.message),
    );
  } finally {
    await client?.end().catch(() => undefined);
    await server?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('SFTP：端口不通时不会卡死，会给出连接失败提示', async () => {
  const client = newClient(1, { connectTimeout: 3000 });
  const started = Date.now();
  await assert.rejects(
    () => client.connect(),
    (err: unknown) => err instanceof Error && /SFTP 连接/.test(err.message),
  );
  assert.ok(Date.now() - started < 10000, '应该在超时时间内失败，而不是一直挂着');
});
