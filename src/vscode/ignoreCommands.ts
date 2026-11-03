import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { parseConfigObject, detectFormat, type ConfigFormat } from '../core/config';
import { addIgnoreRule, listIgnoreRules, removeIgnoreRule, typeRuleFor, type IgnoreEditResult } from '../core/ignoreEdit';
import { matchLocal } from '../core/pathMap';
import type { ConfigStore } from './configStore';
import type { Logger } from './logger';

/**
 * 右键菜单里的「添加到上传忽略规则 / 从上传忽略规则中移除」。
 *
 * 直接在 `.vscode/sftp.json`（或 .yml）里改 `ignore` 数组 —— 用户不用自己去翻配置。
 * 改的是**文本**而不是"解析再序列化"，所以文件里的注释和排版都不受影响
 * （具体逻辑在 core/ignoreEdit.ts）。
 */
export class IgnoreRuleCommands {
  constructor(
    private readonly config: ConfigStore,
    private readonly logger: Logger,
  ) {}

  /** 右键目录：「忽略该目录」—— 整棵子树都不传。 */
  async ignoreFolder(uri?: vscode.Uri): Promise<void> {
    const target = await this.resolveTarget(uri, 'folder');
    if (!target) return;
    await this.apply((text, format) => addIgnoreRule(text, format, target.rule), 'add', target.rule);
  }

  /** 右键文件：「忽略该文件」—— 只忽略这一个路径。 */
  async ignoreFile(uri?: vscode.Uri): Promise<void> {
    const target = await this.resolveTarget(uri, 'file');
    if (!target) return;
    await this.apply((text, format) => addIgnoreRule(text, format, target.rule), 'add', target.rule);
  }

  /**
   * 右键文件：「忽略该类型文件」—— 按扩展名忽略，比如 `main.go` → `**​/*.go`。
   * 提示里会把生成的规则写出来，让用户知道到底加了什么。
   */
  async ignoreFileType(uri?: vscode.Uri): Promise<void> {
    const target = await this.resolveTarget(uri, 'file');
    if (!target) return;
    const rule = typeRuleFor(path.basename(target.localPath));
    if (!rule) {
      void vscode.window.showInformationMessage(
        `${path.basename(target.localPath)} 没有扩展名，没法按类型忽略。用「忽略该文件」可以只忽略这一个。`,
      );
      return;
    }
    await this.apply((text, format) => addIgnoreRule(text, format, rule), 'add', rule, {
      note: `会忽略所有 .${rule.slice(rule.lastIndexOf('.') + 1)} 文件`,
    });
  }

  /**
   * 右键「从上传忽略规则中移除」。
   * 从命令面板调用（没有具体路径）时，弹一个列表让用户挑一条规则。
   */
  async remove(uri?: vscode.Uri): Promise<void> {
    // 文件还是目录都能移除：只按右键路径去找覆盖它的那条规则
    const localPath = this.localPathOf(uri, true);
    if (!localPath) {
      const rule = await this.pickRule();
      if (!rule) return;
      await this.apply((text, format) => removeIgnoreRule(text, format, rule), 'remove', rule);
      return;
    }

    const match = matchLocal(this.config.roots(), localPath);
    if (!match) {
      void vscode.window.showWarningMessage('这个路径不在同步范围内（不在 context 目录下）。');
      return;
    }
    const rule = this.config.ignore().match(match.relative);
    if (!rule) {
      void vscode.window.showInformationMessage(`这个路径当前没有被忽略：${match.relative}`);
      return;
    }
    await this.apply((text, format) => removeIgnoreRule(text, format, rule), 'remove', rule);
  }

  // ─────────────────────────── 内部 ───────────────────────────

  /**
   * 取出要处理的本地路径。
   * `allowEditorFallback`：从命令面板调用时没有 uri，就退回"当前打开的文件"；
   * 但"忽略该目录"不能这么退，否则会拿一个文件当目录。
   */
  private localPathOf(uri: vscode.Uri | undefined, allowEditorFallback: boolean): string | undefined {
    if (uri && uri.scheme === 'file') return uri.fsPath;
    if (allowEditorFallback) {
      const editor = vscode.window.activeTextEditor;
      if (editor && editor.document.uri.scheme === 'file') return editor.document.uri.fsPath;
    }
    return undefined;
  }

