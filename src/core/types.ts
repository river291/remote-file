/** 配置与远程客户端的公共类型定义。这个文件不依赖 vscode，可被测试直接引用。 */

export type Protocol = 'sftp' | 'ftp' | 'ftps';

/** FTP 传输模式：被动（PASV/EPSV）或主动（PORT/EPRT）。 */
export type FtpMode = 'passive' | 'active';

/** 一条目录映射：本地某个目录对应远程某个目录。 */
export interface MappingConfig {
  /** 本地目录，相对工作区根目录，例如 "dist"。 */
  local: string;
  /** 远程目录，绝对 POSIX 路径，例如 "/var/www/html"。 */
  remote: string;
}

export interface ServerConfig {
  /** 显示名，用于状态栏和多服务器切换。 */
  name: string;
  protocol: Protocol;
  host: string;
  port: number;
  username: string;
  password?: string;
  /** 私钥文件绝对路径（SFTP）。 */
  privateKeyPath?: string;
  passphrase?: string;
  /** 远程根目录。 */
  remotePath: string;
  /** 本地根目录，相对工作区根目录；"." 表示工作区根。 */
  context: string;
  uploadOnSave: boolean;
  uploadOnCreate: boolean;
  /**
   * 内容跟上次成功上传的一模一样时，跳过上传（默认 true）。
   * 关掉就恢复"只要触发保存就重传一遍"。
   * 只影响保存/新建触发的自动上传；显式命令（Ctrl+Alt+U、右键上传）始终强制上传。
   */
  uploadOnlyWhenChanged: boolean;
  deleteOnLocalDelete: boolean;
  ftpMode: FtpMode;
  /** 是否使用 TLS（FTPS）。protocol === 'ftps' 时为 true。 */
  secure: boolean;
  /** FTPS 模式：explicit = AUTH TLS（默认，端口 21），implicit = 隐式加密（通常 990）。 */
  ftpsMode: 'explicit' | 'implicit';
  /** 远程文件名编码，默认 utf8；服务器的中文目录名乱码时改成 gbk。 */
  encoding: string;
  /**
   * 主动模式下用哪条命令把回连地址告诉服务器。
   *   auto（默认）：先 EPRT，被拒再退回 PORT，并记住结论
   *   port       ：只用 PORT —— 老路由器的 FTP ALG 往往只认 PORT，EPRT 会被改错地址
   *   eprt       ：只用 EPRT
   */
  ftpActiveCommand: 'auto' | 'port' | 'eprt';
  /** 允许自签名证书。 */
  allowUnauthorizedTls: boolean;
  connectTimeout: number;
  /**
   * 同一条连接上允许同时进行的远程操作数。
   *
   * 注意这不是"连接数"：插件始终只用一条连接。SFTP 走 SSH 多路复用，
   * 并发请求是协议原生支持的，所以默认给 4；FTP 的控制连接协议上就不允许
   * 并发传输，默认 1。
   */
  concurrency: number;
  ignore: string[];
  mappings: MappingConfig[];
  /** 原始 JSON，保留给高级用法。 */
  raw: Record<string, unknown>;
}

export interface ParsedConfig {
  profiles: ServerConfig[];
  /** profiles 中的默认项名字；只有一个 profile 时为空。 */
  defaultProfile: string | null;
  /** 配置文件的绝对路径。 */
  configPath: string;
}

export type RemoteEntryType = 'file' | 'folder' | 'link';

export interface RemoteEntry {
  name: string;
  /** 绝对 POSIX 路径。 */
  path: string;
  type: RemoteEntryType;
  size: number;
  /** 修改时间，毫秒时间戳；未知时为 undefined。 */
  mtime?: number;
}

/** 远程文件系统操作的统一接口，SFTP 与 FTP 各自实现。 */
export interface RemoteClient {
  connect(): Promise<void>;
  isConnected(): boolean;
  end(): Promise<void>;
  /** 列出目录内容。路径不存在时抛错。 */
  list(dir: string): Promise<RemoteEntry[]>;
  /** 取得路径信息；不存在时返回 undefined。 */
  stat(path: string): Promise<RemoteEntry | undefined>;
  readFile(path: string): Promise<Buffer>;
  writeFile(path: string, data: Buffer): Promise<void>;
  /** 递归创建目录，已存在时静默成功。 */
  ensureDir(path: string): Promise<void>;
  deleteFile(path: string): Promise<void>;
  /** 递归删除目录。 */
  removeDir(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

/** 统一的连接/操作错误，带上面向用户的中文提示。 */
export class RemoteError extends Error {
  override readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'RemoteError';
    this.cause = cause;
  }
}
