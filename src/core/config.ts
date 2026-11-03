/**
 * 配置文件（默认 .vscode/sftp.json）的解析与校验。
 *
 * 支持两种写法：
 *   1. 单服务器：顶层直接写 host / username / ...
 *   2. 多服务器：{ "defaultProfile": "生产", "profiles": [ {...}, {...} ] }
 *
 * 另外还会兼容几个常见的别名（user、remote_path、passive、secure），
 * 方便直接复用网上现成的 sftp.json。
 */
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { yamlScalar } from './ignoreEdit';
import type { FtpMode, MappingConfig, ParsedConfig, Protocol, ServerConfig } from './types';

/** 配置文件格式。按扩展名判断：.yml / .yaml 用 YAML，其余按带注释的 JSON 处理。 */
export type ConfigFormat = 'json' | 'yaml';

export function detectFormat(filePath: string): ConfigFormat {
  return /\.ya?ml$/i.test(filePath) ? 'yaml' : 'json';
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export interface ConfigDefaults {
  uploadOnSave: boolean;
  uploadOnCreate: boolean;
  uploadOnlyWhenChanged: boolean;
  deleteOnLocalDelete: boolean;
  connectTimeout: number;
  ignore: string[];
  encoding: string;
  /** 0 表示自动（SFTP 用 4，FTP 用 1）。 */
  concurrency: number;
  /** 主动模式用哪条命令告知回连地址。 */
  ftpActiveCommand: 'auto' | 'port' | 'eprt';
}

/** 去掉 JSON 里的 // 与 /* *\/ 注释（字符串内部不处理）。 */
export function stripJsonComments(text: string): string {
  let out = '';
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (inLine) {
      if (c === '\n') {
        inLine = false;
        out += c;
      }
      continue;
    }
    if (inBlock) {
      if (c === '*' && next === '/') {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += c;
      if (c === '\\') {
        out += next ?? '';
        i++;
        continue;
      }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === '/' && next === '/') {
      inLine = true;
      i++;
      continue;
    }
    if (c === '/' && next === '*') {
      inBlock = true;
      i++;
      continue;
    }
    out += c;
  }
  // 顺带干掉 JSON5 风格的尾逗号
  return out.replace(/,(\s*[}\]])/g, '$1');
}

function asBool(v: unknown, fallback: boolean): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(s)) return true;
    if (['false', '0', 'no', 'off'].includes(s)) return false;
  }
  return fallback;
}

