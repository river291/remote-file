import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import { matchLocal, remoteToLocal as remoteToLocalPath } from '../core/pathMap';
import {
  baselineFlagKey,
  connectionIdOf,
  digestKey,
  isBaselineFlagKey,
  markBaseline,
  MemoryDigestStore,
  parseDigestKey,
  unmarkDigest,
  uploadedByUs,
  type DigestStore,
} from '../core/digestStore';
import { posixDirname, posixJoin, posixNormalize } from '../core/posixPath';
import { RemoteError, type RemoteClient, type ServerConfig } from '../core/types';
import type { SyncRoot } from '../core/pathMap';
import type { ConfigStore } from './configStore';
import type { ConnectionManager } from './connection';
import type { Logger } from './logger';

export interface UploadPlan {
  profile: ServerConfig;
  root: SyncRoot;
  relative: string;
  localPath: string;
  remotePath: string;
}

export interface UploadOutcome {
  uploaded: number;
  skipped: number;
  failed: { localPath: string; error: string }[];
}

/** 单次上传的结果。 */
export type SingleUploadResult = 'uploaded' | 'unchanged' | 'out-of-scope';

/** 一次增量扫描的结果。 */
export interface IncrementalScan {
  /** 内容变了、或者账本里根本没有的本地文件。 */
  toUpload: { key: string; localPath: string; remotePath: string; relative: string; digest: string }[];
  /** 账本里记着、但本地已经不存在的远程文件。 */
  toDelete: { key: string; remotePath: string; localPath: string }[];
  /** 扫过但内容没变的文件数。 */
  unchanged: number;
  /** 账本里还没有这台服务器的基线（第一次同步）。 */
  baselineOnly: boolean;
  /**
   * 首次同步时这些是**远程已经有**的文件：按当前本地内容登记成基线，不上传。
   *
   * 为什么单独列：以前首次同步是"把本地**所有**文件都登记成已同步"，
   * 那会把**远程上其实还没有的新文件**一起吞掉（用户报的问题）。
   * 现在先去远程看一眼：远程有的才登记，远程没有的进 `toUpload` 真传上去。
   */
  toBaseline: { key: string; digest: string }[];
}

export interface IncrementalResult {
  uploaded: number;
  deleted: number;
  skipped: number;
  failed: { target: string; error: string }[];
}

/** 一次批量下载的结果。失败的文件会列出来，而不是让整体中断。 */
export interface DownloadOutcome {
  downloaded: number;
  skipped: number;
  failed: { remotePath: string; localPath: string; error: string }[];
}

function emptyScan(baselineOnly: boolean): IncrementalScan {
  return { toUpload: [], toDelete: [], unchanged: 0, baselineOnly, toBaseline: [] };
}

export interface UploadOptions {
  /** 不写额外日志（自动上传用）。 */
  silent?: boolean;
  /**
   * 强制上传，跳过"内容没变就不传"的判断。
   * 用户显式执行的上传命令（Ctrl+Alt+U、右键上传、上传整个项目）都应该带上它，
   * 因为那些操作的语义是"我要把它推上去"，不是"顺手同步一下"。
   */
  force?: boolean;
}

