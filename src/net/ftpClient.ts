/**
 * 自己实现的 FTP / FTPS 客户端。
 *
 * 为什么不用现成的库：npm 上没有一个"既支持主动模式又支持 FTPS 且还在维护"的
 * FTP 客户端（basic-ftp 只有被动模式，node-ftp 停在 2015 年）。这里按 RFC 959、
 * 2389(EPRT/EPSV)、3659(MLSD/MLST)、4217(AUTH TLS) 实现，主被动都覆盖。
 */
import net from 'node:net';
import tls from 'node:tls';
import iconv from 'iconv-lite';
import { posixBasename, posixDirname, posixJoin, posixNormalize, isSubPath } from '../core/posixPath';
import type { RemoteClient, RemoteEntry } from '../core/types';
import { RemoteError } from '../core/types';

export interface FtpClientOptions {
  host: string;
  port: number;
  username: string;
  password?: string;
  /** 'none' | 'explicit'（AUTH TLS，默认，端口 21） | 'implicit'（端口 990） */
  secureMode: 'none' | 'explicit' | 'implicit';
  allowUnauthorizedTls: boolean;
  mode: 'passive' | 'active';
  /** 主动模式下用哪条命令告知回连地址；默认 auto（先 EPRT，不行再 PORT）。 */
  activeCommand?: 'auto' | 'port' | 'eprt';
  connectTimeout: number;
  /** 目录名编码，遇到中文乱码的服务器可设成 gbk。 */
  encoding: string;
  /** 是否相信 PASV 返回的地址（默认用控制连接的对端地址，更可靠）。 */
  trustPasvHost?: boolean;
  log?: (message: string) => void;
}

interface FtpReply {
  code: number;
  text: string;
  lines: string[];
}

/**
 * 服务器用应答码明确拒绝了某个命令（4xx/5xx）。
 *
 * 和"超时/连接断了"区分开很重要：只有"命令不被支持/不被允许"才值得换一种命令重试，
 * 数据连接超时再换命令重试一次，只会让用户多等一个超时周期。
 */
export class FtpReplyError extends RemoteError {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
    this.name = 'FtpReplyError';
  }
}

interface DataChannel {
  /** 数据连接建立后的 socket。 */
  socket: Promise<net.Socket>;
  /** 放弃这次传输（关闭监听/连接）。 */
  abort: () => void;
}

const CRLF = '\r\n';
/** 传输过程中允许的最长空闲时间。 */
const TRANSFER_IDLE_MS = 60_000;

export class FtpClient implements RemoteClient {
  private readonly opt: FtpClientOptions;
  private socket?: net.Socket;
  private rawBuffer = Buffer.alloc(0);
  private replyResolvers: { resolve: (r: FtpReply) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }[] = [];
  /**
   * 比等待者更早到达的应答。
   *
   * 服务器偶尔会把应答发早（比如 226 抢在 150 前面），或者在上一条命令的等待者
   * 已经出队、下一条命令还没登记的缝隙里发过来。直接丢掉它会让后面所有应答错位，
   * 最后卡到超时 —— 所以先存下来，交给下一个等待者。
   */
  private orphanReplies: FtpReply[] = [];
  private multiline: string[] | null = null;
  private multilineCode = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private inSerialized = false;
  private closed = false;
  private connected = false;
  private features = new Set<string>();
  private supportsMlsd = false;
  private supportsMlst = false;
  private utf8 = false;
  private keepalive?: NodeJS.Timeout;
  private lastActivity = 0;
  /** 已经确认存在的远程目录，避免每个文件都把父目录逐级探测一遍。 */
  private readonly knownDirs = new Set<string>();
  /** 这台服务器收不收 EPRT。undefined = 还没试过；false = 试过被拒，后面直接用 PORT。 */
  private eprtWorks: boolean | undefined;

  constructor(options: FtpClientOptions) {
    this.opt = options;
  }

  private log(msg: string): void {
    this.opt.log?.(msg);
  }

  /** 出站命令的编码：服务器声明 UTF8 时用 utf8，否则用配置的编码。 */
  private encode(text: string): Buffer {
    const enc = this.utf8 ? 'utf8' : this.opt.encoding;
    try {
      return iconv.encode(text, enc);
    } catch {
      return Buffer.from(text, 'utf8');
    }
  }

  private decode(buf: Buffer): string {
    const enc = this.utf8 ? 'utf8' : this.opt.encoding;
    try {
      return iconv.decode(buf, enc);
    } catch {
      return buf.toString('utf8');
    }
  }

  isConnected(): boolean {
    return this.connected && !this.closed && !!this.socket && !this.socket.destroyed;
  }

  // ─────────────────────────── 连接与握手 ───────────────────────────

