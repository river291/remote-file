import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { defaultConfigText, detectFormat, type ConfigSeed } from '../core/config';
import type { Protocol } from '../core/types';
import type { ConfigStore } from './configStore';
import type { ConnectionManager } from './connection';
import type { Logger } from './logger';

/** 各协议的默认端口。FTP 配成 22 是真实踩过的坑，这里按协议给默认值。 */
const DEFAULT_PORT: Record<Protocol, number> = { sftp: 22, ftp: 21, ftps: 21 };

const PROTOCOL_LABEL: Record<Protocol, string> = {
  sftp: 'SFTP（走 SSH，推荐）',
  ftp: 'FTP',
  ftps: 'FTPS（FTP + TLS 加密）',
};

/**
 * 「生成配置文件模板」的向导：逐步问出连接参数，再写出配置。
 *
 * 为什么做这个：手写 JSON 容易把协议和端口配岔（比如协议选 ftp、端口还留着 22），
 * 这种错误要到连接时才发现。向导里端口会**跟着协议自动给默认值**，并且当场校验。
 */
export class ConfigWizard {
  constructor(
    private readonly config: ConfigStore,
    private readonly connection: ConnectionManager,
    private readonly logger: Logger,
  ) {}

  async run(): Promise<void> {
    const existing = this.config.active;

    // ① 协议
    const protocol = await this.pickProtocol(existing?.protocol);
    if (!protocol) return;

    // ② 主机
    const host = await this.ask({
      title: '配置服务器（1/6）主机地址',
      prompt: '服务器地址或域名',
      value: existing?.host ?? '',
      placeHolder: '例如 192.168.1.100 或 ftp.example.com',
      required: '请输入主机地址',
    });
    if (host === undefined) return;

    // ③ 端口 —— 按协议给默认值，这是最容易配错的一项
    const port = await this.askPort(protocol, existing?.port);
    if (port === undefined) return;

    // ④ 用户名
    const username = await this.ask({
      title: '配置服务器（3/6）用户名',
      prompt: '登录用户名',
      value: existing?.username ?? '',
      placeHolder: protocol === 'sftp' ? '例如 root' : '例如 example_com（宝塔会按站点名生成）',
      required: '请输入用户名',
    });
    if (username === undefined) return;

    // ⑤ 密码（可以留空：SFTP 用密钥时不填）
    const password = await vscode.window.showInputBox({
      title: '配置服务器（4/6）密码',
      prompt:
        protocol === 'sftp'
          ? '登录密码（用密钥登录可以直接回车跳过，之后在配置里填 privateKeyPath）'
          : '登录密码（直接回车表示不写进配置）',
      password: true,
      value: existing?.password ?? '',
      ignoreFocusOut: true,
    });
    if (password === undefined) return;

    // ⑥ 远程目录
    const remotePath = await this.ask({
      title: '配置服务器（5/6）远程目录',
      prompt: '本地目录里的文件会传到这个远程目录（以 / 开头）',
      value: existing?.remotePath ?? '/',
      placeHolder: '例如 / 或 /www/wwwroot/example.com',
      required: '必须填一个以 / 开头的远程路径',
      validate: (v) => (v.trim().startsWith('/') ? undefined : '远程路径要以 / 开头'),
    });
    if (remotePath === undefined) return;

    // ⑦ 本地目录
    const context = await this.pickContext(existing?.context);
    if (context === undefined) return;

    // ⑧ 写盘
    const seed: ConfigSeed = { protocol, host, port, username, password, remotePath, context };
    const written = await this.write(seed);
    if (!written) return;

    await this.config.refresh();
    this.logger.info(`向导已写入配置：${written}`);

    // ⑨ 顺手测一下连接 —— 「配完了连不上」是最常见的下一步
    const pick = await vscode.window.showInformationMessage(
      `配置已写入 ${path.basename(written)}。要现在测一下连接吗？`,
      '测试连接',
      '不用',
    );
    if (pick === '测试连接') await this.testConnection();
  }

  // ─────────────────────────── 各步 ───────────────────────────

  private async pickProtocol(current?: Protocol): Promise<Protocol | undefined> {
    const items: (vscode.QuickPickItem & { value: Protocol })[] = (['sftp', 'ftp', 'ftps'] as Protocol[]).map(
      (value) => ({
        label: PROTOCOL_LABEL[value],
        description: value === current ? '（当前配置）' : `默认端口 ${DEFAULT_PORT[value]}`,
        value,
      }),
    );
    const pick = await vscode.window.showQuickPick(items, {
      title: '配置服务器（1/7）协议',
      placeHolder: '选择连接协议',
      ignoreFocusOut: true,
    });
    return pick?.value;
  }

  private async askPort(protocol: Protocol, current?: number): Promise<number | undefined> {
    const fallback = DEFAULT_PORT[protocol];
    // 如果已有配置的端口和当前协议不匹配，就以协议默认值为准（避免把 ftp 配成 22）
    const initial = current && current !== 22 && current !== 21 ? current : fallback;
    const raw = await this.ask({
      title: '配置服务器（2/6）端口',
      prompt: `${PROTOCOL_LABEL[protocol]} 默认用 ${fallback}`,
      value: String(initial),
      required: '请输入端口号',
      validate: (v) => {
        const n = Number(v.trim());
        if (!Number.isInteger(n) || n < 1 || n > 65535) return '端口要是 1~65535 之间的整数';
        return undefined;
      },
    });
    if (raw === undefined) return undefined;
    return Number(raw.trim());
  }

