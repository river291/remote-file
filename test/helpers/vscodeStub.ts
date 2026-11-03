/**
 * VSCode API 的替身模块。
 *
 * 两个用途：
 *   1. `test/sync.test.ts` 之类的测试通过 esbuild 的 `--alias:vscode=...`
 *      把源码里的 `import * as vscode from 'vscode'` 指到这里，
 *      于是 ConfigStore / SyncService / FileSyncWatcher 可以在纯 Node 里跑起来。
 *   2. `test/bundle.test.ts` 用它替换 dist/extension.js 里的 `require('vscode')`。
 *
 * 这里的导出名刻意和真实的 vscode 模块保持一致；测试用的控制钩子统一挂在
 * `__vscodeTest` 下面，避免和真实 API 混淆。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export const version = '1.95.0';

export class Disposable {
  constructor(private readonly fn: () => void = () => undefined) {}
  dispose(): void {
    this.fn();
  }
}

export class EventEmitter<T> {
  private readonly listeners = new Set<(e: T) => unknown>();
  readonly event = (listener: (e: T) => unknown): Disposable => {
    this.listeners.add(listener);
    return new Disposable(() => this.listeners.delete(listener));
  };
  fire(value: T): void {
    for (const l of [...this.listeners]) l(value);
  }
  dispose(): void {
    this.listeners.clear();
  }
}

export class TreeItem {
  label?: unknown;
  collapsibleState?: unknown;
  contextValue?: string;
  iconPath?: unknown;
  description?: string;
  tooltip?: unknown;
  command?: unknown;
  constructor(label: unknown, collapsibleState?: unknown) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

export class ThemeIcon {
  constructor(
    public id: string,
    public color?: unknown,
  ) {}
}

export class ThemeColor {
  constructor(public id: string) {}
}

export class RelativePattern {
  constructor(
    public base: unknown,
    public pattern: string,
  ) {}
}

export const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 } as const;
export const StatusBarAlignment = { Left: 1, Right: 2 } as const;
export const ProgressLocation = { SourceControl: 1, Window: 10, Notification: 15 } as const;
export const FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 } as const;
export const ViewColumn = { Active: -1, Beside: -2, One: 1, Two: 2 } as const;

// ─────────────────────────── URI ───────────────────────────
// 刻意贴近 VSCode 真实实现（src/vs/base/common/uri.ts）：
//   - parse() 会把 `//` 之后的内容当 authority，并把 path 百分号解码
//   - from() 原样保存 components，不编码也不解码
// 之前这里的 parse 是个只返回空 path 的假实现，结果"拼字符串拼出 //authority
// 把第一层目录吞掉"这个 bug 从测试眼皮底下溜过去了，所以必须写实。

const URI_REGEXP = /^(([^:/?#]+?):)?(\/\/([^/?#]*))?([^?#]*)(\?([^#]*))?(#(.*))?/;

function encodeUriComponentFast(value: string, isPath: boolean): string {
  let res = '';
  for (const ch of value) {
    if (/[A-Za-z0-9\-._~]/.test(ch) || (isPath && ch === '/')) res += ch;
    else res += encodeURIComponent(ch);
  }
  return res;
}

function percentDecode(value: string): string {
  if (!/%[0-9A-Za-z][0-9A-Za-z]/.test(value)) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export class Uri {
  constructor(
    readonly scheme: string,
    readonly authority: string,
    readonly path: string,
    readonly query: string,
    readonly fragment: string,
  ) {}

  get fsPath(): string {
    return this.path.replace(/\//g, path.sep);
  }

  toString(): string {
    let res = '';
    if (this.scheme) res += this.scheme + ':';
    if (this.authority || this.scheme === 'file') res += '//';
    if (this.authority) res += this.authority;
    if (this.path) res += encodeUriComponentFast(this.path, true);
    if (this.query) res += '?' + encodeUriComponentFast(this.query, false);
    if (this.fragment) res += '#' + encodeUriComponentFast(this.fragment, false);
    return res;
  }

  with(change: {
    scheme?: string;
    authority?: string | null;
    path?: string | null;
    query?: string | null;
    fragment?: string | null;
  }): Uri {
    return new Uri(
      change.scheme ?? this.scheme,
      change.authority ?? this.authority,
      change.path ?? this.path,
      change.query ?? this.query,
      change.fragment ?? this.fragment,
    );
  }

  toJSON(): { scheme: string; authority: string; path: string; query: string; fragment: string } {
    return {
      scheme: this.scheme,
      authority: this.authority,
      path: this.path,
      query: this.query,
      fragment: this.fragment,
    };
  }

  static parse(value: string): Uri {
    const m = URI_REGEXP.exec(value);
    if (!m) return new Uri('', '', '', '', '');
    return new Uri(
      m[2] ?? '',
      percentDecode(m[4] ?? ''),
      percentDecode(m[5] ?? ''),
      percentDecode(m[7] ?? ''),
      percentDecode(m[9] ?? ''),
    );
  }

  /** 和 VSCode 一致：components 原样保存。 */
  static from(components: { scheme: string; authority?: string; path?: string; query?: string; fragment?: string }): Uri {
    return new Uri(
      components.scheme ?? '',
      components.authority ?? '',
      components.path ?? '',
      components.query ?? '',
      components.fragment ?? '',
    );
  }

  static file(p: string): Uri {
    return new Uri('file', '', p.replace(/\\/g, '/'), '', '');
  }

  static joinPath(base: Uri, ...parts: string[]): Uri {
    return base.with({ path: [base.path.replace(/\/+$/, ''), ...parts].join('/') });
  }
}