  async connect(): Promise<void> {
    if (this.isConnected()) return;
    this.closed = false;
    this.orphanReplies.length = 0;
    this.eprtWorks = undefined;
    const { host, port, secureMode, connectTimeout } = this.opt;

    const greeting = await new Promise<FtpReply>((resolve, reject) => {
      const onError = (err: Error) => {
        cleanup();
        reject(new RemoteError(`连接 ${host}:${port} 失败：${err.message}`, err));
      };
      const cleanup = () => {
        socket.removeListener('error', onError);
      };

      let socket: net.Socket;
      if (secureMode === 'implicit') {
        socket = tls.connect({
          host,
          port,
          servername: host,
          rejectUnauthorized: !this.opt.allowUnauthorizedTls,
          timeout: connectTimeout,
        });
      } else {
        socket = net.connect({ host, port });
      }
      this.socket = socket;
      socket.setTimeout(0);
      socket.setNoDelay(true);

      const onReady = () => {
        this.attachSocket(socket);
        this.waitReply(connectTimeout).then(
          (r) => {
            cleanup();
            resolve(r);
          },
          (e) => {
            cleanup();
            reject(e);
          },
        );
      };

      if (secureMode === 'implicit') {
        (socket as tls.TLSSocket).once('secureConnect', onReady);
      } else {
        socket.once('connect', onReady);
      }
      socket.once('error', onError);
      socket.once('timeout', () => onError(new Error('连接超时')));
    });

    if (greeting.code >= 400) {
      throw new RemoteError(`服务器拒绝连接：${greeting.text}`);
    }

    // 显式 FTPS：先 AUTH TLS，再把控制连接升级成 TLS
    if (secureMode === 'explicit') {
      const auth = await this.command('AUTH TLS');
      if (auth.code >= 400) {
        throw new RemoteError(`服务器不支持 FTPS（AUTH TLS 被拒绝）：${auth.text}`);
      }
      await this.upgradeControlToTls();
    }

    const user = await this.command(`USER ${this.opt.username}`);
    if (user.code === 331 || user.code === 332) {
      const pass = await this.command(`PASS ${this.opt.password ?? ''}`);
      if (pass.code >= 400) {
        throw new RemoteError(`登录失败：用户名或密码不正确（${pass.text}）`);
      }
    } else if (user.code >= 400) {
      // 有些服务器在需要密码时返回 530，这时再试一次 PASS
      if (/login|password|user/i.test(user.text)) {
        const pass = await this.command(`PASS ${this.opt.password ?? ''}`);
        if (pass.code >= 400) {
          throw new RemoteError(`登录失败：用户名或密码不正确（${pass.text}）`);
        }
      } else {
        throw new RemoteError(`登录失败：${user.text}`);
      }
    }

    // TLS 保护级别：只保护控制通道是不够的，数据通道也要 PROT P
    if (secureMode !== 'none') {
      await this.command('PBSZ 0');
      const prot = await this.command('PROT P');
      if (prot.code >= 400) {
        throw new RemoteError(`无法开启数据通道加密（PROT P 被拒绝）：${prot.text}`);
      }
    }

    await this.detectFeatures();
    await this.command('TYPE I');

    this.connected = true;
    this.startKeepalive();
    this.log(`FTP 已连接 ${this.opt.host}:${this.opt.port}（${this.opt.mode === 'active' ? '主动' : '被动'}模式${this.opt.secureMode !== 'none' ? '，TLS 加密' : ''}）`);
  }

