/**
 * SFTP 客户端 —— 基于 ssh2-sftp-client（底层是 ssh2）。
 * 只做一件事：把它的 API 适配成我们统一的 RemoteClient 接口。
 */
import * as fs from 'node:fs';
import SftpClient from 'ssh2-sftp-client';
import { posixBasename, posixDirname, posixJoin, posixNormalize, isSubPath } from '../core/posixPath';
import type { RemoteClient, RemoteEntry } from '../core/types';
import { RemoteError } from '../core/types';

export interface SftpClientOptions {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKeyPath?: string;
  passphrase?: string;
  connectTimeout: number;
  log?: (message: string) => void;
}

interface SftpListEntry {
  type?: string;
  name: string;
  size?: number;
  modifyTime?: number;
  longname?: string;
}

export class SftpRemoteClient implements RemoteClient {
  private readonly opt: SftpClientOptions;
  private client?: SftpClient;
  private connecting?: Promise<void>;
  /**
   * 已经确认存在的远程目录。
   * 上传 20 个文件到同一个新目录时，如果每次都从根开始 stat 一遍，
   * 就是几十次多余的往返 —— 这里把确认过的目录记下来。
   */
  private readonly knownDirs = new Set<string>();

  constructor(options: SftpClientOptions) {
    this.opt = options;
  }

  private log(msg: string): void {
    this.opt.log?.(msg);
  }

  isConnected(): boolean {
    return !!this.client;
  }

  async connect(): Promise<void> {
    if (this.client) return;
    if (this.connecting) return this.connecting;

    this.connecting = (async () => {
      const { host, port, username, password, privateKeyPath, passphrase, connectTimeout } = this.opt;

      const config: Record<string, unknown> = {
        host,
        port,
        username,
        password,
        readyTimeout: connectTimeout,
        keepaliveInterval: 20_000,
      };
      if (passphrase) config.passphrase = passphrase;

      if (privateKeyPath) {
        try {
          config.privateKey = fs.readFileSync(privateKeyPath);
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          throw new RemoteError(`读取私钥失败：${privateKeyPath}（${detail}）`, err);
        }
      }

      const client = new SftpClient('remote-file');
      try {
        await client.connect(config);
      } catch (err) {
        // 连接失败要把底层原因带出来，否则用户只看到 "connect failed" 毫无头绪
        const detail = err instanceof Error ? err.message : String(err);
        throw new RemoteError(`SFTP 连接 ${host}:${port} 失败：${translateSftpError(detail)}`, err);
      }
      this.client = client;
      this.log(`SFTP 已连接 ${host}:${port}（用户 ${username}）`);
    })();

    try {
      await this.connecting;
    } finally {
      this.connecting = undefined;
    }
  }

  private require(): SftpClient {
    if (!this.client) throw new RemoteError('SFTP 连接已断开，请重新连接。');
    return this.client;
  }

  async list(dir: string): Promise<RemoteEntry[]> {
    const path = posixNormalize(dir);
    let raw: SftpListEntry[];
    try {
      raw = (await this.require().list(path)) as unknown as SftpListEntry[];
    } catch (err) {
      throw new RemoteError(`读取远程目录失败 ${path}：${errorText(err)}`, err);
    }
    const out: RemoteEntry[] = [];
    for (const item of raw) {
      if (!item || !item.name || item.name === '.' || item.name === '..') continue;
      out.push({
        name: item.name,
        path: posixJoin(path, item.name),
        type: toEntryType(item),
        size: typeof item.size === 'number' ? item.size : 0,
        mtime: typeof item.modifyTime === 'number' ? item.modifyTime : undefined,
      });
    }
    return out.sort((a, b) => {
      if (a.type !== b.type) {
        if (a.type === 'folder') return -1;
        if (b.type === 'folder') return 1;
      }
      return a.name.localeCompare(b.name, 'zh-Hans-CN');
    });
  }

  async stat(path: string): Promise<RemoteEntry | undefined> {
    const target = posixNormalize(path);
    try {
      const s = (await this.require().stat(target)) as unknown as {
        size?: number;
        modifyTime?: number;
        isDirectory?: boolean;
        isFile?: boolean;
        isSymbolicLink?: boolean;
      };
      if (!s) return undefined;
      return {
        name: posixBasename(target),
        path: target,
        type: s.isDirectory ? 'folder' : s.isSymbolicLink ? 'link' : 'file',
        size: typeof s.size === 'number' ? s.size : 0,
        mtime: typeof s.modifyTime === 'number' ? s.modifyTime : undefined,
      };
    } catch {
      return undefined;
    }
  }