export function isUri(thing: unknown): thing is Uri {
  return thing instanceof Uri;
}

// ─────────────────────────── 测试控制面 ───────────────────────────

interface Waiter {
  kind: 'save' | 'change' | 'create' | 'delete' | 'rename' | 'config' | 'folders' | 'open';
  fn: (arg: unknown) => unknown;
}

const state = {
  workspaceFolder: undefined as string | undefined,
  settings: new Map<string, unknown>(),
  watchers: new Set<{ onDidCreate: Set<(u: unknown) => unknown>; onDidDelete: Set<(u: unknown) => unknown> }>(),
  waiters: [] as Waiter[],
  outputLines: [] as string[],
  /** 「Remote File - 协议细节」频道的内容，和主日志分开记。 */
  traceLines: [] as string[],
  errorMessages: [] as string[],
  infoMessages: [] as string[],
  warningMessages: [] as string[],
  registeredCommands: [] as string[],
  /** setContext 设置过的上下文键，用来断言 when 子句依赖的动态值。 */
  contextKeys: new Map<string, unknown>(),
  /** 向导之类的顺序问答：测试按顺序塞答案，每次调用取一个。 */
  inputAnswers: [] as unknown[],
  quickPickAnswers: [] as unknown[],
  openDialogAnswers: [] as unknown[],
  inputBoxCalls: [] as unknown[],
  quickPickCalls: [] as unknown[],
  openDialogCalls: [] as unknown[],
  commandHandlers: new Map<string, (...args: unknown[]) => unknown>(),
  /** 弹窗（showWarningMessage 带选项时）自动返回的按钮文字。 */
  modalAnswer: undefined as string | undefined,
  statOverride: undefined as ((p: string) => { type: number } | undefined) | undefined,
};

const disposable = () => new Disposable();

function configSection() {
  return {
    get: <T>(key: string, fallback?: T): T => (state.settings.has(key) ? (state.settings.get(key) as T) : (fallback as T)),
    has: (key: string) => state.settings.has(key),
    update: async (key: string, value: unknown) => {
      state.settings.set(key, value);
    },
    inspect: () => undefined,
  };
}

function makeWatcher() {
  const entry = { onDidCreate: new Set<(u: unknown) => unknown>(), onDidDelete: new Set<(u: unknown) => unknown>() };
  state.watchers.add(entry);
  return {
    onDidCreate: (fn: (u: unknown) => unknown) => {
      entry.onDidCreate.add(fn);
      return new Disposable(() => entry.onDidCreate.delete(fn));
    },
    onDidDelete: (fn: (u: unknown) => unknown) => {
      entry.onDidDelete.add(fn);
      return new Disposable(() => entry.onDidDelete.delete(fn));
    },
    onDidChange: () => disposable(),
    dispose: () => state.watchers.delete(entry),
  };
}

export const workspace = {
  get workspaceFolders() {
    return state.workspaceFolder
      ? [{ uri: { fsPath: state.workspaceFolder, scheme: 'file' }, name: path.basename(state.workspaceFolder), index: 0 }]
      : undefined;
  },
  getConfiguration: () => configSection(),
  registerTextDocumentContentProvider: () => disposable(),
  createFileSystemWatcher: () => makeWatcher(),
  onDidOpenTextDocument: (fn: (d: unknown) => unknown) => {
    state.waiters.push({ kind: 'open', fn });
    return disposable();
  },
  textDocuments: [] as unknown[],
  openTextDocument: async (uri: unknown) => ({ uri, getText: () => '', lineCount: 0 }),
  applyEdit: async () => true,
  fs: {
    stat: async (uri: { fsPath: string }) => {
      if (state.statOverride) {
        const forced = state.statOverride(uri.fsPath);
        if (forced) return forced;
      }
      const st = fs.statSync(uri.fsPath);
      return { type: st.isDirectory() ? FileType.Directory : FileType.File, ctime: 0, mtime: 0, size: st.size };
    },
    readFile: async (uri: { fsPath: string }) => fs.readFileSync(uri.fsPath),
    writeFile: async (uri: { fsPath: string }, content: Uint8Array) => fs.writeFileSync(uri.fsPath, content),
  },
  onDidSaveTextDocument: (fn: (d: unknown) => unknown) => {
    state.waiters.push({ kind: 'save', fn });
    return disposable();
  },
  onDidChangeConfiguration: (fn: (e: unknown) => unknown) => {
    state.waiters.push({ kind: 'config', fn });
    return disposable();
  },
  onDidChangeWorkspaceFolders: (fn: (e: unknown) => unknown) => {
    state.waiters.push({ kind: 'folders', fn });
    return disposable();
  },
  onDidRenameFiles: (fn: (e: unknown) => unknown) => {
    state.waiters.push({ kind: 'rename', fn });
    return disposable();
  },
};