  /** 显式 FTPS：把已有的 TCP 控制连接升级为 TLS。 */
  private upgradeControlToTls(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const raw = this.socket;
      if (!raw) return reject(new RemoteError('控制连接已断开'));
      raw.removeAllListeners('data');
      raw.removeAllListeners('close');
      raw.removeAllListeners('error');

      const secured = tls.connect({
        socket: raw,
        servername: this.opt.host,
        rejectUnauthorized: !this.opt.allowUnauthorizedTls,
      });
      secured.once('secureConnect', () => {
        this.socket = secured;
        this.attachSocket(secured);
        resolve();
      });
      secured.once('error', (err) => {
        reject(new RemoteError(`TLS 握手失败：${err.message}`, err));
      });
    });
  }

  /** 读取 FEAT 结果，决定用 MLSD 还是 LIST、是否 UTF8。 */
  private async detectFeatures(): Promise<void> {
    try {
      const feat = await this.command('FEAT');
      this.features.clear();
      for (const line of feat.lines) {
        const t = line.trim().replace(/^\d{3}[-\s]?/, '').trim();
        if (t) this.features.add(t.toUpperCase());
      }
      this.supportsMlsd = [...this.features].some((f) => f === 'MLSD' || f.startsWith('MLSD'));
      this.supportsMlst = [...this.features].some((f) => f === 'MLST' || f.startsWith('MLST'));
      this.utf8 = [...this.features].some((f) => f === 'UTF8' || f.startsWith('UTF8'));
    } catch {
      this.features.clear();
      this.supportsMlsd = false;
      this.supportsMlst = false;
      this.utf8 = false;
    }
  }

  private startKeepalive(): void {
    this.stopKeepalive();
    this.lastActivity = Date.now();
    this.keepalive = setInterval(() => {
      if (!this.isConnected()) return;
      if (Date.now() - this.lastActivity < 60_000) return;
      this.command('NOOP').catch(() => undefined);
    }, 30_000);
    this.keepalive.unref?.();
  }

  private stopKeepalive(): void {
    if (this.keepalive) clearInterval(this.keepalive);
    this.keepalive = undefined;
  }

  // ─────────────────────────── 控制通道 ───────────────────────────

  private attachSocket(socket: net.Socket): void {
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('error', (err) => this.failAll(new RemoteError(`连接中断：${err.message}`, err)));
    socket.on('close', () => {
      this.connected = false;
      this.failAll(new RemoteError('服务器关闭了连接。'));
    });
  }

  private onData(chunk: Buffer): void {
    this.rawBuffer = Buffer.concat([this.rawBuffer, chunk]);
    let idx: number;
    while ((idx = this.rawBuffer.indexOf(CRLF)) >= 0) {
      const line = this.rawBuffer.subarray(0, idx);
      this.rawBuffer = this.rawBuffer.subarray(idx + CRLF.length);
      this.handleLine(this.decode(line));
    }
    // 少数服务器只用 \n 结尾
    while ((idx = this.rawBuffer.indexOf(0x0a)) >= 0) {
      const line = this.rawBuffer.subarray(0, idx);
      this.rawBuffer = this.rawBuffer.subarray(idx + 1);
      this.handleLine(this.decode(line));
    }
  }

  private handleLine(line: string): void {
    const trimmed = line.replace(/\r$/, '');
    if (this.multiline) {
      this.multiline.push(trimmed);
      const m = /^(\d{3}) /.exec(trimmed);
      if (m && Number(m[1]) === this.multilineCode) {
        const reply: FtpReply = {
          code: this.multilineCode,
          lines: this.multiline,
          text: this.multiline.join('\n'),
        };
        this.multiline = null;
        this.resolveNext(reply);
      }
      return;
    }
    const m = /^(\d{3})([ -]?)(.*)$/.exec(trimmed);
    if (!m) {
      // 不是标准应答行，忽略（有些服务器会插入横幅文本）
      return;
    }
    const code = Number(m[1]);
    const sep = m[2];
    const rest = m[3];
    if (sep === '-') {
      this.multiline = [trimmed];
      this.multilineCode = code;
      return;
    }
    this.resolveNext({ code, lines: [trimmed], text: rest });
  }

  private resolveNext(reply: FtpReply): void {
    const waiter = this.replyResolvers.shift();
    if (!waiter) {
      // 先存着，交给下一个等待者；否则整条应答流会错位到超时
      this.orphanReplies.push(reply);
      if (this.orphanReplies.length > 8) this.orphanReplies.shift();
      this.log(`收到提前到达的应答，先留着：${reply.code} ${reply.text.split('\n').pop() ?? ''}`);
      return;
    }
    clearTimeout(waiter.timer);
    waiter.resolve(reply);
  }

  private failAll(err: Error): void {
    const waiters = this.replyResolvers;
    this.replyResolvers = [];
    for (const w of waiters) {
      clearTimeout(w.timer);
      w.reject(err);
    }
  }

  /** 等待下一个应答（不发送命令）。 */
  private waitReply(timeoutMs = this.opt.connectTimeout): Promise<FtpReply> {
    const orphan = this.orphanReplies.shift();
    if (orphan) return Promise.resolve(orphan);
    return new Promise<FtpReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.replyResolvers.findIndex((w) => w.timer === timer);
        if (i >= 0) this.replyResolvers.splice(i, 1);
        reject(new RemoteError(`等待服务器应答超时（${timeoutMs}ms）。`));
      }, timeoutMs);
      timer.unref?.();
      this.replyResolvers.push({ resolve, reject, timer });
    });
  }

  private writeRaw(text: string): void {
    if (!this.socket || this.socket.destroyed) {
      throw new RemoteError('连接已断开。');
    }
    this.lastActivity = Date.now();
    this.socket.write(this.encode(text + CRLF));
  }

  /**
   * 把操作串行化，避免并发命令在控制通道上交错。
   *
   * 注意这里是可重入的：一次传输（transferDownload/transferUpload）本身要占用
   * 控制通道跑好几条命令，它在串行区里还会调 command()。如果不做重入判断，
   * 内层 command() 会排到自己后面去，直接死锁。
   */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    if (this.inSerialized) return fn();
    const run = this.queue.then(
      () => this.runExclusive(fn),
      () => this.runExclusive(fn),
    );
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    this.inSerialized = true;
    try {
      return await fn();
    } finally {
      this.inSerialized = false;
    }
  }

  /** 发送命令并等待应答。 */
  private command(cmd: string, timeoutMs = this.opt.connectTimeout): Promise<FtpReply> {
    return this.serialize(async () => {
      // 命令文本里可能带密码，日志里做脱敏
      this.log(`> ${redact(cmd)}`);
      const waiter = this.waitReply(timeoutMs);
      this.writeRaw(cmd);
      const reply = await waiter;
      this.log(`< ${reply.code} ${reply.text.split('\n').pop() ?? ''}`);
      return reply;
    });
  }

  private async commandExpect(cmd: string, okCodes: number[]): Promise<FtpReply> {
    const reply = await this.command(cmd);
    if (!okCodes.includes(reply.code)) {
      throw new RemoteError(`远程操作失败：${redact(cmd)} → ${reply.text}`);
    }
    return reply;
  }

  // ─────────────────────────── 数据连接 ───────────────────────────

  /** 准备好数据连接：被动模式现在就连，主动模式现在开始监听。 */
  private async beginDataChannel(): Promise<DataChannel> {
    if (!this.socket) throw new RemoteError('连接已断开。');
    const controlLocal = this.socket.localAddress;
    const controlRemote = this.socket.remoteAddress ?? this.opt.host;

    if (this.opt.mode === 'passive') {
      let host = controlRemote;
      let port = 0;
      try {
        const epsv = await this.command('EPSV');
        const m = /\((.)\1\1(\d+)\1\)/.exec(epsv.text);
        if (epsv.code === 229 && m) {
          port = Number(m[2]);
        } else {
          throw new Error('EPSV 不可用');
        }
      } catch {
        const pasv = await this.command('PASV');
        const m = /\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)/.exec(pasv.text);
        if (pasv.code !== 227 || !m) {
          throw new RemoteError(`无法进入被动模式：${pasv.text}`);
        }
        const reported = `${m[1]}.${m[2]}.${m[3]}.${m[4]}`;
        if (this.opt.trustPasvHost && reported !== '0.0.0.0') host = reported;
        port = Number(m[5]) * 256 + Number(m[6]);
      }
      if (!port) throw new RemoteError('服务器没有返回有效的被动模式端口。');

      const raw = await new Promise<net.Socket>((resolve, reject) => {
        const s = net.connect({ host, port });
        let settled = false;
        const onErr = (err: Error) => {
          finish(new RemoteError(this.passiveConnectHint(host, port, err.message), err));
        };
        const timer = setTimeout(() => {
          finish(new RemoteError(this.passiveConnectHint(host, port, `等了 ${this.opt.connectTimeout}ms 没有响应`)));
        }, this.opt.connectTimeout);
        timer.unref?.();
        const finish = (err?: Error, sock?: net.Socket) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          s.removeListener('error', onErr);
          if (err) {
            s.destroy();
            reject(err);
          } else if (sock) {
            resolve(sock);
          }
        };
        s.once('error', onErr);
        s.once('connect', () => finish(undefined, s));
      });
      const secured = await this.secureDataSocket(raw);
      return {
        socket: Promise.resolve(secured),
        abort: () => raw.destroy(),
      };
    }

    // 主动模式：本地开一个临时端口，把地址告诉服务器
    const server = net.createServer();
    const port: number = await new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, controlLocal, () => {
        const addr = server.address();
        if (!addr || typeof addr === 'string') return reject(new RemoteError('无法分配本地端口。'));
        resolve(addr.port);
      });
    });

    // ⚠️ 顺序很重要：**先挂上 connection 监听，再发 EPRT/PORT**。
    // 服务器回连经常比命令的应答还快，如果监听挂晚了，这个连接会被直接丢掉，
    // 然后一路干等到超时 —— 表现就是"有时能列、有时卡死"。
    const listenedAt = Date.now();
    const socketPromise = new Promise<net.Socket>((resolve, reject) => {
      const timer = setTimeout(() => {
        server.close();
        this.log(
          `⚠ 等待服务器回连 ${controlLocal}:${port} 超时（${this.opt.connectTimeout}ms）—— 服务器没能连回你的机器。`,
        );
        reject(new RemoteError(`服务器没有回连到 ${controlLocal}:${port}（主动模式）。${this.activeHint()}`, undefined));
      }, this.opt.connectTimeout);
      timer.unref?.();
      server.once('connection', (s) => {
        clearTimeout(timer);
        this.log(
          `服务器已回连 ${s.remoteAddress}:${s.remotePort} ← 本机 ${controlLocal}:${port}（PORT 发出后 ${Date.now() - listenedAt}ms）`,
        );
        s.setNoDelay(true);
        this.secureDataSocket(s).then(resolve, reject);
      });
    });

    try {
      await this.announceActivePort(controlLocal, port);
    } catch (err) {
      // socketPromise 可能是"永远不会有人接"的状态，先吞掉它，避免 unhandled rejection
      socketPromise.catch(() => undefined);
      server.close();
      throw err;
    }

    return {
      socket: socketPromise,
      abort: () => {
        server.close();
      },
    };
  }

  /** 把主动模式的回连地址告诉服务器：优先 EPRT，不行再用 PORT，并记住结论。 */
  private async announceActivePort(controlLocal: string | undefined, port: number): Promise<void> {
    const isV6 = !!controlLocal && controlLocal.includes(':');
    const [a, b, c, d] = String(controlLocal ?? '').split('.');
    const p1 = Math.floor(port / 256);
    const p2 = port % 256;

    const sendPort = async (): Promise<void> => {
      if (isV6) {
        throw new RemoteError('主动模式在 IPv6 下不被支持，请改用被动模式。');
      }
      const reply = await this.command(`PORT ${a},${b},${c},${d},${p1},${p2}`);
      if (reply.code >= 400) {
        throw new RemoteError(`服务器拒绝了主动模式（PORT）：${reply.text}${this.activeHint()}`, undefined);
      }
    };

    // 用户明确指定只用 PORT 时，直接跳过 EPRT。
    // 老路由器的 FTP ALG 常常只认 PORT，会把它和 EPRT 混着改错地址。
    const preference = this.opt.activeCommand ?? 'auto';
    if (preference === 'port') {
      await sendPort();
      return;
    }
    if (preference === 'eprt') {
      if (isV6) {
        throw new RemoteError('主动模式在 IPv6 下不被支持，请改用被动模式。');
      }
      const reply = await this.command(`EPRT |1|${controlLocal}|${port}|`);
      if (reply.code >= 400) {
        throw new RemoteError(`服务器拒绝了主动模式（EPRT）：${reply.text}${this.activeHint()}`, undefined);
      }
      this.eprtWorks = true;
      return;
    }

    // 这条连接上已经确认过服务器不收 EPRT，就别再浪费一次往返了
    // （少发一条命令，也少给路由器那个 FTP ALG 一次混淆的机会）
    if (this.eprtWorks === false) {
      await sendPort();
      return;
    }

    const eprtCmd = isV6 ? `EPRT |2|${controlLocal}|${port}|` : `EPRT |1|${controlLocal}|${port}|`;
    const eprtReply = await this.command(eprtCmd).catch(() => null);
    if (eprtReply && eprtReply.code < 400) {
      this.eprtWorks = true;
      return;
    }

    this.eprtWorks = false;
    this.log(`服务器不接受 EPRT（${eprtReply?.text ?? '无应答'}），改用 PORT；本条连接上不再尝试 EPRT。`);
    if (eprtReply && /only to|won't open a connection/i.test(eprtReply.text)) {
      this.log(
        '⚠ 服务器以"回连地址对不上"为由拒绝了主动模式：你发出的地址和服务器看到的来源地址不一致，' +
          '这通常说明你在 NAT / 运营商网关（CGNAT）后面。主动模式在这种网络下会时通时不通，' +
          '建议把配置里的 ftpMode 改成 "passive"（同时需要服务器放行被动端口范围）。',
      );
    }
    await sendPort();
  }

  /** 主动模式失败时的通用建议。 */
  private activeHint(): string {
    return ' 主动模式要求服务器反过来连你的机器，在 NAT / 运营商网关（CGNAT）后面常常连不回来。建议把配置里的 ftpMode 改成 "passive"。';
  }

  /** FTPS 的数据通道也要加密；复用控制连接的 TLS 会话以兼容要求会话复用的服务器。 */
  private secureDataSocket(raw: net.Socket): Promise<net.Socket> {
    if (this.opt.secureMode === 'none') return Promise.resolve(raw);
    return new Promise<net.Socket>((resolve, reject) => {
      const control = this.socket as tls.TLSSocket | undefined;
      const session = control && 'getSession' in control ? control.getSession() : undefined;
      const secured = tls.connect({
        socket: raw,
        servername: this.opt.host,
        rejectUnauthorized: !this.opt.allowUnauthorizedTls,
        session,
      });
      secured.once('secureConnect', () => resolve(secured));
      secured.once('error', (err) => {
        raw.destroy();
        reject(new RemoteError(`数据通道 TLS 握手失败：${err.message}`, err));
      });
    });
  }

  /** 读干一个数据 socket。 */
  private collectData(socket: net.Socket): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let timer: NodeJS.Timeout | undefined;
      const arm = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          socket.destroy();
          reject(new RemoteError('数据传输超时。'));
        }, TRANSFER_IDLE_MS);
        timer.unref?.();
      };
      arm();
      socket.on('data', (c: Buffer) => {
        chunks.push(c);
        arm();
      });
      socket.once('end', () => {
        if (timer) clearTimeout(timer);
        resolve(Buffer.concat(chunks));
      });
      socket.once('error', (err) => {
        if (timer) clearTimeout(timer);
        reject(new RemoteError(`数据传输失败：${err.message}`, err));
      });
      socket.once('close', () => {
        if (timer) clearTimeout(timer);
        resolve(Buffer.concat(chunks));
      });
    });
  }

  /**
   * 被动模式下连不上服务器的数据端口时，说清楚这是**服务器端**的问题。
   *
   * 被动模式是"客户端主动去连服务器"，方向和你上网一致，NAT 拦不住。
   * 所以这里连不上，几乎一定是服务器那边的防火墙 / 云安全组没放行被动端口范围，
   * 或者 pasv_address 配错了 —— 用户改自己的配置是没用的，得让服务器管理员处理。
   */
  private passiveConnectHint(host: string, port: number, detail: string): string {
    return [
      `连不上服务器的被动数据端口 ${host}:${port}（${detail}）。`,
      '被动模式是客户端主动连服务器，一般不会被你这边拦住，所以这通常是服务器端的问题：',
      '操作系统防火墙或云服务器安全组没有放行被动端口范围。',
      '对应配置项：vsftpd 的 pasv_min_port / pasv_max_port、pure-ftpd 的 -p、ProFTPD 的 PassivePorts；',
      '如果配了 pasv_address，还要确认写的是公网地址。',
    ].join('');
  }

  /** 数据连接出问题时给一句能直接照做的提示。 */
  private dataHint(): string {    return this.opt.mode === 'active'
      ? ' 当前是主动模式：服务器要反过来连你的机器，在 NAT / 运营商网关（CGNAT）后面常常连不回来。建议把配置里的 ftpMode 改成 "passive"。'
      : ' 如果经常这样，看看服务器端的被动端口范围（pasv_min/pasv_max）有没有在防火墙里放行。';
  }

  /** 把"等待应答超时"包装成带操作建议的错误。 */
  private async waitReplyOrExplain(what: string): Promise<FtpReply> {
    try {
      return await this.waitReply();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new RemoteError(`${what}：${detail}${this.dataHint()}`, err);
    }
  }

  /** 下载类命令：RETR / LIST / MLSD。 */
  private async transferDownload(cmd: string): Promise<Buffer> {
    return this.serialize(async () => {
      const channel = await this.beginDataChannel();
      try {
        this.log(`> ${redact(cmd)}`);
        const dataPromise = channel.socket.then((s) => this.collectData(s));
        this.writeRaw(cmd);
        const prelim = await this.waitReplyOrExplain(`数据连接建立后服务器没有回应（${redact(cmd)}）`);
        this.log(`< ${prelim.code}`);
        if (prelim.code >= 400) {
          channel.abort();
          dataPromise.catch(() => undefined);
          throw new FtpReplyError(`远程操作失败：${redact(cmd)} → ${prelim.text}`, prelim.code);
        }
        if (prelim.code >= 200) {
          // 服务器把**结束**应答发在了**开始**应答前面 —— 不规范，但用户那台服务器就是这样。
          //
          // 这种情况下数据仍然会从数据连接送过来，所以不能按"没有数据体"立刻收摊：
          // 那会让目录莫名其妙变成空的（被动模式尤其明显，因为 abort 会直接关掉数据连接）。
          // 正确做法是继续把数据收完，只是给一个有限的等待时间，免得服务器真的不发时干等。
          return await this.collectBounded(dataPromise);
        }
        // 关键：先把"接收最终应答"的位置排好，再去等数据传完。
        // 很多服务器会先关数据连接、紧接着发 226，如果等数据等完了才登记，
        // 这个 226 就会被当成"无人等待的应答"丢掉，然后一直卡到超时。
        const finalPromise = this.waitReply();
        const data = await dataPromise.catch((err: unknown) => {
          throw new RemoteError(
            `数据连接中断（${redact(cmd)}）：${err instanceof Error ? err.message : String(err)}${this.dataHint()}`,
            err,
          );
        });
        const fin = await finalPromise.catch((err: unknown) => {
          const detail = err instanceof Error ? err.message : String(err);
          throw new RemoteError(`数据传输完成但服务器没有发来结束应答（${redact(cmd)}）：${detail}${this.dataHint()}`, err);
        });
        this.log(`< ${fin.code}`);
        if (fin.code >= 400) {
          throw new FtpReplyError(`传输未完成：${fin.text}`, fin.code);
        }
        return data;
      } finally {
        channel.abort();
      }
    });
  }

  /**
   * 在有限时间内把数据连接收完。
   * 用于"服务器提前发了结束应答"这种不规范时序：数据可能马上到，也可能真的不来。
   */
  private collectBounded(pending: Promise<Buffer>): Promise<Buffer> {
    const limitMs = Math.min(this.opt.connectTimeout, 5000);
    return new Promise<Buffer>((resolve) => {
      const timer = setTimeout(() => {
        pending.catch(() => undefined); // 别留下未处理的 rejection
        resolve(Buffer.alloc(0));
      }, limitMs);
      timer.unref?.();
      pending.then(
        (data) => {
          clearTimeout(timer);
          resolve(data);
        },
        () => {
          clearTimeout(timer);
          resolve(Buffer.alloc(0));
        },
      );
    });
  }

  /** 上传类命令：STOR / APPE。 */
  private async transferUpload(cmd: string, data: Buffer): Promise<void> {
    return this.serialize(async () => {
      const channel = await this.beginDataChannel();
      try {
        this.log(`> ${redact(cmd)} (${data.length} 字节)`);
        this.writeRaw(cmd);
        const prelim = await this.waitReplyOrExplain(`数据连接建立后服务器没有回应（${redact(cmd)}）`);
        this.log(`< ${prelim.code}`);
        if (prelim.code >= 400) {
          channel.abort();
          throw new FtpReplyError(`远程操作失败：${redact(cmd)} → ${prelim.text}`, prelim.code);
        }
        // 同上：先排好接收位再写数据
        const finalPromise = prelim.code < 200 ? this.waitReply() : null;
        const socket = await channel.socket;
        await new Promise<void>((resolve, reject) => {
          socket.once('error', (err) => reject(new RemoteError(`上传失败：${err.message}`, err)));
          socket.end(data, () => resolve());
        });
        if (finalPromise) {
          const fin = await finalPromise.catch((err: unknown) => {
            const detail = err instanceof Error ? err.message : String(err);
            throw new RemoteError(`上传完成但服务器没有发来结束应答（${redact(cmd)}）：${detail}${this.dataHint()}`, err);
          });
          this.log(`< ${fin.code}`);
          if (fin.code >= 400) throw new FtpReplyError(`上传未完成：${fin.text}`, fin.code);
        }
      } finally {
        channel.abort();
      }
    });
  }

  // ─────────────────────────── 公开操作 ───────────────────────────

  async list(dir: string): Promise<RemoteEntry[]> {
    const path = posixNormalize(dir);

    if (this.supportsMlsd) {
      try {
        const buf = await this.transferDownload(`MLSD ${path}`);
        return parseMlsd(this.decode(buf), path);
      } catch (err) {
        // 只有"服务器明确说这个命令不行"时才值得退回 LIST。
        // 超时/连接中断这类问题换命令也救不回来，硬retry只会让用户多等一个超时周期，
        // 而且会把真正的原因（数据连接不通）藏在后面。
        if (!(err instanceof FtpReplyError)) throw err;
        this.supportsMlsd = false;
        this.log(`MLSD 被服务器拒绝（${err.code}），改用 LIST：${err.message}`);
      }
    }

    const buf = await this.transferDownload(`LIST ${path}`);
    const parsed = parseList(this.decode(buf), path);
    if (parsed.length > 0) return parsed;

    // LIST 输出完全解析不出来时，用 NLST 至少拿到文件名
    try {
      const names = await this.transferDownload(`NLST ${path}`);
      return parseNlst(this.decode(names), path);
    } catch {
      return parsed;
    }
  }

  async stat(path: string): Promise<RemoteEntry | undefined> {
    const target = posixNormalize(path);
    if (target === '/' || target === '.') {
      return { name: '/', path: '/', type: 'folder', size: 0 };
    }

    if (this.supportsMlst) {
      try {
        const reply = await this.command(`MLST ${target}`);
        if (reply.code < 400) {
          const entry = parseMlst(reply.text, target);
          if (entry) return entry;
        }
      } catch {
        this.supportsMlst = false;
      }
    }

    // SIZE 只要 1 次往返就能确认"这是普通文件"，比下面列父目录（3~4 次往返）便宜得多。
    // 目录或服务器不支持 SIZE 时会返回 5xx，落到下面的列目录兜底。
    try {
      const size = await this.command(`SIZE ${target}`);
      if (size.code === 213) {
        const parsed = /(\d+)/.exec(size.text);
        if (parsed) {
          return { name: posixBasename(target), path: target, type: 'file', size: Number(parsed[1]) };
        }
      }
    } catch {
      /* 忽略，走兜底 */
    }

    const parent = posixDirname(target);
    const name = posixBasename(target);
    let entries: RemoteEntry[];
    try {
      entries = await this.list(parent);
    } catch {
      return undefined;
    }
    return (
      entries.find((e) => e.name === name) ??
      entries.find((e) => e.name.toLowerCase() === name.toLowerCase())
    );
  }

  async readFile(path: string): Promise<Buffer> {
    return this.transferDownload(`RETR ${posixNormalize(path)}`);
  }

  async writeFile(path: string, data: Buffer): Promise<void> {
    await this.transferUpload(`STOR ${posixNormalize(path)}`, data);
  }

  async ensureDir(path: string): Promise<void> {
    const target = posixNormalize(path);
    if (target === '/' || target === '.') return;
    if (this.knownDirs.has(target)) return;

    const segments = target.split('/').filter(Boolean);
    let current = '';
    for (const seg of segments) {
      current = current + '/' + seg;
      if (this.knownDirs.has(current)) continue;
      const cwd = await this.command(`CWD ${current}`);
      if (cwd.code < 400) {
        this.knownDirs.add(current);
        continue;
      }
      const mkd = await this.command(`MKD ${current}`);
      if (mkd.code >= 400 && !/exist/i.test(mkd.text)) {
        throw new RemoteError(`无法创建远程目录 ${current}：${mkd.text}`);
      }
      this.knownDirs.add(current);
    }
  }

  async deleteFile(path: string): Promise<void> {
    await this.commandExpect(`DELE ${posixNormalize(path)}`, [200, 250]);
  }

  async removeDir(path: string): Promise<void> {
    const target = posixNormalize(path);
    const entries = await this.list(target);
    for (const entry of entries) {
      if (entry.type === 'folder') await this.removeDir(entry.path);
      else await this.deleteFile(entry.path);
    }
    await this.commandExpect(`RMD ${target}`, [200, 250]);
    this.forgetDirsUnder(target);
  }

  /** 目录被删掉后，它和它下面所有子目录的"已存在"记录都不再可信。 */
  private forgetDirsUnder(dir: string): void {
    for (const known of [...this.knownDirs]) {
      if (isSubPath(dir, known)) this.knownDirs.delete(known);
    }
  }

  async rename(from: string, to: string): Promise<void> {
    await this.commandExpect(`RNFR ${posixNormalize(from)}`, [350]);
    await this.commandExpect(`RNTO ${posixNormalize(to)}`, [250]);
  }

  async end(): Promise<void> {
    this.closed = true;
    this.stopKeepalive();
    this.knownDirs.clear();
    this.orphanReplies.length = 0;
    if (this.socket && !this.socket.destroyed) {
      try {
        await this.command('QUIT', 2000);
      } catch {
        /* 忽略退出失败 */
      }
      this.socket.destroy();
    }
    this.socket = undefined;
    this.connected = false;
  }
}