function asStringArray(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  if (typeof v === 'string') {
    return v
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string') as string[];
  return [];
}

function asMappings(v: unknown): MappingConfig[] {
  const out: MappingConfig[] = [];
  if (!v) return out;
  if (Array.isArray(v)) {
    for (const item of v) {
      if (!item || typeof item !== 'object') continue;
      const o = item as Record<string, unknown>;
      const local = (o.local ?? o.localPath ?? o.from) as string | undefined;
      const remote = (o.remote ?? o.remotePath ?? o.to) as string | undefined;
      if (typeof local === 'string' && typeof remote === 'string' && local && remote) {
        out.push({ local, remote });
      }
    }
    return out;
  }
  if (typeof v === 'object') {
    // { "dist": "/var/www/html" } 这种简写
    for (const [local, remote] of Object.entries(v as Record<string, unknown>)) {
      if (typeof remote === 'string' && remote) out.push({ local, remote });
    }
  }
  return out;
}

function normalizeProtocol(raw: Record<string, unknown>, where: string): Protocol {
  let value = raw.protocol;
  if (typeof value !== 'string' || value.trim() === '') {
    value = raw.sftp === true ? 'sftp' : 'ftp';
  }
  const p = String(value).trim().toLowerCase();
  if (p === 'sftp' || p === 'ssh') return 'sftp';
  if (p === 'ftp') return asBool(raw.secure, false) ? 'ftps' : 'ftp';
  if (p === 'ftps' || p === 'ftp+tls' || p === 'ftp-tls') return 'ftps';
  throw new ConfigError(`${where}：protocol 只支持 "sftp" / "ftp" / "ftps"，当前是 "${String(value)}"。`);
}

function defaultPort(protocol: Protocol): number {
  return protocol === 'sftp' ? 22 : 21;
}

/** 把一份 profile 原始对象规范化成 ServerConfig。 */
export function normalizeProfile(
  rawInput: unknown,
  workspaceRoot: string,
  defaults: ConfigDefaults,
  where: string,
): ServerConfig {
  if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) {
    throw new ConfigError(`${where}：配置必须是一个对象。`);
  }
  const raw = rawInput as Record<string, unknown>;

  const host = String(raw.host ?? raw.hostname ?? '').trim();
  if (!host) {
    throw new ConfigError(`${where}：缺少必填项 "host"（服务器地址）。`);
  }

  const protocol = normalizeProtocol(raw, where);
  const portRaw = raw.port ?? raw.port_number;
  const port = portRaw === undefined || portRaw === null || portRaw === '' ? defaultPort(protocol) : Number(portRaw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new ConfigError(`${where}：port 不是合法端口号（当前是 "${String(portRaw)}"）。`);
  }

  const username = String(raw.username ?? raw.user ?? '').trim();
  if (!username) {
    throw new ConfigError(`${where}：缺少必填项 "username"（登录用户名）。`);
  }

  const protocolIsSftp = protocol === 'sftp';
  const privateKeyRaw = raw.privateKeyPath ?? raw.privateKey ?? raw.private_key_path;
  const privateKeyPath =
    typeof privateKeyRaw === 'string' && privateKeyRaw.trim() !== ''
      ? path.resolve(workspaceRoot, privateKeyRaw.trim())
      : undefined;
  if (protocolIsSftp && !privateKeyPath && raw.password === undefined) {
    // 不是硬性错误，用户可能用 ssh-agent；只在日志里提示，不阻止启动
  }

  const remotePathRaw = raw.remotePath ?? raw.remote_path ?? raw.remoteRoot;
  const remotePath = typeof remotePathRaw === 'string' && remotePathRaw.trim() !== '' ? remotePathRaw.trim() : '/';

  const contextRaw = raw.context ?? raw.localPath ?? raw.localRoot;
  const context = typeof contextRaw === 'string' && contextRaw.trim() !== '' ? contextRaw.trim() : '.';

  let ftpMode: FtpMode = 'passive';
  if (typeof raw.ftpMode === 'string' && raw.ftpMode.trim() !== '') {
    const m = raw.ftpMode.trim().toLowerCase();
    if (m !== 'passive' && m !== 'active') {
      throw new ConfigError(`${where}：ftpMode 只支持 "passive" 或 "active"，当前是 "${raw.ftpMode}"。`);
    }
    ftpMode = m;
  } else if (raw.passive !== undefined) {
    ftpMode = asBool(raw.passive, true) ? 'passive' : 'active';
  }

  const ignore = Array.from(new Set([...defaults.ignore, ...asStringArray(raw.ignore)]));
  const mappings = asMappings(raw.mappings ?? raw.mapping);

  const connectTimeoutRaw = raw.connectTimeout ?? raw.timeout;
  const connectTimeout = (() => {
    if (connectTimeoutRaw === undefined || connectTimeoutRaw === null || connectTimeoutRaw === '') {
      return defaults.connectTimeout;
    }
    const n = Number(connectTimeoutRaw);
    return Number.isFinite(n) && n > 0 ? n : defaults.connectTimeout;
  })();

  const name = String(raw.name ?? '').trim() || host;

  const ftpsModeRaw = String(raw.ftpsMode ?? '').trim().toLowerCase();
  let ftpsMode: 'explicit' | 'implicit' = 'explicit';
  if (ftpsModeRaw === 'implicit') ftpsMode = 'implicit';
  else if (ftpsModeRaw !== '' && ftpsModeRaw !== 'explicit') {
    throw new ConfigError(`${where}：ftpsMode 只支持 "explicit" 或 "implicit"，当前是 "${raw.ftpsMode}"。`);
  }

  const encodingRaw = raw.encoding ?? raw.charset;
  const encoding = typeof encodingRaw === 'string' && encodingRaw.trim() !== '' ? encodingRaw.trim() : defaults.encoding;

  // 并发数：配置里写了就用，没写就看全局设置，都没有就按协议取默认
  const concurrencyRaw = raw.concurrency ?? raw.maxConcurrency ?? (defaults.concurrency || undefined);
  const concurrency = (() => {
    const n = Number(concurrencyRaw);
    if (!Number.isFinite(n) || n < 1) return protocol === 'sftp' ? 4 : 1;
    return Math.min(Math.max(Math.floor(n), 1), 16);
  })();

  // 主动模式用 PORT 还是 EPRT
  const activeCmdRaw = String(raw.ftpActiveCommand ?? raw.activeCommand ?? 'auto').trim().toLowerCase();
  if (activeCmdRaw !== 'auto' && activeCmdRaw !== 'port' && activeCmdRaw !== 'eprt') {
    throw new ConfigError(`${where}：ftpActiveCommand 只支持 "auto" / "port" / "eprt"，当前是 "${raw.ftpActiveCommand}"。`);
  }
  const ftpActiveCommand = activeCmdRaw as 'auto' | 'port' | 'eprt';

  return {
    name,
    protocol,
    host,
    port,
    username,
    password: typeof raw.password === 'string' ? raw.password : undefined,
    privateKeyPath,
    passphrase: typeof raw.passphrase === 'string' ? raw.passphrase : undefined,
    remotePath,
    context,
    uploadOnSave: asBool(raw.uploadOnSave, defaults.uploadOnSave),
    uploadOnCreate: asBool(raw.uploadOnCreate, defaults.uploadOnCreate),
    uploadOnlyWhenChanged: asBool(
      raw.uploadOnlyWhenChanged ?? raw.skipUnchanged,
      defaults.uploadOnlyWhenChanged,
    ),
    deleteOnLocalDelete: asBool(raw.deleteOnLocalDelete ?? raw.autoDelete, defaults.deleteOnLocalDelete),
    ftpMode,
    secure: protocol === 'ftps' || asBool(raw.secure, false),
    ftpsMode,
    encoding,
    ftpActiveCommand,
    allowUnauthorizedTls: asBool(raw.allowUnauthorizedTls ?? raw.ignoreTlsErrors, false),
    connectTimeout,
    concurrency,
    ignore,
    mappings,
    raw,
  };
}