export const window = {
  createOutputChannel: (name?: string) => {
    // 「协议细节」频道单独存，这样测试能断言"协议往来不会漏进主日志"
    const sink = typeof name === 'string' && name.includes('协议') ? state.traceLines : state.outputLines;
    return {
      name,
      appendLine: (line: string) => sink.push(line),
      append: (line: string) => sink.push(line),
      replace: () => undefined,
      clear: () => undefined,
      show: () => undefined,
      hide: () => undefined,
      dispose: () => undefined,
    };
  },
  createTreeView: () => ({
    dispose: () => undefined,
    visible: false,
    onDidChangeVisibility: () => disposable(),
    reveal: async () => undefined,
  }),
  createStatusBarItem: () => ({
    text: '',
    tooltip: '',
    command: '',
    backgroundColor: undefined,
    show: () => undefined,
    hide: () => undefined,
    dispose: () => undefined,
  }),
  registerTreeDataProvider: () => disposable(),
  showInformationMessage: async (msg: string) => {
    state.infoMessages.push(msg);
    return undefined;
  },
  showWarningMessage: async (msg: string, ...rest: unknown[]) => {
    state.warningMessages.push(msg);
    const hasOptions = rest.some((r) => r && typeof r === 'object' && 'modal' in (r as object));
    if (hasOptions) return state.modalAnswer;
    return undefined;
  },
  showErrorMessage: async (msg: string) => {
    state.errorMessages.push(msg);
    return undefined;
  },
  showQuickPick: async (items: unknown, options?: unknown) => {
    state.quickPickCalls.push({ items, options });
    if (state.quickPickAnswers.length === 0) return undefined;
    const answer = state.quickPickAnswers.shift();
    // 可以给"标签字符串"，也可以给"要挑的那一项的下标"
    if (typeof answer === 'number') return Array.isArray(items) ? items[answer] : undefined;
    if (typeof answer === 'string' && Array.isArray(items)) {
      return (items as { label?: string; value?: unknown }[]).find((i) => i?.label === answer);
    }
    return answer;
  },
  showInputBox: async (options?: { title?: string; value?: string; validateInput?: (v: string) => unknown }) => {
    state.inputBoxCalls.push(options);
    if (state.inputAnswers.length === 0) return undefined;
    const raw = String(state.inputAnswers.shift() ?? '');
    // 尊重 validateInput：不合法就当作"用户没通过校验"，返回 undefined（等价于取消）
    if (options?.validateInput && options.validateInput(raw)) return undefined;
    return raw;
  },
  showOpenDialog: async (options?: unknown) => {
    state.openDialogCalls.push(options);
    const answer = state.openDialogAnswers.shift();
    return answer === undefined ? undefined : [{ fsPath: answer }];
  },
  showTextDocument: async () => undefined,
  setStatusBarMessage: () => disposable(),
  withProgress: async (_opts: unknown, task: (p: unknown, token: unknown) => Promise<unknown>) =>
    task({ report: () => undefined }, { isCancellationRequested: false, onCancellationRequested: () => disposable() }),
  get activeTextEditor() {
    return undefined;
  },
};

export const commands = {
  registerCommand: (id: string, handler: (...args: unknown[]) => unknown) => {
    state.registeredCommands.push(id);
    state.commandHandlers.set(id, handler);
    return new Disposable(() => state.commandHandlers.delete(id));
  },
  executeCommand: async (id: string, ...args: unknown[]) => {
    // setContext 是内置命令，用来给 when 子句喂动态值，不是扩展注册的命令
    if (id === 'setContext') {
      const [key, value] = args as [string, unknown];
      state.contextKeys.set(String(key), value);
      return undefined;
    }
    const fn = state.commandHandlers.get(id);
    if (!fn) throw new Error(`命令没有注册：${id}`);
    return fn(...args);
  },
  getCommands: async () => [...state.commandHandlers.keys()],
};

export const env = {
  clipboard: { writeText: async () => undefined },
  openExternal: async () => true,
};

