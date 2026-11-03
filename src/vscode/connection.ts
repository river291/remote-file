import * as vscode from 'vscode';
import { createRemoteClient } from '../net';
import type { RemoteClient, ServerConfig } from '../core/types';
import { RemoteError } from '../core/types';
import type { Logger } from './logger';

/** 断线后是否值得重连重试。 */
function looksLikeConnectionLoss(err: unknown): boolean {
  const text = err instanceof Error ? `${err.message} ${String((err as { cause?: unknown }).cause ?? '')}` : String(err);
  return /ECONNRESET|EPIPE|ECONNREFUSED|ETIMEDOUT|连接已断开|连接中断|服务器关闭了连接|Connection lost|Socket closed|No response from server|421/i.test(
    text,
  );
}

/**
 * 连接的建立、复用与重连。
 *
 * 所有远程读写都通过 run() 走，这样：
 *   - 同一个配置只连一次
 *   - 操作串行执行（FTP 的控制连接本来也不支持并发传输）
 *   - 断线后自动重连并重试一次
 */
export class ConnectionManager {
  private readonly _onDidChangeState = new vscode.EventEmitter<void>();
  readonly onDidChangeState: vscode.Event<void> = this._onDidChangeState.event;

  private client?: RemoteClient;
  private fingerprint?: string;
  private connecting?: Promise<RemoteClient>;
  /** 当前正在执行的远程操作数，以及并发上限（按协议/配置决定）。 */
  private active = 0;
  private waiters: (() => void)[] = [];

  constructor(private readonly logger: Logger) {}

  dispose(): void {
    this._onDidChangeState.dispose();
    void this.disconnect();
  }

  private static fingerprintOf(profile: ServerConfig): string {
    return [
      profile.protocol,
      profile.host,
      profile.port,
      profile.username,
      profile.password ?? '',
      profile.privateKeyPath ?? '',
      profile.ftpMode,
      profile.secure ? profile.ftpsMode : 'plain',
      profile.encoding,
    ].join('|');
  }

  isConnected(profile?: ServerConfig): boolean {
    if (!this.client) return false;
    if (profile && this.fingerprint !== ConnectionManager.fingerprintOf(profile)) return false;
    return this.client.isConnected();
  }

  get connectedProfileFingerprint(): string | undefined {
    return this.fingerprint;
  }

  /** 取得（必要时建立）连接。 */
  async get(profile: ServerConfig, force = false): Promise<RemoteClient> {
    const fp = ConnectionManager.fingerprintOf(profile);
    if (!force && this.client && this.fingerprint === fp && this.client.isConnected()) {
      return this.client;
    }
    if (this.connecting && this.fingerprint === fp) return this.connecting;

    if (this.client) {
      const old = this.client;
      this.client = undefined;
      this.fingerprint = undefined;
      await old.end().catch(() => undefined);
    }

    this.fingerprint = fp;
    this.connecting = (async () => {
      const started = Date.now();
      const client = createRemoteClient(profile, this.logger.trace);
      await client.connect();
      this.client = client;
      this.logger.info(
        `连接就绪 ${profile.protocol}://${profile.host}:${profile.port}（握手 + 登录 ${Date.now() - started}ms，之后复用）`,
      );
      this._onDidChangeState.fire();
      return client;
    })();

    try {
      return await this.connecting;
    } catch (err) {
      this.fingerprint = undefined;
      this.connecting = undefined;
      this._onDidChangeState.fire();
      throw err;
    } finally {
      this.connecting = undefined;
    }
  }

  /**
   * 执行一个远程操作，失败且像是断线时重连重试一次。
   *
   * 并发策略（这是"加载慢"的关键）：
   *   - **不是连接数**。插件始终只用一条连接，靠的是协议自身的多路复用能力。
   *   - SFTP 走 SSH，一条连接上本来就支持大量并发请求，硬串行化纯属浪费，
   *     所以默认允许若干操作同时进行（concurrency，SFTP 默认 4）。
   *   - FTP 的控制连接协议上不允许并发传输，默认 1，即严格串行。
   *     想再快只能多开控制连接（多次登录），那是另一回事。
   */
  run<T>(profile: ServerConfig, op: (client: RemoteClient) => Promise<T>): Promise<T> {
    const limit = Math.max(1, Math.floor(profile.concurrency) || 1);
    return this.acquire(limit).then(async () => {
      try {
        const client = await this.get(profile);
        try {
          return await op(client);
        } catch (err) {
          if (!looksLikeConnectionLoss(err) || client.isConnected()) throw err;
          this.logger.warn(`连接似乎已断开，正在重连后重试：${err instanceof Error ? err.message : String(err)}`);
          const fresh = await this.get(profile, true);
          return await op(fresh);
        }
      } finally {
        this.release();
      }
    });
  }

  private acquire(limit: number): Promise<void> {
    if (this.active < limit) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(() => {
        this.active++;
        resolve();
      });
    });
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    const next = this.waiters.shift();
    if (next) next();
  }

  /** 当前并发度，仅用于日志与测试。 */
  get activeOperations(): number {
    return this.active;
  }

  /** 主动断开。 */
  async disconnect(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.fingerprint = undefined;
    this._onDidChangeState.fire();
    if (client) await client.end().catch(() => undefined);
  }
}

/** 把任意异常包装成带中文前缀的 RemoteError，避免上层到处判断类型。 */
export function asRemoteError(err: unknown, prefix: string): RemoteError {
  if (err instanceof RemoteError) return err;
  const detail = err instanceof Error ? err.message : String(err);
  return new RemoteError(`${prefix}：${detail}`, err);
}