/**
 * 把配置文本解析成对象。
 *
 * YAML 用的是 **FAILSAFE_SCHEMA**：所有标量一律按字符串处理，不做隐式类型转换。
 * 这一点对配置文件特别重要 —— YAML 默认会把
 *   password: 123456   → 数字
 *   password: yes/on   → 布尔 true
 *   password: 0x10     → 数字 16
 * 全部搞成非字符串，登录就会莫名其妙失败。关掉隐式转换后一律是字符串，
 * 而下面的解析器本来就接受字符串形式的数字和布尔值（asBool / Number）。
 */
export function parseConfigObject(text: string, format: ConfigFormat, sourceName = '配置文件'): unknown {
  if (format === 'yaml') {
    try {
      return yaml.load(text, { schema: yaml.FAILSAFE_SCHEMA, json: true, filename: sourceName });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new ConfigError(`${sourceName} 不是合法的 YAML：${detail}`);
    }
  }
  try {
    return JSON.parse(stripJsonComments(text));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ConfigError(`${sourceName} 不是合法的 JSON：${detail}`);
  }
}

/** 解析配置文件内容。configPath 仅用于报错信息与结果返回。 */
export function parseConfig(
  text: string,
  configPath: string,
  workspaceRoot: string,
  defaults: ConfigDefaults,
  format: ConfigFormat = detectFormat(configPath),
): ParsedConfig {
  const json = parseConfigObject(text, format, path.basename(configPath));
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw new ConfigError('配置文件顶层必须是一个对象（一组 key: value）。');
  }

  const obj = json as Record<string, unknown>;
  const defaultsForProfile: ConfigDefaults = {
    ...defaults,
    uploadOnSave: asBool(obj.uploadOnSave, defaults.uploadOnSave),
    uploadOnCreate: asBool(obj.uploadOnCreate, defaults.uploadOnCreate),
    uploadOnlyWhenChanged: asBool(
      obj.uploadOnlyWhenChanged ?? obj.skipUnchanged,
      defaults.uploadOnlyWhenChanged,
    ),
    deleteOnLocalDelete: asBool(obj.deleteOnLocalDelete ?? obj.autoDelete, defaults.deleteOnLocalDelete),
    connectTimeout:
      obj.connectTimeout === undefined ? defaults.connectTimeout : Number(obj.connectTimeout) || defaults.connectTimeout,
    concurrency:
      obj.concurrency === undefined ? defaults.concurrency : Number(obj.concurrency) || defaults.concurrency,
    ignore: Array.from(new Set([...defaults.ignore, ...asStringArray(obj.ignore)])),
  };

  const profilesRaw = obj.profiles;
  if (!profilesRaw) {
    const profile = normalizeProfile(obj, workspaceRoot, defaultsForProfile, '配置');
    return { profiles: [profile], defaultProfile: null, configPath };
  }

  if (!Array.isArray(profilesRaw) || profilesRaw.length === 0) {
    throw new ConfigError('profiles 必须是一个非空数组。');
  }

  // 顶层里除 profiles / defaultProfile 之外的键，作为所有 profile 的公共默认值
  const shared: Record<string, unknown> = { ...obj };
  delete shared.profiles;
  delete shared.defaultProfile;

  const profiles = profilesRaw.map((p, i) => {
    const merged = { ...shared, ...(p && typeof p === 'object' ? (p as Record<string, unknown>) : {}) };
    return normalizeProfile(merged, workspaceRoot, defaultsForProfile, `profiles[${i}]`);
  });

  const defaultProfile = typeof obj.defaultProfile === 'string' ? obj.defaultProfile : null;
  if (defaultProfile && !profiles.some((p) => p.name === defaultProfile)) {
    throw new ConfigError(`defaultProfile 指向的 "${defaultProfile}" 在 profiles 里不存在。`);
  }

  const dup = profiles.map((p) => p.name).find((n, i, arr) => arr.indexOf(n) !== i);
  if (dup) {
    throw new ConfigError(`profiles 里有重名的服务器 "${dup}"，请给每个 profile 加不同的 name。`);
  }

  return { profiles, defaultProfile, configPath };
}

