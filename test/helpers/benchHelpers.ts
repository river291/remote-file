/** 性能测量用到的小工具（从 ftp.test.ts 抽出来的最小版本）。 */
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import FtpSrv from 'ftp-srv';

const REPO_ROOT = path.resolve(__dirname, '..');
const TMP_ROOT = path.join(REPO_ROOT, '.tmp-tests');

export function makeTempDir(label: string): string {
  const dir = path.join(TMP_ROOT, `${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const silentLogger = {
  info: () => undefined,
  error: () => undefined,
  warn: () => undefined,
  debug: () => undefined,
  trace: () => undefined,
  fatal: () => undefined,
  child: () => silentLogger,
};

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

export interface RunningFtp {
  port: number;
  root: string;
  stop: () => Promise<void>;
}

export async function startFtpServer(root: string): Promise<RunningFtp> {
  const port = await freePort();
  const server = new (FtpSrv as unknown as new (opts: Record<string, unknown>) => any)({
    url: `ftp://127.0.0.1:${port}`,
    pasv_url: '127.0.0.1',
    pasv_min: 40600,
    pasv_max: 40700,
    greeting: 'bench',
    anonymous: false,
    log: silentLogger,
  });
  server.on('login', ({ username, password }: { username: string; password: string }, resolve: (v: unknown) => void, reject: (e: Error) => void) => {
    if (username === 'tester' && password === 'secret') resolve({ root });
    else reject(new Error('bad'));
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
