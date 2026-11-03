/**
 * 测试用的最小 SFTP 服务器（基于 ssh2 的 server 能力）。
 *
 * 只实现客户端实际会用到的那些 SFTP 操作，把请求映射到本机一个临时目录上。
 * 目的不是做一个完整的 SFTP 服务器，而是让集成测试真的走一遍 SSH + SFTP 协议，
 * 而不是把网络调用 mock 掉。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Server, utils, type SFTPWrapper } from 'ssh2';

const { STATUS_CODE } = utils.sftp as unknown as { STATUS_CODE: Record<string, number> };

const OPEN_MODE = {
  READ: 0x00000001,
  WRITE: 0x00000002,
  APPEND: 0x00000004,
  CREAT: 0x00000008,
  TRUNC: 0x00000010,
  EXCL: 0x00000020,
};

interface FileHandle {
  kind: 'file';
  fd: number;
  realPath: string;
}

interface DirHandle {
  kind: 'dir';
  entries: { filename: string; longname: string; attrs: Record<string, number> }[];
  pos: number;
}

type Handle = FileHandle | DirHandle;

export interface TestSftpServer {
  port: number;
  root: string;
  close: () => Promise<void>;
}

/** 主机密钥只生成一次：生成一次就够所有测试服务器用，也省掉重复生成的开销。 */
let cachedHostKey: string | undefined;
function hostKey(): string {
  if (!cachedHostKey) {
    cachedHostKey = utils.generateKeyPairSync('ed25519').private;
  }
  return cachedHostKey;
}