/**
 * 生成配置模板时可以带进去的值（向导用）。
 * 不传就是模板里那套示例默认值。
 */
export interface ConfigSeed {
  protocol?: Protocol;
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  remotePath?: string;
  context?: string;
}

const TEMPLATE_DEFAULTS = {
  host: '192.168.1.100',
  username: 'root',
  password: '',
  remotePath: '/var/www/html',
  context: '.',
} as const;

function resolveSeed(seed: ConfigSeed) {
  const protocol = seed.protocol ?? 'sftp';
  return {
    protocol,
    host: seed.host ?? TEMPLATE_DEFAULTS.host,
    // 协议决定默认端口：别再把 FTP 配成 22（这是真实踩过的坑）
    port: seed.port ?? (protocol === 'sftp' ? 22 : 21),
    username: seed.username ?? TEMPLATE_DEFAULTS.username,
    password: seed.password ?? TEMPLATE_DEFAULTS.password,
    remotePath: seed.remotePath ?? TEMPLATE_DEFAULTS.remotePath,
    context: seed.context ?? TEMPLATE_DEFAULTS.context,
  };
}

/**
 * 生成给用户看的配置模板（写入配置文件）。
 *
 * 每个会改变行为的开关都列在这里，并且**把默认值写出来** ——
 * 免得用户只能从文档或别人的聊天记录里知道有这么个选项。
 *
 * `seed` 是向导收集到的值：填了就替换掉示例值，注释和其余选项原样保留。
 */
export function defaultConfigText(format: ConfigFormat = 'json', seed: ConfigSeed = {}): string {
  return format === 'yaml' ? yamlConfigTemplate(seed) : jsonConfigTemplate(seed);
}

