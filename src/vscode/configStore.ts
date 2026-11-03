import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ConfigError, defaultConfigText, detectFormat, parseConfig, type ConfigDefaults } from '../core/config';
import { IgnoreMatcher } from '../core/ignore';
import { resolveRoots, type SyncRoot } from '../core/pathMap';
import type { ParsedConfig, ServerConfig } from '../core/types';
import type { Logger } from './logger';

const ACTIVE_PROFILE_KEY = 'remoteFile.activeProfile';

/**
 * 配置文件的读取与缓存。
 * 配置文件改了、设置改了、工作区换了，都会触发 onDidChange。
 */
export class ConfigStore {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange: vscode.Event<void> = this._onDidChange.event;

  private parsed?: ParsedConfig;
  private workspaceRoot?: string;
  private loadError?: string;
  private loaded = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly logger: Logger,
  ) {}

  dispose(): void {
    this._onDidChange.dispose();
  }

  /** 当前生效的工作区根目录（多根工作区取第一个能找到配置文件的）。 */
  get root(): string | undefined {
    return this.workspaceRoot;
  }

  get error(): string | undefined {
    return this.loadError;
  }

  get all(): ServerConfig[] {
    return this.parsed?.profiles ?? [];
  }

  get configPath(): string | undefined {
    return this.parsed?.configPath;
  }

  /** 配置文件里写的相对路径（相对工作区根）。 */
  configRelativePath(): string {
    return vscode.workspace.getConfiguration('remoteFile').get<string>('configFile', '.vscode/sftp.json');
  }

  /** 可能存在的配置文件的绝对路径列表（用于"打开配置"）。 */
  candidateConfigPaths(): string[] {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) return [];
    const variants = this.configVariants(this.configRelativePath());
    return folders.flatMap((f) => variants.map((v) => path.join(f.uri.fsPath, v)));
  }

  /**
   * 配置文件的候选相对路径。
   *
   * 用户指定的那个排第一（`remoteFile.configFile`，默认 `.vscode/sftp.json`），
   * 然后是同名的其它扩展名 —— 这样把 `sftp.json` 改名成 `sftp.yml` 就能直接生效，
   * 不用再去改设置。两个格式的文件同时存在时，用户指定的那个优先。
   */
  private configVariants(rel: string): string[] {
    const normalized = rel.replace(/\\/g, '/');
    if (!/\.(json|ya?ml)$/i.test(normalized)) return [normalized];
    const base = normalized.replace(/\.(json|ya?ml)$/i, '');
    const order = /\.ya?ml$/i.test(normalized) ? ['.yml', '.yaml', '.json'] : ['.json', '.yml', '.yaml'];
    return order.map((ext) => base + ext);
  }

  /**
   * 让配置文件用「带注释」的语言模式打开。
   *
   * `.json` 默认按严格 JSON 解析，`//` 注释会被标成语法错误（右侧那一堆波浪线）。
   * 切成 JSONC 就好了 —— 这不改文件内容，只是换个语法解析器。
   */
  async fixLanguageMode(doc: vscode.TextDocument): Promise<void> {
    const wanted = isYamlPath(doc.uri.fsPath) ? 'yaml' : 'jsonc';
    if (doc.languageId === wanted) return;
    try {
      await vscode.languages.setTextDocumentLanguage(doc, wanted);
    } catch {
      /* 语言模式不可用就算了，不影响功能，只是少个高亮 */
    }
  }

  private defaults(): ConfigDefaults {
    const cfg = vscode.workspace.getConfiguration('remoteFile');
    return {
      uploadOnSave: cfg.get<boolean>('uploadOnSave', true),
      uploadOnCreate: cfg.get<boolean>('uploadOnCreate', true),
      uploadOnlyWhenChanged: cfg.get<boolean>('uploadOnlyWhenChanged', true),
      deleteOnLocalDelete: cfg.get<boolean>('deleteOnLocalDelete', false),
      connectTimeout: cfg.get<number>('connectTimeout', 20000),
      ignore: cfg.get<string[]>('ignore', []),
      encoding: cfg.get<string>('remoteCharset', 'utf8') || 'utf8',
      concurrency: cfg.get<number>('concurrency', 0) || 0,
      ftpActiveCommand: (cfg.get<string>('ftpActiveCommand', 'auto') || 'auto') as 'auto' | 'port' | 'eprt',
    };
  }

  /** 重新读取配置。返回是否成功读到配置文件。 */
  async refresh(): Promise<boolean> {
    this.loaded = true;
    const candidates = this.candidateConfigPaths();
    if (candidates.length === 0) {
      this.parsed = undefined;
      this.workspaceRoot = undefined;
      this.loadError = undefined;
      this._onDidChange.fire();
      return false;
    }

    const found = candidates.find((p) => fs.existsSync(p));
    if (!found) {
      this.parsed = undefined;
      this.workspaceRoot = undefined;
      this.loadError = undefined;
      this.logger.info(`没有找到配置文件，期望位置：${candidates[0]}`);
      this._onDidChange.fire();
      return false;
    }

    const workspaceRoot = path.dirname(path.dirname(found));
    let text: string;
    try {
      text = await fs.promises.readFile(found, 'utf8');
    } catch (err) {
      this.parsed = undefined;
      this.workspaceRoot = workspaceRoot;
      this.loadError = `读取配置文件失败：${err instanceof Error ? err.message : String(err)}`;
      this.logger.error(this.loadError);
      this._onDidChange.fire();
      return false;
    }

    try {
      this.parsed = parseConfig(text, found, workspaceRoot, this.defaults(), detectFormat(found));
      this.workspaceRoot = workspaceRoot;
      this.loadError = undefined;
      this.logger.info(
        `已加载配置：${found}（${this.parsed.profiles.length} 个服务器：${this.parsed.profiles.map((p) => p.name).join('、')}）`,
      );
    } catch (err) {
      this.parsed = undefined;
      this.workspaceRoot = workspaceRoot;
      this.loadError =
        err instanceof ConfigError
          ? `配置文件有问题：${err.message}`
          : `配置文件解析失败：${err instanceof Error ? err.message : String(err)}`;
      this.logger.error(this.loadError);
      this._onDidChange.fire();
      return false;
    }

    // 之前记住的 profile 如果没了，退回第一个
    const saved = this.context.workspaceState.get<string>(ACTIVE_PROFILE_KEY);
    if (saved && !this.parsed.profiles.some((p) => p.name === saved)) {
      await this.context.workspaceState.update(ACTIVE_PROFILE_KEY, undefined);
    }

    this._onDidChange.fire();
    return true;
  }

  /** 当前使用的服务器配置。 */
  get active(): ServerConfig | undefined {
    const profiles = this.all;
    if (profiles.length === 0) return undefined;
    const saved = this.context.workspaceState.get<string>(ACTIVE_PROFILE_KEY);
    if (saved) {
      const hit = profiles.find((p) => p.name === saved);
      if (hit) return hit;
    }
    const preferred = this.parsed?.defaultProfile;
    if (preferred) {
      const hit = profiles.find((p) => p.name === preferred);
      if (hit) return hit;
    }
    return profiles[0];
  }

  async setActive(name: string): Promise<void> {
    await this.context.workspaceState.update(ACTIVE_PROFILE_KEY, name);
    this._onDidChange.fire();
  }

  /** 按名字找服务器；找不到时返回 undefined（调用方一般回退到 active）。 */
  findProfile(name?: string): ServerConfig | undefined {
    if (!name) return undefined;
    return this.all.find((p) => p.name === name);
  }

  /** 当前生效配置对应的同步根。 */
  roots(): SyncRoot[] {
    const active = this.active;
    const root = this.workspaceRoot;
    if (!active || !root) return [];
    return resolveRoots(root, active);
  }

  /** 当前生效配置对应的忽略规则。 */
  ignore(): IgnoreMatcher {
    return new IgnoreMatcher(this.active?.ignore ?? []);
  }

  /** 配置文件自身不该被上传。 */
  isConfigFile(localPath: string): boolean {
    const target = path.resolve(localPath).toLowerCase();
    return this.candidateConfigPaths().some((p) => path.resolve(p).toLowerCase() === target);
  }

  get isLoaded(): boolean {
    return this.loaded;
  }

  /** 在编辑器里打开配置文件。 */
  async openConfig(createIfMissing: boolean): Promise<void> {
    const candidates = this.candidateConfigPaths();
    if (candidates.length === 0) {
      void vscode.window.showWarningMessage('还没有打开工作区，先打开一个项目文件夹。');
      return;
    }
    let target = candidates.find((p) => fs.existsSync(p));

    if (!target) {
      if (!createIfMissing) {
        void vscode.window.showWarningMessage('配置文件不存在，先执行「生成配置文件模板」。');
        return;
      }
      target = candidates[0];
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      await fs.promises.writeFile(target, defaultConfigText(isYamlPath(target) ? 'yaml' : 'json'), 'utf8');
      this.logger.info(`已生成配置模板：${target}`);
    }

    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
    await vscode.window.showTextDocument(doc);
    await this.fixLanguageMode(doc);
  }
}

function isYamlPath(filePath: string): boolean {
  return /\.ya?ml$/i.test(filePath);
}

export { defaultConfigText };