export async function startSftpServer(opts: { root: string; username?: string; password?: string }): Promise<TestSftpServer> {
  const root = path.resolve(opts.root);
  const username = opts.username ?? 'tester';
  const password = opts.password ?? 'secret';

  const server = new Server({ hostKeys: [hostKey()] }, (client) => {
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password' && ctx.username === username && ctx.password === password) {
        ctx.accept();
        return;
      }
      if (ctx.method === 'none') {
        ctx.reject(['password']);
        return;
      }
      ctx.reject();
    });

    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        session.on('sftp', (acceptSftp) => {
          const sftp = acceptSftp() as SFTPWrapper;
          attachSftpHandlers(sftp, root);
        });
      });
    });

    client.on('error', () => undefined);
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') return reject(new Error('无法获取端口'));
      resolve(addr.port);
    });
  });

  return {
    port,
    root,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

function attachSftpHandlers(sftp: SFTPWrapper, root: string): void {
  const handles = new Map<string, Handle>();

  const resolveVirtual = (virtual: string): string => {
    const normalized = ('/' + virtual.replace(/\\/g, '/')).replace(/\/{2,}/g, '/');
    const parts: string[] = [];
    for (const seg of normalized.split('/')) {
      if (seg === '' || seg === '.') continue;
      if (seg === '..') parts.pop();
      else parts.push(seg);
    }
    const real = path.join(root, ...parts);
    const rel = path.relative(root, real);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error('路径越界');
    }
    return real;
  };

  const virtualOf = (real: string): string => '/' + path.relative(root, real).split(path.sep).join('/');

  const attrsOf = (real: string): Record<string, number | string> => {
    const st = fs.statSync(real);
    return {
      mode: st.mode,
      uid: 0,
      gid: 0,
      size: st.size,
      atime: Math.floor(st.atimeMs / 1000),
      mtime: Math.floor(st.mtimeMs / 1000),
    };
  };

  const status = (reqid: number, code: number) => sftp.status(reqid, code);
  const ok = (reqid: number) => status(reqid, STATUS_CODE.OK);

  sftp.on('REALPATH', (reqid, givenPath) => {
    try {
      const real = resolveVirtual(givenPath);
      const virtual = virtualOf(real);
      sftp.name(reqid, [{ filename: virtual, longname: virtual, attrs: {} as never }]);
    } catch {
      status(reqid, STATUS_CODE.NO_SUCH_FILE);
    }
  });

  sftp.on('STAT', (reqid, givenPath) => {
    try {
      sftp.attrs(reqid, attrsOf(resolveVirtual(givenPath)) as never);
    } catch {
      status(reqid, STATUS_CODE.NO_SUCH_FILE);
    }
  });

  sftp.on('LSTAT', (reqid, givenPath) => {
    try {
      sftp.attrs(reqid, attrsOf(resolveVirtual(givenPath)) as never);
    } catch {
      status(reqid, STATUS_CODE.NO_SUCH_FILE);
    }
  });

  sftp.on('FSTAT', (reqid, handle) => {
    const h = handles.get(handle.toString('hex'));
    if (!h || h.kind !== 'file') return status(reqid, STATUS_CODE.FAILURE);
    try {
      sftp.attrs(reqid, attrsOf(h.realPath) as never);
    } catch {
      status(reqid, STATUS_CODE.FAILURE);
    }
  });

  sftp.on('OPENDIR', (reqid, givenPath) => {
    try {
      const real = resolveVirtual(givenPath);
      const names = fs.readdirSync(real);
      const entries = names.map((name) => {
        const child = path.join(real, name);
        const st = fs.statSync(child);
        const isDir = st.isDirectory();
        return {
          filename: name,
          longname: `${isDir ? 'drwxr-xr-x' : '-rw-r--r--'} 1 owner group ${String(st.size).padStart(8)} Jan 1 00:00 ${name}`,
          attrs: attrsOf(child) as never,
        };
      });
      const key = handleKey();
      handles.set(key, { kind: 'dir', entries, pos: 0 });
      sftp.handle(reqid, Buffer.from(key, 'hex'));
    } catch {
      status(reqid, STATUS_CODE.NO_SUCH_FILE);
    }
  });

  sftp.on('READDIR', (reqid, handle) => {
    const h = handles.get(handle.toString('hex'));
    if (!h || h.kind !== 'dir') return status(reqid, STATUS_CODE.FAILURE);
    const slice = h.entries.slice(h.pos, h.pos + 64);
    h.pos += slice.length;
    if (slice.length === 0) {
      sftp.status(reqid, STATUS_CODE.EOF);
      return;
    }
    sftp.name(reqid, slice as never);
  });

  sftp.on('OPEN', (reqid, filename, flags) => {
    try {
      const real = resolveVirtual(filename);
      // 把 SFTP 的位标志翻译成 node 的 fs 打开模式
      const wantRead = !!(flags & OPEN_MODE.READ);
      const wantWrite = !!(flags & OPEN_MODE.WRITE);
      const wantAppend = !!(flags & OPEN_MODE.APPEND);
      const wantCreate = !!(flags & OPEN_MODE.CREAT);
      let fsFlags: string;
      if (wantRead && wantWrite) fsFlags = wantCreate ? 'w+' : 'r+';
      else if (wantWrite) fsFlags = wantAppend ? 'a' : 'w';
      else fsFlags = 'r';

      const fd = fs.openSync(real, fsFlags);
      const key = handleKey();
      handles.set(key, { kind: 'file', fd, realPath: real });
      sftp.handle(reqid, Buffer.from(key, 'hex'));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code === 'ENOENT' ? STATUS_CODE.NO_SUCH_FILE : STATUS_CODE.FAILURE;
      status(reqid, code);
    }
  });

  sftp.on('READ', (reqid, handle, offset, length) => {
    const h = handles.get(handle.toString('hex'));
    if (!h || h.kind !== 'file') return status(reqid, STATUS_CODE.FAILURE);
    try {
      const buffer = Buffer.alloc(length);
      const read = fs.readSync(h.fd, buffer, 0, length, offset);
      if (read === 0) return sftp.status(reqid, STATUS_CODE.EOF);
      sftp.data(reqid, buffer.subarray(0, read));
    } catch {
      status(reqid, STATUS_CODE.FAILURE);
    }
  });

  sftp.on('WRITE', (reqid, handle, offset, data) => {
    const h = handles.get(handle.toString('hex'));
    if (!h || h.kind !== 'file') return status(reqid, STATUS_CODE.FAILURE);
    try {
      fs.writeSync(h.fd, data, 0, data.length, offset);
      ok(reqid);
    } catch {
      status(reqid, STATUS_CODE.FAILURE);
    }
  });

  sftp.on('CLOSE', (reqid, handle) => {
    const key = handle.toString('hex');
    const h = handles.get(key);
    handles.delete(key);
    if (h?.kind === 'file') {
      try {
        fs.closeSync(h.fd);
      } catch {
        /* ignore */
      }
    }
    ok(reqid);
  });

  sftp.on('REMOVE', (reqid, givenPath) => {
    try {
      fs.unlinkSync(resolveVirtual(givenPath));
      ok(reqid);
    } catch {
      status(reqid, STATUS_CODE.FAILURE);
    }
  });

  sftp.on('MKDIR', (reqid, givenPath) => {
    try {
      fs.mkdirSync(resolveVirtual(givenPath));
      ok(reqid);
    } catch {
      status(reqid, STATUS_CODE.FAILURE);
    }
  });

  sftp.on('RMDIR', (reqid, givenPath) => {
    try {
      fs.rmdirSync(resolveVirtual(givenPath));
      ok(reqid);
    } catch {
      status(reqid, STATUS_CODE.FAILURE);
    }
  });

  sftp.on('RENAME', (reqid, from, to) => {
    try {
      const src = resolveVirtual(from);
      const dst = resolveVirtual(to);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.renameSync(src, dst);
      ok(reqid);
    } catch {
      status(reqid, STATUS_CODE.FAILURE);
    }
  });

  sftp.on('SETSTAT', (reqid) => ok(reqid));
  sftp.on('FSETSTAT', (reqid) => ok(reqid));
  sftp.on('READLINK', (reqid, givenPath) => {
    try {
      const target = fs.readlinkSync(resolveVirtual(givenPath));
      sftp.name(reqid, [{ filename: target, longname: target, attrs: {} as never }]);
    } catch {
      status(reqid, STATUS_CODE.FAILURE);
    }
  });

  sftp.on('end', () => {
    for (const h of handles.values()) {
      if (h.kind === 'file') {
        try {
          fs.closeSync(h.fd);
        } catch {
          /* ignore */
        }
      }
    }
    handles.clear();
  });
}

let handleSeed = 0;
function handleKey(): string {
  handleSeed += 1;
  return handleSeed.toString(16).padStart(16, '0');
}