  private async pickContext(current?: string): Promise<string | undefined> {
    const root = this.config.root;
    const items: (vscode.QuickPickItem & { value?: string; action?: 'browse' | 'type' })[] = [
      { label: '.', description: '整个工作区', value: '.' },
    ];
    if (root) {
      const skip = new Set(['.git', 'node_modules', '.vscode']);
      let dirs: string[] = [];
      try {
        dirs = (await fs.promises.readdir(root, { withFileTypes: true }))
          .filter((e) => e.isDirectory() && !skip.has(e.name) && !e.name.startsWith('.'))
          .map((e) => e.name)
          .slice(0, 20);
      } catch {
        dirs = [];
      }
      for (const d of dirs) items.push({ label: `./${d}/`, description: '只同步这个子目录', value: `./${d}/` });
    }
    items.push({ label: '$(folder) 选择其它文件夹…', action: 'browse' });
    items.push({ label: '$(pencil) 手动输入…', action: 'type' });

    const pick = await vscode.window.showQuickPick(items, {
      title: '配置服务器（6/6）本地目录',
      placeHolder: current ? `当前：${current}（选择要同步的本地目录）` : '选择要同步的本地目录',
      ignoreFocusOut: true,
    });
    if (!pick) return undefined;

    if (pick.action === 'browse') {
      const chosen = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: '同步这个目录',
      });
      if (!chosen || chosen.length === 0) return undefined;
      const rel = root ? path.relative(root, chosen[0].fsPath).replace(/\\/g, '/') : '';
      if (!root || rel === '') return '.';
      if (rel.startsWith('..')) {
        void vscode.window.showWarningMessage('本地目录必须在当前工作区里面。');
        return undefined;
      }
      return `./${rel}/`;
    }

    if (pick.action === 'type') {
      return this.ask({
        title: '本地目录',
        prompt: '相对工作区的路径，"." 表示整个工作区',
        value: current ?? '.',
        required: '请输入本地目录',
      });
    }
    return pick.value;
  }

  /** 统一的输入框：必填校验 + 自定义校验。 */
  private async ask(opts: {
    title: string;
    prompt?: string;
    value?: string;
    placeHolder?: string;
    required?: string;
    validate?: (v: string) => string | undefined;
  }): Promise<string | undefined> {
    return vscode.window.showInputBox({
      title: opts.title,
      prompt: opts.prompt,
      value: opts.value ?? '',
      placeHolder: opts.placeHolder,
      ignoreFocusOut: true,
      validateInput: (raw) => {
        const v = raw.trim();
        if (opts.required && v === '') return opts.required;
        return opts.validate?.(v);
      },
    });
  }

  // ─────────────────────────── 写盘 / 测连接 ───────────────────────────

  private async write(seed: ConfigSeed): Promise<string | undefined> {
    const candidates = this.config.candidateConfigPaths();
    if (candidates.length === 0) {
      void vscode.window.showWarningMessage('还没有打开工作区，先打开一个项目文件夹。');
      return undefined;
    }
    const target = candidates[0];

    if (fs.existsSync(target)) {
      const pick = await vscode.window.showWarningMessage(
        `配置文件已存在，要用向导的填写内容覆盖它吗？\n${target}\n\n（原有注释会保留，只有你填的那几项会被替换）`,
        { modal: true },
        '覆盖写入',
      );
      if (pick !== '覆盖写入') {
        void vscode.window.showInformationMessage('已取消，没有改动配置文件。');
        return undefined;
      }
      const open = vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && d.uri.fsPath === target);
      if (open?.isDirty) {
        void vscode.window.showWarningMessage('配置文件有未保存的改动，先保存一下再来（免得互相覆盖）。');
        return undefined;
      }
    }

    const format = detectFormat(target);
    const text = defaultConfigText(format, seed);
    try {
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      await fs.promises.writeFile(target, text, 'utf8');
    } catch (err) {
      void vscode.window.showErrorMessage(`写配置文件失败：${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }

    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
    await vscode.window.showTextDocument(doc);
    void vscode.window.setStatusBarMessage('$(check) 配置已生成', 3000);
    return target;
  }

  private async testConnection(): Promise<void> {
    const profile = this.config.active;
    if (!profile) return;
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `正在连接 ${profile.host}:${profile.port}…` },
      async () => {
        try {
          await this.connection.get(profile, true);
          this.logger.info('连接测试成功');
          void vscode.window.showInformationMessage('连接成功 ✓');
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.logger.error('连接测试失败', err);
          void vscode.window
            .showErrorMessage(`连接失败：${message}`, '查看日志', '查看协议细节')
            .then((pick) => {
              if (pick === '查看日志') this.logger.show(false);
              if (pick === '查看协议细节') this.logger.showTrace(false);
            });
        }
      },
    );
  }
}
