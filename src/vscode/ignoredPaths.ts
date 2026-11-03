import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { posixJoin } from '../core/posixPath';
import type { ConfigStore } from './configStore';
import type { Logger } from './logger';

/**
 * 菜单 `when` 条件用的上下文键：**当前被忽略掉的绝对路径集合**。
 *
 * 用来解决一个具体的体验问题：右键一个**已经被忽略**的目录时，菜单里还摆着
 * 「忽略该目录」，点了只会说"已经在忽略规则里了" —— 纯属噪音。
 *
 * VSCode 的 when 子句支持 `in` / `not in`，可以拿资源路径去一个动态上下文键里查：
 *
 *     "when": "explorerResourceIsFolder && resourcePath not in remoteFile.ignoredPaths"
 *
 * 这样「忽略该项」只在没被忽略时出现，「从忽略规则中移除」只在已被忽略时出现。
 * （注意：文件资源管理器右键菜单拿不到"扩展自己定义的、按资源区分"的状态，
 *   `in` 是官方给的唯一可靠办法 —— 详见 when-clause-contexts 文档。）
 */
export const IGNORED_PATHS_KEY = 'remoteFile.ignoredPaths';

/** 集合上限。超过了就只记前 N 条：漏掉的路径顶多多显示一个没用的菜单项，不会出错。 */
const MAX_PATHS = 20000;

/**
 * 重新计算并发布忽略路径集合。
 * 在配置加载/变化后调用（`config.onDidChange`），以及每次改完忽略规则之后。
 */
export async function publishIgnoredPaths(config: ConfigStore, logger: Logger): Promise<void> {
  const ignore = config.ignore();
  const roots = config.roots();

  // 没写任何忽略规则就不用扫了
  if (ignore.size === 0 || roots.length === 0) {
    await setIgnoredPaths([]);
    return;
  }

  const collected: string[] = [];
  let capped = false;

  const visit = async (dir: string, relDir: string): Promise<void> => {
    if (collected.length >= MAX_PATHS) {
      capped = true;
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return; // 读不到就跳过（权限、被删了之类）
    }
    for (const entry of entries) {
      if (collected.length >= MAX_PATHS) {
        capped = true;
        return;
      }
      const abs = path.join(dir, entry.name);
      const rel = relDir === '' ? entry.name : posixJoin(relDir, entry.name);
      if (ignore.ignores(rel)) {
        collected.push(abs);
        // 被忽略的目录里的东西同样是被忽略的，要继续记下去 ——
        // 否则右键"忽略目录里的某个文件"时，菜单判断会失准
        if (entry.isDirectory()) await visit(abs, rel);
        continue;
      }
      if (entry.isDirectory()) await visit(abs, rel);
    }
  };

  for (const root of roots) {
    if (!fs.existsSync(root.localDir)) continue;
    await visit(root.localDir, '');
  }

  await setIgnoredPaths(collected.flatMap(formsOf));
  if (capped) {
    logger.warn(`忽略路径超过 ${MAX_PATHS} 条，菜单对部分路径的判断可能不准（不影响功能，只影响菜单显示）。`);
  }
}

async function setIgnoredPaths(paths: string[]): Promise<void> {
  try {
    await vscode.commands.executeCommand('setContext', IGNORED_PATHS_KEY, paths);
  } catch {
    /* 设置不了就算了：没有这个键时 `in` 恒为 false，菜单退回"全部显示"，功能不受影响 */
  }
}

/**
 * 把一个绝对路径翻译成它可能出现在 `resourcePath` 里的**所有形式**。
 *
 * 这里踩过一个坑，值得写清楚：VSCode 的 `resourcePath` 实际取值是
 *
 *     uriToPath(o) { return o.scheme === 'file' ? o.fsPath : o.path }
 *
 * 也就是说 —— **本地文件用的是 `fsPath`**，在 Windows 上是 `e:\www\项目\.idea`（反斜杠），
 * 而不是 URI 的 path（`/e:/www/项目/.idea`，正斜杠）。一开始只发布了后者，
 * 结果 `in` / `not in` 永远为假，菜单静默退化成"全都显示"，
 * 表现就是"已经忽略的目录还显示「忽略该目录」"。
 *
 * 所以两种形式都发：`fsPath` 匹配本地文件（常态），`path` 匹配非 file scheme（远程/虚拟工作区）。
 */
function formsOf(absPath: string): string[] {
  const uri = vscode.Uri.file(absPath);
  const forms = new Set<string>([uri.fsPath, uri.path]);
  return [...forms];
}