  /** 把右键的路径换算成一条忽略规则（相对 context 目录的 POSIX 路径）。 */
  private async resolveTarget(
    uri: vscode.Uri | undefined,
    want: 'file' | 'folder',
  ): Promise<{ localPath: string; rule: string } | undefined> {
    let localPath = this.localPathOf(uri, want === 'file');

    // 从命令面板执行「忽略该目录」时没有具体路径 → 弹一个文件夹选择框
    if (!localPath && want === 'folder') {
      const picked = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: '忽略这个目录',
      });
      localPath = picked?.[0]?.fsPath;
    }

    if (!localPath) {
      void vscode.window.showWarningMessage(
        want === 'folder'
          ? '先指定一个目录：在资源管理器里右键它，或从命令面板执行后选择。'
          : '先指定一个文件：在资源管理器里右键它，或在编辑器里打开它。',
      );
      return undefined;
    }

    // 菜单已经按文件/目录分开了，这里再兜一层：万一入口不对，说清楚而不是加错规则
    const stat = await fs.promises.stat(localPath).catch(() => undefined);
    const isDir = stat?.isDirectory() ?? false;
    if (want === 'folder' && !isDir) {
      void vscode.window.showWarningMessage('这不是一个目录。要只忽略这个文件，用「忽略该文件」。');
      return undefined;
    }
    if (want === 'file' && isDir) {
      void vscode.window.showWarningMessage('这是一个目录。要忽略整个目录，用「忽略该目录」。');
      return undefined;
    }

    const match = matchLocal(this.config.roots(), localPath);
    if (!match) {
      void vscode.window.showWarningMessage('这个路径不在同步范围内（不在 context 目录下）。');
      return undefined;
    }
    if (match.relative === '') {
      void vscode.window.showWarningMessage('这是同步根目录本身，不能整体忽略。');
      return undefined;
    }
    return { localPath, rule: match.relative };
  }

  /** 命令面板入口：列出当前规则让用户挑一条。 */
  private async pickRule(): Promise<string | undefined> {
    const file = await this.readConfig();
    if (!file) return undefined;
    const rules = listIgnoreRules(file.text, file.format);
    if (rules.length === 0) {
      void vscode.window.showInformationMessage('当前没有忽略规则。');
      return undefined;
    }
    return vscode.window.showQuickPick(rules, {
      placeHolder: '选择要移除的忽略规则（也可在资源管理器里右键那个文件/目录）',
      title: '从上传忽略规则中移除',
    });
  }

  private async readConfig(): Promise<{ path: string; text: string; format: ConfigFormat } | undefined> {
    const path = this.config.configPath ?? this.config.candidateConfigPaths().find((p) => fs.existsSync(p));
    if (!path || !fs.existsSync(path)) {
      void vscode.window.showWarningMessage('还没找到配置文件。先执行「生成配置文件模板」，或检查 remoteFile.configFile 设置。');
      return undefined;
    }
    let text: string;
    try {
      text = await fs.promises.readFile(path, 'utf8');
    } catch (err) {
      void vscode.window.showErrorMessage(
        `读配置文件失败：${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    }
    return { path, text, format: detectFormat(path) };
  }

  private async apply(
    transform: (text: string, format: ConfigFormat) => IgnoreEditResult,
    action: 'add' | 'remove',
    rule: string,
    extra: { note?: string } = {},
  ): Promise<void> {
    const file = await this.readConfig();
    if (!file) return;

    const result = transform(file.text, file.format);
    if (result.outcome === 'already-present') {
      void vscode.window.showInformationMessage(`已经在忽略规则里了：${rule}`);
      return;
    }
    if (result.outcome === 'not-present') {
      // 规则可能来自 VSCode 设置而不是配置文件 —— 那样在这里删不掉，得说清楚
      const fromSettings = this.config.ignore().match(rule) === rule && !listIgnoreRules(file.text, file.format).includes(rule);
      void vscode.window.showInformationMessage(
        fromSettings
          ? `这条规则来自 VSCode 设置（remoteFile.ignore），要在设置里改：${rule}`
          : `忽略规则里没有这一条：${rule}`,
      );
      return;
    }
    if (result.outcome === 'unsupported') {
      void vscode.window.showWarningMessage(
        '配置文件的 ignore 字段不是规则列表，我不敢自动改（怕写坏），请手动编辑。',
      );
      return;
    }

    // 写盘前自检：结果必须仍然能被解析，而且规则确实按预期增/减了。
    // 文本手术万一哪里没排好看，也不允许把用户的配置文件改坏。
    if (!this.selfCheck(result.text, file.format, action, rule)) {
      this.logger.error(`忽略规则自检未通过，已放弃写入（配置文件未改动）：${file.path}`);
      void vscode.window.showErrorMessage('改完自检没通过（结果会写坏配置），已放弃写入，配置文件未改动。');
      return;
    }

    if (!(await this.write(file.path, result.text))) return;
    await this.config.refresh();

    const verb = action === 'add' ? '已加入忽略规则' : '已从忽略规则移除';
    const detail = extra.note ? `（${extra.note}）` : '';
    this.logger.info(`${verb}：${rule}${detail}（写入 ${file.path}）`);
    void vscode.window.showInformationMessage(
      action === 'add'
        ? `${verb}：${rule}${detail}\n之后这个路径不会被上传，也不会因为本地删除去删远程。`
        : `${verb}：${rule}`,
    );
  }

  private selfCheck(text: string, format: ConfigFormat, action: 'add' | 'remove', rule: string): boolean {
    try {
      parseConfigObject(text, format, 'self-check');
    } catch {
      return false;
    }
    const rules = listIgnoreRules(text, format);
    return action === 'add' ? rules.includes(rule) : !rules.includes(rule);
  }

  /**
   * 写回配置文件。返回 false 表示没写（调用方别报成功）。
   *
   * 文件在编辑器里开着的时候走 WorkspaceEdit —— 这样编辑器的内容会同步更新、还能 Ctrl+Z 撤销；
   * 直接写磁盘会让编辑器里那份变成过期内容，用户一保存就把改动覆盖掉了。
   */
  private async write(path: string, text: string): Promise<boolean> {
    const open = vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && d.uri.fsPath === path);
    if (open) {
      if (open.isDirty) {
        void vscode.window.showWarningMessage('配置文件有未保存的改动，先保存一下再来（免得互相覆盖）。');
        return false;
      }
      const full = new vscode.Range(open.positionAt(0), open.positionAt(open.getText().length));
      const edit = new vscode.WorkspaceEdit();
      edit.replace(open.uri, full, text);
      const applied = await vscode.workspace.applyEdit(edit);
      if (!applied) return false;
      return await open.save();
    }
    try {
      await fs.promises.writeFile(path, text, 'utf8');
      return true;
    } catch (err) {
      void vscode.window.showErrorMessage(
        `写配置文件失败：${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }
}