function redact(cmd: string): string {
  if (/^PASS\b/i.test(cmd)) return 'PASS ******';
  return cmd;
}

// ─────────────────────────── 列表解析 ───────────────────────────

/** MLSD 行：`type=file;size=1234;modify=20240101120000; name` */
export function parseMlsd(text: string, dir: string): RemoteEntry[] {
  const out: RemoteEntry[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    const factsPart = line.slice(0, space);
    const name = line.slice(space + 1).trim();
    if (!name || name === '.' || name === '..') continue;

    const facts = new Map<string, string>();
    for (const f of factsPart.split(';')) {
      const eq = f.indexOf('=');
      if (eq > 0) facts.set(f.slice(0, eq).toLowerCase(), f.slice(eq + 1));
    }
    const type = (facts.get('type') ?? 'file').toLowerCase();
    if (type === 'cdir' || type === 'pdir') continue;
    out.push({
      name,
      path: posixJoin(dir, name),
      type: type === 'dir' ? 'folder' : type === 'os.unix=slink' || type === 'link' ? 'link' : 'file',
      size: Number(facts.get('size') ?? 0) || 0,
      mtime: parseFtpTime(facts.get('modify')),
    });
  }
  return out.sort(sortEntries);
}

/** UNIX `ls -l` 风格与 DOS 风格的 LIST 输出。 */
export function parseList(text: string, dir: string): RemoteEntry[] {
  const out: RemoteEntry[] = [];
  const unixRe =
    /^([-dlpscbD])([rwxsStT-]{9})\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\S+\s+\d{1,2}\s+(?:\d{4}|\d{1,2}:\d{2}(?::\d{2})?))\s+(.*)$/;
  const unixNoGroupRe =
    /^([-dlpscbD])([rwxsStT-]{9})\s+\d+\s+\S+\s+(\d+)\s+(\S+\s+\d{1,2}\s+(?:\d{4}|\d{1,2}:\d{2}(?::\d{2})?))\s+(.*)$/;
  const dosRe =
    /^(\d{2})-(\d{2})-(\d{2,4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)?\s+(<DIR>|\d+)\s+(.*)$/i;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\r$/, '');
    if (!line.trim()) continue;
    if (/^total\s+\d+/i.test(line.trim())) continue;

    let m = unixRe.exec(line) ?? unixNoGroupRe.exec(line);
    if (m) {
      const kind = m[1];
      const name = m[5].trim();
      if (!name || name === '.' || name === '..') continue;
      const type: RemoteEntry['type'] = kind === 'd' ? 'folder' : kind === 'l' ? 'link' : 'file';
      out.push({
        name: stripLinkTarget(name, type),
        path: posixJoin(dir, stripLinkTarget(name, type)),
        type,
        size: Number(m[3]) || 0,
        mtime: parseUnixDate(m[4]),
      });
      continue;
    }

    m = dosRe.exec(line);
    if (m) {
      const name = m[8].trim();
      if (!name || name === '.' || name === '..') continue;
      const isDir = m[7].toUpperCase() === '<DIR>';
      const year = Number(m[3]);
      const fullYear = year < 100 ? (year >= 70 ? 1900 + year : 2000 + year) : year;
      let hour = Number(m[4]) % 12;
      if ((m[6] ?? '').toUpperCase() === 'PM') hour += 12;
      const date = new Date(fullYear, Number(m[1]) - 1, Number(m[2]), hour, Number(m[5]));
      out.push({
        name,
        path: posixJoin(dir, name),
        type: isDir ? 'folder' : 'file',
        size: isDir ? 0 : Number(m[7]) || 0,
        mtime: Number.isNaN(date.getTime()) ? undefined : date.getTime(),
      });
      continue;
    }

    // 兜底：整行当作文件名
    const bare = line.trim();
    if (bare && bare !== '.' && bare !== '..') {
      out.push({ name: bare, path: posixJoin(dir, bare), type: 'file', size: 0 });
    }
  }
  return out.sort(sortEntries);
}