/** 内容指纹。用来判断"这个文件跟上次传上去的是不是一模一样"。 */
function digestOf(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** 两个本地路径是不是同一个（Windows 上大小写不敏感，统一小写比较）。 */
function samePath(a: string, b: string): boolean {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

/**
 * 把"本地文件"翻译成"远程路径"并执行传输。
 * 命令和文件监听都调用这里，保证行为一致（同一套忽略规则和映射规则）。
 */
export class SyncService {
  constructor(
    private readonly config: ConfigStore,
    private readonly connection: ConnectionManager,
    private readonly logger: Logger,
    /**
     * 「上次同步时本地是什么内容」的账本。
     * 存的是 `连接 \0 远程路径 → 内容指纹`，用来判断"内容没变就不用传"
     * 以及增量同步时"哪些变了、哪些本地已删"。
     */
    private readonly digests: DigestStore = new MemoryDigestStore(),
  ) {}

  /**
   * 算出某个本地文件应该上传到哪里；返回 undefined 表示这个文件不归插件管。
   * quiet=true 时不写"跳过"日志，用于只需要知道落点、不关心是否该跳过的场景。
   */
  plan(localPath: string, quiet = false): UploadPlan | undefined {
    const profile = this.config.active;
    if (!profile) return undefined;
    if (this.config.isConfigFile(localPath)) return undefined;

    const roots = this.config.roots();
    const match = matchLocal(roots, localPath);
    if (!match) return undefined;
    if (match.relative === '') return undefined;

    if (this.config.ignore().ignores(match.relative)) {
      if (!quiet) {
        const rule = this.config.ignore().match(match.relative);
        this.logger.info(`跳过 ${match.relative}（命中忽略规则 "${rule}"）`);
      }
      return undefined;
    }

    const remotePath = match.relative === '' ? match.root.remoteDir : posixJoin(match.root.remoteDir, match.relative);
    return { profile, root: match.root, relative: match.relative, localPath, remotePath };
  }

  /**
   * 账本的键：「这份内容属于哪台服务器的哪个路径」。
   *
   * 刻意用连接的关键信息，**不是 profile 的 name** —— 有人会给 profile 起名"生产"，
   * 然后把 host 改成另一台机器。这时名字没变、目标却变了，旧记录必须失效，
   * 否则换了服务器之后第一次保存会被误判成"内容没变"而不上传。
   */
  private digestKeyOf(profile: ServerConfig, remotePath: string): string {
    return digestKey(connectionIdOf(profile), remotePath);
  }

  /** 上传单个文件（自动建目录）。 */
  async uploadFile(localPath: string, opts: UploadOptions = {}): Promise<SingleUploadResult> {
    const plan = this.plan(localPath, opts.silent === true);
    if (!plan) return 'out-of-scope';

    let data: Buffer;
    try {
      data = await fs.promises.readFile(localPath);
    } catch (err) {
      throw new RemoteError(`读取本地文件失败 ${localPath}：${err instanceof Error ? err.message : String(err)}`, err);
    }

    // 内容没变就不传。账本按「服务器 + 远程路径」存，换服务器或改映射都会自然失效。
    // 这个行为可以关掉：配置里的 uploadOnlyWhenChanged。
    const digestKey = this.digestKeyOf(plan.profile, plan.remotePath);
    const digest = digestOf(data);
    if (!opts.force && plan.profile.uploadOnlyWhenChanged && unmarkDigest(this.digests.get(digestKey)) === digest) {
      this.logger.info(`内容没有变化，跳过上传：${plan.relative}`);
      return 'unchanged';
    }

    const started = Date.now();
    await this.connection.run(plan.profile, async (client) => {
      await this.ensureRemoteDir(client, posixDirname(plan.remotePath));
      await client.writeFile(plan.remotePath, data);
    });

    // 只有真的传成功了才记账 —— 失败时不留记录，下次会自动重试
    this.digests.set(digestKey, digest);

    this.logger.info(`↑ ${plan.relative} → ${plan.remotePath}（${formatSize(data.length)}，${Date.now() - started}ms）`);
    return 'uploaded';
  }

  // ─────────────────────── 增量同步（启动 / 手动） ───────────────────────

  /**
   * 扫一遍，找出"需要上传的"和"本地已删、需要删远程的"。
   *
   * 判断依据是账本，不是远程 —— 所以**不需要对每个文件向服务器发一次请求**，
   * 扫描成本只在本地（读文件 + 哈希）。这也是它能用在启动时的原因。
   */
  async scanForChanges(): Promise<IncrementalScan> {
    const profile = this.config.active;
    if (!profile) return emptyScan(false);

    const connectionId = connectionIdOf(profile);
    // 靠"有没有打过基线标记"判断首次，而不是"账本是不是空的" ——
    // 后者只要用户传过任何一个文件就不成立了。
    const baselineOnly = !this.digests.get(baselineFlagKey(connectionId));

    // 首次同步不能凭空假设"远程和本地一样"：先去远程看一眼它到底有什么。
    // 远程已有的 → 登记基线；远程没有的 → 真传上去。
    // 不这么做的话，VSCode 关着时新建的文件会被当成"已经同步过"吞掉。
    const remotePaths = baselineOnly ? await this.listRemoteTreePaths() : undefined;

    const toUpload: IncrementalScan['toUpload'] = [];
    const toBaseline: IncrementalScan['toBaseline'] = [];
    let unchanged = 0;

    for (const root of this.config.roots()) {
      if (!fs.existsSync(root.localDir)) continue;
      for await (const file of walkFiles(root.localDir, this.config)) {
        const plan = this.plan(file, true);
        if (!plan) continue;
        let data: Buffer;
        try {
          data = await fs.promises.readFile(file);
        } catch {
          continue;
        }
        const digest = digestOf(data);
        const key = this.digestKeyOf(plan.profile, plan.remotePath);

        if (remotePaths) {
          // 首次同步
          if (remotePaths.has(plan.remotePath)) {
            toBaseline.push({ key, digest });
          } else {
            toUpload.push({ key, localPath: file, remotePath: plan.remotePath, relative: plan.relative, digest });
          }
          continue;
        }

        if (unmarkDigest(this.digests.get(key)) === digest) {
          unchanged++;
          continue;
        }
        toUpload.push({ key, localPath: file, remotePath: plan.remotePath, relative: plan.relative, digest });
      }
    }

    // 删除同样受 deleteOnLocalDelete 控制 —— 关着就绝不删远程
    const toDelete: IncrementalScan['toDelete'] = [];
    if (profile.deleteOnLocalDelete) {
      for (const key of this.digests.keys()) {
        const parsed = parseDigestKey(key);
        if (!parsed || parsed.connectionId !== connectionId) continue;
        // 基线标记是账本内部用的假路径，不是真文件
        if (isBaselineFlagKey(key)) continue;
        const localPath = this.remoteToLocal(parsed.remotePath);
        // 映射没了（配置改过）就保守不动，宁可不删
        if (!localPath) continue;
        // 本地文件还在（哪怕被忽略规则跳过）就不删
        if (fs.existsSync(localPath)) continue;
        // 现在被忽略规则排除的路径，插件**整个都不管**了 —— 包括不许删。
        // 否则你把 storage/cache、storage/cert 这类运行时目录加进 ignore 之后，
        // 只要本地同名文件正好不见了，就有机会去删服务器上那份（证书删了 HTTPS 就挂了）。
        const match = matchLocal(this.config.roots(), localPath);
        if (match && this.config.ignore().ignores(match.relative)) continue;
        // 注意：这里**不过滤"是不是自己传过的"** —— 建基线记录的文件也允许进计划，
        // 因为真正删除前还会核对远程内容（见 deleteRemoteForLocal）。
        // 否则对一个早就部署好的项目，基线里的文件本地删掉后永远同步不到远程。
        toDelete.push({ key, remotePath: parsed.remotePath, localPath });
      }
    }

    return { toUpload, toDelete, unchanged, baselineOnly, toBaseline };
  }

  /**
   * 列出远程现有的全部路径（首次同步时用来判断"远程到底有没有这个文件"）。
   * 按目录逐层列，忽略规则同样生效 —— 代价是每个远程目录一次 LIST，很便宜。
   */
  private async listRemoteTreePaths(): Promise<Set<string>> {
    const out = new Set<string>();
    const walk = async (dir: string, relDir: string): Promise<void> => {
      let entries;
      try {
        entries = await this.listRemote(dir);
      } catch (err) {
        // 列不出来就当这一层没有：宁可多传几个，也不要误判成"远程已经有了"
        this.logger.warn(`首次同步：列远程目录失败 ${dir} —— ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      for (const entry of entries) {
        const rel = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
        if (this.config.ignore().ignores(rel)) continue;
        out.add(entry.path);
        if (entry.type === 'folder') await walk(entry.path, rel);
      }
    };
    for (const root of this.config.roots()) await walk(root.remoteDir, '');
    return out;
  }

  /**
   * 账本里属于当前服务器的条目数（不含基线标记）。
   * 主要是给日志用的 —— 用户靠它确认"基线到底建上了没有"。
   */
  ledgerCount(): number {
    const profile = this.config.active;
    if (!profile) return 0;
    const connectionId = connectionIdOf(profile);
    return this.digests
      .keys()
      .filter((k) => parseDigestKey(k)?.connectionId === connectionId && !isBaselineFlagKey(k)).length;
  }

  /** 这台服务器是否已经建立过基线。 */
  hasBaseline(): boolean {
    const profile = this.config.active;
    if (!profile) return false;
    return !!this.digests.get(baselineFlagKey(connectionIdOf(profile)));
  }

  /**
   * 只记账、不传输：用于第一次启用时建立基线。
   *
   * 记下的条目标了"基线条目"的印记，**不参与删除判断** —— 因为我们并没有传过它们。
   * 最后再打一个基线标记：以后就不该再被判成"首次"了，
   * 否则只要用户中途传过几个文件，账本一非空就会把整个项目误报成"全是新增"。
   */
  rememberBaseline(scan: IncrementalScan): void {
    // 只登记"远程已经有"的（按当前本地内容），远程没有的会走 toUpload 真传上去。
    //
    // 这里会把已有条目一并重记成"基线"（包括之前"我们传过的"）—— 是有意的：
    // 基线条目在删除前会先核对远程内容，等于给"重新建过基线之后的删除"多加一道保险，
    // 万一远程那份被别处改过，就不会被本地删除带着删掉。
    for (const item of scan.toBaseline) this.digests.set(item.key, markBaseline(item.digest));
    const profile = this.config.active;
    if (profile) this.digests.set(baselineFlagKey(connectionIdOf(profile)), '1');
  }

  /** 执行一次增量同步。 */
  async applyScan(scan: IncrementalScan): Promise<IncrementalResult> {
    const result: IncrementalResult = { uploaded: 0, deleted: 0, skipped: 0, failed: [] };

    for (const item of scan.toUpload) {
      try {
        // 这里不用 force：账本里的指纹跟文件不一样，自然会传
        const outcome = await this.uploadFile(item.localPath, { silent: true });
        if (outcome === 'uploaded') result.uploaded++;
        else if (outcome === 'unchanged') result.skipped++;
        else result.skipped++;
      } catch (err) {
        result.failed.push({ target: item.localPath, error: err instanceof Error ? err.message : String(err) });
      }
    }

    for (const item of scan.toDelete) {
      try {
        // 文件已经不在了，但 plan() 只做路径计算，照样能算出远程路径
        const done = await this.deleteRemoteForLocal(item.localPath);
        if (done) result.deleted++;
        else result.skipped++;
      } catch (err) {
        result.failed.push({ target: item.remotePath, error: err instanceof Error ? err.message : String(err) });
      }
    }

    return result;
  }

  /** 算出某个本地目录对应的远程目录；返回 undefined 表示不归插件管。 */
  planDir(localDir: string): { profile: ServerConfig; remotePath: string } | undefined {
    const profile = this.config.active;
    if (!profile) return undefined;
    if (this.config.isConfigFile(localDir)) return undefined;

    const match = matchLocal(this.config.roots(), localDir);
    if (!match) return undefined;
    if (match.relative && this.config.ignore().ignores(match.relative)) return undefined;

    const remotePath = match.relative === '' ? match.root.remoteDir : posixJoin(match.root.remoteDir, match.relative);
    return { profile, remotePath };
  }

  /** 上传一个本地目录（或文件）下的所有内容。 */
  async uploadPath(localPath: string, opts: UploadOptions = {}): Promise<UploadOutcome> {
    const stat = await fs.promises.stat(localPath).catch(() => undefined);
    if (!stat) throw new RemoteError(`本地路径不存在：${localPath}`);

    const outcome: UploadOutcome = { uploaded: 0, skipped: 0, failed: [] };
    if (stat.isFile()) {
      try {
        const result = await this.uploadFile(localPath, { silent: true, force: opts.force });
        if (result === 'uploaded') outcome.uploaded++;
        else outcome.skipped++;
      } catch (err) {
        outcome.failed.push({ localPath, error: err instanceof Error ? err.message : String(err) });
      }
      return outcome;
    }

    const dirPlan = this.planDir(localPath);
    if (!dirPlan) {
      this.logger.info(`跳过 ${localPath}：不在同步范围内，或命中忽略规则`);
      outcome.skipped++;
      return outcome;
    }
    // 空目录也要在远程建出来
    await this.connection.run(dirPlan.profile, (client) => client.ensureDir(dirPlan.remotePath));

    for await (const file of walkFiles(localPath, this.config)) {
      try {
        const result = await this.uploadFile(file, { silent: true, force: opts.force });
        if (result === 'uploaded') outcome.uploaded++;
        else outcome.skipped++;
      } catch (err) {
        outcome.failed.push({ localPath: file, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return outcome;
  }

  /** 上传当前配置里的所有同步根。 */
  async uploadAll(opts: UploadOptions = {}): Promise<UploadOutcome> {
    const total: UploadOutcome = { uploaded: 0, skipped: 0, failed: [] };
    for (const root of this.config.roots()) {
      if (!fs.existsSync(root.localDir)) continue;
      const one = await this.uploadPath(root.localDir, opts);
      total.uploaded += one.uploaded;
      total.skipped += one.skipped;
      total.failed.push(...one.failed);
    }
    return total;
  }

  /** 本地删除了文件 —— 删除对应的远程文件。 */
  async deleteRemoteForLocal(localPath: string): Promise<boolean> {
    const plan = this.plan(localPath);
    if (!plan) return false;

    const key = this.digestKeyOf(plan.profile, plan.remotePath);
    const recorded = this.digests.get(key);

    const outcome = await this.connection.run(plan.profile, async (client) => {
      const entry = await client.stat(plan.remotePath);
      if (!entry) {
        this.logger.info(`远程本来就不存在，跳过删除：${plan.remotePath}`);
        return 'gone' as const;
      }

      // 只是"建基线时记录过"（本插件其实没传过它）→ 删除前必须确认远程那份就是记录里的内容。
      // 不一致说明那不是我们的文件（别人放在了同一个路径上），绝不能删。
      if (recorded !== undefined && !uploadedByUs(recorded)) {
        const want = unmarkDigest(recorded);
        let actual: string | undefined;
        try {
          actual = digestOf(await client.readFile(plan.remotePath));
        } catch {
          actual = undefined;
        }
        if (actual !== want) {
          this.logger.warn(
            `跳过删除 ${plan.remotePath}：远程内容和基线记录不一致，可能是别人放的文件（` +
              `本地记录 ${want?.slice(0, 8) ?? '无'}，远程 ${actual ? actual.slice(0, 8) : '读不到'}）`,
          );
          return 'kept' as const;
        }
      }

      if (entry.type === 'folder') await client.removeDir(plan.remotePath);
      else await client.deleteFile(plan.remotePath);
      return 'deleted' as const;
    });

    // 本地文件已经没了，这条记录留着只会每次都被重新提出来，处理完就清掉
    this.digests.delete(key);

    if (outcome === 'kept') return false;
    if (outcome === 'deleted') this.logger.info(`✖ 已同步删除远程 ${plan.remotePath}`);
    return true;
  }

  /** 本地重命名/移动 —— 远程也跟着改；远程改不动就退化成"删旧的+传新的"。 */
  async renameRemoteForLocal(oldLocal: string, newLocal: string): Promise<void> {
    const oldPlan = this.plan(oldLocal);
    const newPlan = this.plan(newLocal);
    if (!oldPlan && !newPlan) return;
    if (oldPlan && newPlan) {
      try {
        await this.connection.run(newPlan.profile, (client) => client.rename(oldPlan.remotePath, newPlan.remotePath));
        this.logger.info(`↔ 已同步重命名远程 ${oldPlan.remotePath} → ${newPlan.remotePath}`);
        // 重命名不改内容，所以新路径的指纹可以直接从本地文件算出来，
        // 这样接着按 Ctrl+S 不会被当成"内容变了"再传一遍。
        this.digests.delete(this.digestKeyOf(oldPlan.profile, oldPlan.remotePath));
        await this.rememberDigest(newPlan.localPath, newPlan.profile, newPlan.remotePath);
        return;
      } catch (err) {
        this.logger.warn(`远程重命名失败，改用先删后传：${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (oldPlan) await this.deleteRemoteForLocal(oldLocal).catch(() => undefined);
    if (newPlan) await this.uploadPath(newLocal).catch(() => undefined);
  }

  /** 把某个本地文件当前的内容指纹登记到指定远程路径上（用于重命名后的接力）。 */
  private async rememberDigest(localPath: string, profile: ServerConfig, remotePath: string): Promise<void> {
    try {
      const data = await fs.promises.readFile(localPath);
      this.digests.set(this.digestKeyOf(profile, remotePath), digestOf(data));
    } catch {
      /* 读不到就算了，下次保存会正常上传 */
    }
  }

  /** 下载远程文件到本地。 */
  async downloadRemote(remotePath: string, localPath: string): Promise<void> {
    const profile = this.config.active;
    if (!profile) throw new RemoteError('没有可用的服务器配置。');
    const data = await this.connection.run(profile, (client) => client.readFile(remotePath));
    await fs.promises.mkdir(path.dirname(localPath), { recursive: true });
    await fs.promises.writeFile(localPath, data);

    // **下载也要记账**：下载完之后本地内容和远程一模一样了，
    // 所以接着按 Ctrl+S 不该再把它传回去一遍。
    //
    // 记的是"基线"印记而不是"我们传过的" —— 这份内容确实是远程的、不是我们写的，
    // 所以以后本地删掉它时仍然会先核对远程内容再决定删不删。
    //
    // 只在"下载位置就是路径映射该去的地方"时记：
    // 如果用户把文件下到了别处，本地映射位置其实还空着，
    // 记了账反而会让增量同步误以为"这个远程文件本地已经没有了"，进而提议删远程。
    const mapped = this.remoteToLocal(remotePath);
    if (mapped && samePath(mapped, localPath)) {
      this.digests.set(this.digestKeyOf(profile, remotePath), markBaseline(digestOf(data)));
    }

    this.logger.info(`↓ ${remotePath} → ${localPath}（${formatSize(data.length)}）`);
  }

  // ─────────────────────── 从远程下载（批量） ───────────────────────

  /**
   * 递归下载一个远程目录到本地目录。
   *
   * **单个文件失败不会中断整体** —— 服务器上总有那么几个下不下来的东西
   * （比如宝塔生成的 `.user.ini`，RETR 直接回 `550`）。这类文件跳过并记下来，
   * 最后统一汇报，而不是让用户看到一个"下载到一半停了"。
   *
   * 忽略规则在这里同样生效：被 ignore 的远程路径不下载（那些本来就是服务器自己生成的）。
   * 只下载/覆盖，**不删除**本地多余的文件 —— 那太危险了，不在这个功能的语义里。
   */
  async downloadInto(remotePath: string, localPath: string, relDir = ''): Promise<DownloadOutcome> {
    const outcome: DownloadOutcome = { downloaded: 0, skipped: 0, failed: [] };
    const profile = this.config.active;
    if (!profile) throw new RemoteError('没有可用的服务器配置。');

    let entries;
    try {
      entries = await this.listRemote(remotePath);
    } catch (err) {
      // 整个目录列不出来：记一条失败，不要连累别的
      outcome.failed.push({
        remotePath,
        localPath,
        error: `列目录失败：${err instanceof Error ? err.message : String(err)}`,
      });
      return outcome;
    }

    await fs.promises.mkdir(localPath, { recursive: true }).catch(() => undefined);

    for (const entry of entries) {
      const childRel = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
      if (this.config.ignore().ignores(childRel)) {
        this.logger.info(`跳过 ${entry.path}（命中忽略规则）`);
        outcome.skipped++;
        continue;
      }
      const localChild = path.join(localPath, entry.name);
      if (entry.type === 'folder') {
        const sub = await this.downloadInto(entry.path, localChild, childRel);
        outcome.downloaded += sub.downloaded;
        outcome.skipped += sub.skipped;
        outcome.failed.push(...sub.failed);
        continue;
      }
      try {
        await this.downloadRemote(entry.path, localChild);
        outcome.downloaded++;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        outcome.failed.push({ remotePath: entry.path, localPath: localChild, error: message });
        this.logger.warn(`下载失败（继续处理其它文件）：${entry.path} —— ${message}`);
      }
    }
    return outcome;
  }

  /** 下载当前配置的整个远程根到本地 context 目录（用于"从服务器拉一份覆盖本地"）。 */
  async downloadAll(): Promise<DownloadOutcome> {
    const total: DownloadOutcome = { downloaded: 0, skipped: 0, failed: [] };
    for (const root of this.config.roots()) {
      if (!fs.existsSync(root.localDir)) {
        await fs.promises.mkdir(root.localDir, { recursive: true }).catch(() => undefined);
      }
      const one = await this.downloadInto(root.remoteDir, root.localDir);
      total.downloaded += one.downloaded;
      total.skipped += one.skipped;
      total.failed.push(...one.failed);
    }
    return total;
  }

  /**
   * 读取远程文件内容（用于"查看远程文件"）。
   * profileName 来自预览 URI —— 这样即使之后切换了当前服务器，
   * 已经打开的远程文件标签页仍然读的是原来那台服务器。
   */
  async readRemote(remotePath: string, profileName?: string): Promise<Buffer> {
    const profile = this.config.findProfile(profileName) ?? this.config.active;
    if (!profile) throw new RemoteError('没有可用的服务器配置。');
    return this.connection.run(profile, (client) => client.readFile(remotePath));
  }

  /** 列出远程目录。 */
  async listRemote(remotePath: string) {
    const profile = this.config.active;
    if (!profile) throw new RemoteError('没有可用的服务器配置。');
    const started = Date.now();
    const entries = await this.connection.run(profile, (client) => client.list(remotePath));
    // 记录耗时，"加载慢"才有个可看的数字（服务器越远，FTP 的多次往返越明显）
    this.logger.info(`列出 ${remotePath}：${entries.length} 项，${Date.now() - started}ms`);
    return entries;
  }

  /** 逐级创建远程目录，忽略"已存在"。 */
  private async ensureRemoteDir(client: RemoteClient, remoteDir: string): Promise<void> {
    const target = posixNormalize(remoteDir);
    if (target === '/' || target === '.') return;
    await client.ensureDir(target);
  }

  /** 新建远程文件夹。 */
  async createRemoteFolder(parent: string, name: string): Promise<string> {
    const profile = this.config.active;
    if (!profile) throw new RemoteError('没有可用的服务器配置。');
    const target = posixJoin(parent, name);
    await this.connection.run(profile, (client) => client.ensureDir(target));
    this.logger.info(`已创建远程目录 ${target}`);
    return target;
  }

  /** 删除远程文件/目录（用户在界面上主动删的，会先确认）。 */
  async deleteRemote(remotePath: string, isFolder: boolean): Promise<void> {
    const profile = this.config.active;
    if (!profile) throw new RemoteError('没有可用的服务器配置。');
    await this.connection.run(profile, async (client) => {
      if (isFolder) await client.removeDir(remotePath);
      else await client.deleteFile(remotePath);
    });
    this.logger.info(`已删除远程 ${remotePath}`);
  }

  /** 把远程路径映射回本地（下载用）。 */
  remoteToLocal(remotePath: string): string | undefined {
    return remoteToLocalPath(this.config.roots(), remotePath);
  }
}

/** 递归遍历本地目录，自动跳过忽略规则与符号链接目录。 */
export async function* walkFiles(startDir: string, config: ConfigStore): AsyncGenerator<string> {
  const roots = config.roots();
  const ignore = config.ignore();

  const stack: string[] = [startDir];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (err) {
      continue;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const match = matchLocal(roots, abs);
      if (match && match.relative && ignore.ignores(match.relative)) continue;
      if (config.isConfigFile(abs)) continue;

      if (entry.isDirectory()) {
        stack.push(abs);
      } else if (entry.isFile()) {
        yield abs;
      }
      // 符号链接一律跳过，避免目录成环
    }
  }
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
