/**
 * 性能测量脚本（默认跳过）。
 *
 *   REMOTE_FILE_BENCH=1 pnpm test
 *
 * 输出的是本机回环上的数字，用来把"感觉慢"变成"具体多少毫秒"。
 * 注意回环的 RTT 接近 0，真实服务器上要按往返次数乘 RTT 来估算：
 *   - SFTP 列一个目录 ≈ 2 次往返
 *   - FTP  列一个目录 ≈ 3~4 次往返（EPSV + LIST + 数据 + 226）
 */
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FtpClient } from '../src/net/ftpClient';
import { SftpRemoteClient } from '../src/net/sftpClient';
import { startSftpServer, type TestSftpServer } from './helpers/sftpServer';
import { makeTempDir, startFtpServer, type RunningFtp } from './helpers/benchHelpers';

function seedDirs(root: string, names: string[]): void {
  for (const n of names) fs.mkdirSync(path.join(root, n), { recursive: true });
}

test('BENCH', { skip: !process.env.REMOTE_FILE_BENCH }, async () => {
  const names = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8'];
  const root = makeTempDir('bench');
  seedDirs(root, names);

  // ── SFTP
  const sftp: TestSftpServer = await startSftpServer({ root });
  {
    const t0 = Date.now();
    const c = new SftpRemoteClient({
      host: '127.0.0.1',
      port: sftp.port,
      username: 'tester',
      password: 'secret',
      connectTimeout: 15000,
    });
    await c.connect();
    const connectMs = Date.now() - t0;

    await c.list('/'); // 预热
    const t1 = Date.now();
    for (let i = 0; i < 8; i++) await c.list(`/${names[i]}`);
    const serialMs = Date.now() - t1;

    await c.end();
    console.log(`\n[SFTP] 连接+登录 ${connectMs}ms`);
    console.log(`[SFTP] 串行列 8 个目录 ${serialMs}ms（单次 ${(serialMs / 8).toFixed(1)}ms）`);
  }
  await sftp.close();

  // 并发列目录：直接在一条连接上并发发起
  {
    const s2 = await startSftpServer({ root });
    const c = new SftpRemoteClient({
      host: '127.0.0.1',
      port: s2.port,
      username: 'tester',
      password: 'secret',
      connectTimeout: 15000,
    });
    await c.connect();
    await c.list('/');
    const t = Date.now();
    await Promise.all(names.map((n) => c.list(`/${n}`)));
    const parallelMs = Date.now() - t;
    console.log(`[SFTP] 并发列同样 8 个目录 ${parallelMs}ms`);
    await c.end();
    await s2.close();
  }

  // ── FTP
  const ftp: RunningFtp = await startFtpServer(root);
  {
    const t0 = Date.now();
    const c = new FtpClient({
      host: '127.0.0.1',
      port: ftp.port,
      username: 'tester',
      password: 'secret',
      secureMode: 'none',
      allowUnauthorizedTls: true,
      mode: 'passive',
      connectTimeout: 15000,
      encoding: 'utf8',
    });
    await c.connect();
    const connectMs = Date.now() - t0;

    await c.list('/');
    const t1 = Date.now();
    for (let i = 0; i < 8; i++) await c.list(`/${names[i]}`);
    const listMs = Date.now() - t1;
    console.log(`[FTP ] 连接+登录+FEAT ${connectMs}ms`);
    console.log(`[FTP ] 串行列 8 个目录 ${listMs}ms（单次 ${(listMs / 8).toFixed(1)}ms）`);

    // 目录缓存效果：连续对同一个已存在目录调用 ensureDir
    const t2 = Date.now();
    for (let i = 0; i < 50; i++) await c.ensureDir('/a/b/c');
    console.log(`[FTP ] 50 次 ensureDir 同一个目录 ${Date.now() - t2}ms（有缓存）`);

    await c.end();
  }
  await ftp.stop();

  fs.rmSync(root, { recursive: true, force: true });
});