  async readFile(path: string): Promise<Buffer> {
    const target = posixNormalize(path);
    try {
      const data = await this.require().get(target);
      if (Buffer.isBuffer(data)) return data;
      if (typeof data === 'string') return Buffer.from(data, 'utf8');
      // 流式返回：收集起来
      return await new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        const stream = data as unknown as NodeJS.ReadableStream;
        stream.on('data', (c: Buffer | string) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        stream.on('end', () => resolve(Buffer.concat(chunks)));
        stream.on('error', (err: Error) => reject(new RemoteError(`下载失败：${err.message}`, err)));
      });
    } catch (err) {
      throw new RemoteError(`读取远程文件失败 ${target}：${errorText(err)}`, err);
    }
  }

  async writeFile(path: string, data: Buffer): Promise<void> {
    const target = posixNormalize(path);
    try {
      await this.require().put(data, target);
    } catch (err) {
      throw new RemoteError(`上传失败 ${target}：${errorText(err)}`, err);
    }
  }

  async ensureDir(path: string): Promise<void> {
    const target = posixNormalize(path);
    if (target === '/' || target === '.') return;
    if (this.knownDirs.has(target)) return;

    const parts = target.split('/').filter(Boolean);
    let current = '';
    for (const part of parts) {
      current = `${current}/${part}`;
      if (this.knownDirs.has(current)) continue;
      const exists = await this.stat(current);
      if (exists?.type === 'folder') {
        this.knownDirs.add(current);
        continue;
      }
      try {
        await this.require().mkdir(current, false);
      } catch (err) {
        // 并发或已存在时忽略
        const again = await this.stat(current);
        if (again?.type !== 'folder') {
          throw new RemoteError(`创建远程目录失败 ${current}：${errorText(err)}`, err);
        }
      }
      this.knownDirs.add(current);
    }
  }

  async deleteFile(path: string): Promise<void> {
    const target = posixNormalize(path);
    try {
      await this.require().delete(target, true);
    } catch (err) {
      throw new RemoteError(`删除远程文件失败 ${target}：${errorText(err)}`, err);
    }
  }

  async removeDir(path: string): Promise<void> {
    const target = posixNormalize(path);
    try {
      await this.require().rmdir(target, true);
      this.forgetDirsUnder(target);
    } catch (err) {
      throw new RemoteError(`删除远程目录失败 ${target}：${errorText(err)}`, err);
    }
  }

  async rename(from: string, to: string): Promise<void> {
    const a = posixNormalize(from);
    const b = posixNormalize(to);
    try {
      await this.require().rename(a, b);
    } catch (err) {
      throw new RemoteError(`远程重命名失败 ${a} → ${b}：${errorText(err)}`, err);
    }
  }

  async end(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.knownDirs.clear();
    if (!client) return;
    try {
      await client.end();
    } catch {
      /* 忽略断开时的异常 */
    }
  }

  /** 目录被删掉后，它和它下面所有子目录的"已存在"记录都不再可信。 */
  private forgetDirsUnder(dir: string): void {
    for (const known of [...this.knownDirs]) {
      if (isSubPath(dir, known)) this.knownDirs.delete(known);
    }
  }
}

function toEntryType(item: SftpListEntry): RemoteEntry['type'] {
  if (item.type === 'd') return 'folder';
  if (item.type === 'l') return 'link';
  // 少数服务器 type 不标准，用 longname 首字符兜底
  const c = item.longname?.[0];
  if (c === 'd') return 'folder';
  if (c === 'l') return 'link';
  return 'file';
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 把 ssh2 的英文报错翻成人话。 */
function translateSftpError(detail: string): string {
  const map: [RegExp, string][] = [
    [/All configured authentication methods failed/i, '认证失败：用户名、密码或密钥不正确。'],
    [/Cannot parse privateKey/i, '私钥文件格式无法识别，确认是不是 OpenSSH 私钥（不是 .pub 公钥）。'],
    [/Encrypted private key detected, but no passphrase given/i, '私钥有密码保护，请在配置里填写 passphrase。'],
    [/connect ETIMEDOUT|Timed out while waiting for handshake/i, '连接超时，检查地址、端口和防火墙。'],
    [/getaddrinfo ENOTFOUND/i, '域名解析失败，检查 host 是否写对。'],
    [/ECONNREFUSED/i, '对方拒绝连接，检查端口是否正确、服务是否在运行。'],
    [/handshake failed|no matching (key exchange|host key|cipher)/i, 'SSH 握手失败，可能是服务器算法太旧或证书不兼容。'],
  ];
  for (const [re, msg] of map) {
    if (re.test(detail)) return `${msg}（原始信息：${detail}）`;
  }
  return detail;
}

export { posixDirname };