function jsonConfigTemplate(seed: ConfigSeed): string {
  const v = resolveSeed(seed);
  return `{
  // ── 连接 ────────────────────────────────────
  // 协议：sftp / ftp / ftps
  "protocol": ${JSON.stringify(v.protocol)},
  "host": ${JSON.stringify(v.host)},
  "port": ${v.port},
  "username": ${JSON.stringify(v.username)},
  // 密码直接写在这里的话，千万别把这个文件提交到 git
  "password": ${JSON.stringify(v.password)},
  // SFTP 用密钥登录时填私钥路径（相对工作区或绝对路径），可以不填密码
  // "privateKeyPath": "C:/Users/you/.ssh/id_rsa",
  // "passphrase": "",

  // 远程根目录：本地 context 目录下的文件会对应到这里
  "remotePath": ${JSON.stringify(v.remotePath)},
  // 本地根目录，"." 表示整个工作区
  "context": ${JSON.stringify(v.context)},

  // ── 自动上传 ────────────────────────────────
  // 保存文件时自动上传
  "uploadOnSave": true,
  // 新建文件时自动上传
  "uploadOnCreate": true,
  // 内容与上次成功上传的一模一样时跳过，不白跑一次网络
  // （按了 Ctrl+S 但没改东西就不会重传）
  // 只影响保存/新建触发的自动上传；Ctrl+Alt+U、右键上传始终强制上传
  "uploadOnlyWhenChanged": true,
  // 本地删除文件时同步删除远程（危险，默认关闭）
  "deleteOnLocalDelete": false,

  // ── FTP ────────────────────────────────────
  // 传输模式：passive（被动，默认）/ active（主动）
  // 不是公网 IP 就别用主动模式 —— 它要服务器反过来连你
  "ftpMode": "passive",
  // 主动模式下用哪条命令告知回连地址：auto（默认）/ port / eprt
  // 老路由器的 FTP ALG 往往只认 PORT，主动模式时通时不通时可以试 "port"
  // "ftpActiveCommand": "port",
  // FTPS 模式：explicit（AUTH TLS，默认）/ implicit（隐式加密，一般配 990 端口）
  // "ftpsMode": "explicit",
  // 服务器证书是自签名时打开
  // "allowUnauthorizedTls": true,

  // ── 性能 / 兼容 ─────────────────────────────
  // 同一条连接上同时进行的操作数。不填就自动：SFTP 用 4、FTP 用 1
  // 注意这不是连接数，插件始终只用一条连接
  // "concurrency": 4,
  // 远程目录名中文乱码时改成 gbk
  // "encoding": "utf8",

  // 不上传的文件/目录（glob 语法）
  "ignore": [".vscode", ".git", "node_modules", "**/*.log"],

  // 目录映射：把本地某个子目录映射到另一个远程目录。
  // 不写 mappings 时，整个 context 目录映射到 remotePath。
  "mappings": [
    // { "local": "dist", "remote": "/var/www/html" },
    // { "local": "src/assets", "remote": "/var/www/static" }
  ]
}
`;
}

function yamlConfigTemplate(seed: ConfigSeed): string {
  const v = resolveSeed(seed);
  return `# Remote File 配置（YAML，注释就是普通的 # 注释，不会有语法波浪线）
# 改完保存，插件会自动重新加载

# ── 连接 ────────────────────────────────────
# 协议：sftp / ftp / ftps
protocol: ${yamlScalar(v.protocol)}
host: ${yamlScalar(v.host)}
port: ${v.port}
username: ${yamlScalar(v.username)}
# 密码直接写在这里的话，千万别把这个文件提交到 git
password: ${yamlScalar(v.password)}
# SFTP 用密钥登录时填私钥路径（相对工作区或绝对路径），可以不填密码
# privateKeyPath: C:/Users/you/.ssh/id_rsa
# passphrase: ""

# 远程根目录：本地 context 目录下的文件会对应到这里
remotePath: ${yamlScalar(v.remotePath)}
# 本地根目录，"." 表示整个工作区
context: ${yamlScalar(v.context)}

# ── 自动上传 ────────────────────────────────
# 保存文件时自动上传
uploadOnSave: true
# 新建文件时自动上传
uploadOnCreate: true
# 内容与上次成功上传的一模一样时跳过，不白跑一次网络
# 只影响保存/新建触发的自动上传；Ctrl+Alt+U、右键上传始终强制上传
uploadOnlyWhenChanged: true
# 本地删除文件时同步删除远程（危险，默认关闭）
deleteOnLocalDelete: false

# ── FTP ────────────────────────────────────
# 传输模式：passive（被动，默认）/ active（主动）
# 不是公网 IP 就别用主动模式 —— 它要服务器反过来连你
ftpMode: passive
# 主动模式下用哪条命令告知回连地址：auto（默认）/ port / eprt
# ftpActiveCommand: port
# FTPS 模式：explicit（AUTH TLS，默认）/ implicit（隐式加密，一般配 990 端口）
# ftpsMode: explicit
# 服务器证书是自签名时打开
# allowUnauthorizedTls: true

# ── 性能 / 兼容 ─────────────────────────────
# 同一条连接上同时进行的操作数。不填就自动：SFTP 用 4、FTP 用 1
# 注意这不是连接数，插件始终只用一条连接
# concurrency: 4
# 远程目录名中文乱码时改成 gbk
# encoding: utf8

# 不上传的文件/目录（glob 语法；以 * 开头的要加引号）
ignore:
  - .vscode
  - .git
  - node_modules
  - "**/*.log"

# 目录映射：把本地某个子目录映射到另一个远程目录。
# 不写 mappings 时，整个 context 目录映射到 remotePath。
mappings:
  # - local: dist
  #   remote: /var/www/html
  # - local: src/assets
  #   remote: /var/www/static
`;
}