/** MLST 应答里夹在 250- 行中间的 facts 行。 */
export function parseMlst(text: string, target: string): RemoteEntry | undefined {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/^\d{3}[-\s]?/, '').trim();
    if (!line || /^end$/i.test(line)) continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    const factsPart = line.slice(0, space);
    if (!/=/.test(factsPart)) continue;
    const name = line.slice(space + 1).trim() || posixBasename(target);
    const facts = new Map<string, string>();
    for (const f of factsPart.split(';')) {
      const eq = f.indexOf('=');
      if (eq > 0) facts.set(f.slice(0, eq).toLowerCase(), f.slice(eq + 1));
    }
    const type = (facts.get('type') ?? '').toLowerCase();
    if (type === 'cdir' || type === 'pdir') continue;
    return {
      name,
      path: posixNormalize(target),
      type: type === 'dir' ? 'folder' : type === 'file' ? 'file' : 'link',
      size: Number(facts.get('size') ?? 0) || 0,
      mtime: parseFtpTime(facts.get('modify')),
    };
  }
  return undefined;
}

export function parseNlst(text: string, dir: string): RemoteEntry[] {
  const out: RemoteEntry[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const name = rawLine.trim();
    if (!name || name === '.' || name === '..') continue;
    out.push({ name: posixBasename(name), path: posixJoin(dir, posixBasename(name)), type: 'file', size: 0 });
  }
  return out.sort(sortEntries);
}