/** 记录 setTextDocumentLanguage 的调用，方便测试断言"配置文件切到了带注释的模式"。 */
export const languageModes: { uri: string; languageId: string }[] = [];

export const languages = {
  setTextDocumentLanguage: async (doc: { uri?: { fsPath?: string }; languageId?: string }, languageId: string) => {
    languageModes.push({ uri: doc?.uri?.fsPath ?? '', languageId });
    if (doc && typeof doc === 'object') doc.languageId = languageId;
    return doc;
  },
  getLanguages: async () => [],
};

// ─────────────────────────── 测试钩子 ───────────────────────────

export const __vscodeTest = {
  state,

  reset(): void {
    state.workspaceFolder = undefined;
    state.settings.clear();
    state.watchers.clear();
    state.waiters.length = 0;
    state.outputLines.length = 0;
    state.traceLines.length = 0;
    state.errorMessages.length = 0;
    state.infoMessages.length = 0;
    state.warningMessages.length = 0;
    state.registeredCommands.length = 0;
    state.contextKeys.clear();
    state.inputAnswers.length = 0;
    state.quickPickAnswers.length = 0;
    state.openDialogAnswers.length = 0;
    state.inputBoxCalls.length = 0;
    state.quickPickCalls.length = 0;
    state.openDialogCalls.length = 0;
    state.commandHandlers.clear();
    state.modalAnswer = undefined;
    state.statOverride = undefined;
  },

  setWorkspaceFolder(dir: string | undefined): void {
    state.workspaceFolder = dir;
  },

  setSetting(key: string, value: unknown): void {
    state.settings.set(key, value);
  },

  /** 模拟用户保存了一个文件。 */
  async fireSave(fsPath: string): Promise<void> {
    const doc = { uri: Uri.file(fsPath), fileName: fsPath, getText: () => '' };
    for (const w of state.waiters.filter((w) => w.kind === 'save')) await w.fn(doc);
  },

  /** 模拟文件系统里新建了一个文件。 */
  async fireCreate(fsPath: string): Promise<void> {
    const uri = Uri.file(fsPath);
    for (const watcher of [...state.watchers]) {
      for (const fn of [...watcher.onDidCreate]) await fn(uri);
    }
  },

  /** 模拟文件被删除（文件已经不在了，watcher 只给旧 URI）。 */
  async fireDelete(fsPath: string): Promise<void> {
    const uri = Uri.file(fsPath);
    for (const watcher of [...state.watchers]) {
      for (const fn of [...watcher.onDidDelete]) await fn(uri);
    }
  },

  async fireRename(oldPath: string, newPath: string): Promise<void> {
    const event = { files: [{ oldUri: Uri.file(oldPath), newUri: Uri.file(newPath) }] };
    for (const w of state.waiters.filter((w) => w.kind === 'rename')) await w.fn(event);
  },

  async fireConfigChange(section = 'remoteFile'): Promise<void> {
    for (const w of state.waiters.filter((w) => w.kind === 'config')) {
      await w.fn({ affectsConfiguration: (s: string) => s.startsWith(section) });
    }
  },

  outputLines: () => state.outputLines,
  /** 「协议细节」频道的内容。 */
  traceLines: () => state.traceLines,
  errorMessages: () => state.errorMessages,
  infoMessages: () => state.infoMessages,
  warningMessages: () => state.warningMessages,
  registeredCommands: () => state.registeredCommands,
  /** 读一个 setContext 设置过的上下文键。 */
  contextKey: (key: string) => state.contextKeys.get(key),
  /** 按顺序给 showInputBox 喂答案。 */
  answerInputs: (...answers: unknown[]) => state.inputAnswers.push(...answers),
  /** 按顺序给 showQuickPick 喂答案（可以是标签字符串，也可以是下标）。 */
  answerQuickPicks: (...answers: unknown[]) => state.quickPickAnswers.push(...answers),
  /** 给 showOpenDialog 喂文件夹路径。 */
  answerOpenDialog: (...paths: unknown[]) => state.openDialogAnswers.push(...paths),
  inputBoxCalls: () => state.inputBoxCalls as { title?: string; value?: string }[],
  quickPickCalls: () => state.quickPickCalls,
};

/** 组装 activate() 需要的 ExtensionContext。 */
export function createExtensionContext(): Record<string, unknown> {
  const saved = new Map<string, unknown>();
  return {
    subscriptions: [] as { dispose: () => void }[],
    extensionPath: process.cwd(),
    extensionUri: { fsPath: process.cwd() },
    workspaceState: {
      get: (key: string) => saved.get(key),
      update: async (key: string, value: unknown) => {
        saved.set(key, value);
      },
      keys: () => [...saved.keys()],
    },
    globalState: {
      get: () => undefined,
      update: async () => undefined,
      keys: () => [],
    },
    secrets: { get: async () => undefined, store: async () => undefined, delete: async () => undefined },
  };
}