function stripLinkTarget(name: string, type: RemoteEntry['type']): string {
  if (type !== 'link') return name;
  const idx = name.indexOf(' -> ');
  return idx >= 0 ? name.slice(0, idx) : name;
}

function sortEntries(a: RemoteEntry, b: RemoteEntry): number {
  if (a.type !== b.type) {
    if (a.type === 'folder') return -1;
    if (b.type === 'folder') return 1;
  }
  return a.name.localeCompare(b.name, 'zh-Hans-CN');
}

/** MLSx 的 modify 格式：YYYYMMDDHHMMSS[.sss]，UTC。 */
function parseFtpTime(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(value);
  if (!m) return undefined;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  return Number.isNaN(t) ? undefined : t;
}

/** LIST 的时间字段："Jan 12 10:30" 或 "Jan 12 2024" 或 ISO。 */
function parseUnixDate(value: string): number | undefined {
  const v = value.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (iso) return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])).getTime();

  const m = /^([A-Za-z]{3})\s+(\d{1,2})\s+(.+)$/.exec(v);
  if (!m) return undefined;
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const month = months.indexOf(m[1].toLowerCase());
  if (month < 0) return undefined;
  const day = Number(m[2]);
  const rest = m[3];
  const now = new Date();
  const timeMatch = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(rest);
  if (timeMatch) {
    // LIST 不带年份时用今年，如果比现在晚很多就认为去年
    let year = now.getFullYear();
    const d = new Date(year, month, day, Number(timeMatch[1]), Number(timeMatch[2]));
    if (d.getTime() - now.getTime() > 24 * 3600 * 1000) {
      year -= 1;
      return new Date(year, month, day, Number(timeMatch[1]), Number(timeMatch[2])).getTime();
    }
    return d.getTime();
  }
  const yearMatch = /^(\d{4})$/.exec(rest);
  if (yearMatch) return new Date(Number(yearMatch[1]), month, day).getTime();
  return undefined;
}
