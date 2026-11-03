import * as vscode from 'vscode';

/**
 * 内存里最多保留多少行协议往来。超出就丢掉最旧的。
 * 400 行大约相当于 60~70 个文件的传输过程，足够看清一次失败的来龙去脉。
 */
const TRACE_BUFFER_LINES = 400;

/**
 * 输出面板里的日志，分成两个频道：
 *
 * - 「Remote File」—— 只放**结果**：传了哪些文件、成功/失败、失败原因、建立基线、连接就绪。
 * - 「Remote File - 协议细节」—— FTP/SFTP 的**命令往来**（`CWD` / `250` / `EPSV` / `STOR` / `150` / `226` …）。
 *
 * 为什么协议往来**不直接写频道**：VSCode 会把输出频道镜像到磁盘，而一次「上传整个项目」
 * 会产生上万行协议往来（每个文件约 6 行），实测单个会话就写掉 520 KB —— 平时根本不用看。
 * 所以它先待在内存的滚动缓冲里，**只在出问题时**才倒进频道；想主动看就执行「显示协议细节日志」。
 */
export class Logger {
  private readonly channel: vscode.OutputChannel;
  private readonly traceChannel: vscode.OutputChannel;
  /** 协议往来的滚动缓冲：只留最近 TRACE_BUFFER_LINES 行。 */
  private readonly traceBuffer: string[] = [];
  private traceHeaderWritten = false;

  constructor(name = 'Remote File') {
    this.channel = vscode.window.createOutputChannel(name);
    this.traceChannel = vscode.window.createOutputChannel(`${name} - 协议细节`);
  }

  /** 结果类日志：用户关心的东西。 */
  info(message: string): void {
    this.channel.appendLine(`[${timestamp()}] ${message}`);
  }

  warn(message: string): void {
    this.channel.appendLine(`[${timestamp()}] ⚠ ${message}`);
    // 告警往往就是"不对劲"的第一信号，把之前的协议往来一并留档
    this.dumpTrace(`告警：${message}`);
  }

  error(message: string, err?: unknown): void {
    this.channel.appendLine(`[${timestamp()}] ✖ ${message}`);
    if (err) {
      const text = err instanceof Error ? err.stack ?? err.message : String(err);
      this.channel.appendLine(indent(text));
    }
    this.dumpTrace(`出错：${message}`);
  }

  /**
   * 传给网络层的日志回调：协议层的每一条命令和应答。
   * **只进内存缓冲**，不写频道 —— 免得日志文件随着传输量一直变大。
   */
  readonly trace = (message: string): void => {
    this.traceBuffer.push(`[${timestamp()}]   ${message}`);
    if (this.traceBuffer.length > TRACE_BUFFER_LINES) this.traceBuffer.shift();
  };

  /** 打开结果日志。 */
  show(preserveFocus = true): void {
    this.channel.show(preserveFocus);
  }

  /**
   * 打开协议细节日志。
   * 会先把内存里攒着的协议往来倒出来 —— 所以"复现一次再点这个命令"就能看到刚才发生了什么。
   */
  showTrace(preserveFocus = true): void {
    this.dumpTrace('手动查看');
    this.traceChannel.show(preserveFocus);
  }

  /** 把内存里的协议往来写进频道（出错/告警/手动查看/关闭时调用）。 */
  private dumpTrace(reason: string): void {
    if (this.traceBuffer.length === 0) return;
    if (!this.traceHeaderWritten) {
      this.traceHeaderWritten = true;
      this.traceChannel.appendLine(
        `[${timestamp()}] 这个频道只在出问题（或你主动执行「显示协议细节日志」）时才写内容。` +
          `平时的协议往来待在内存里（最近 ${TRACE_BUFFER_LINES} 行），免得日志文件一直变大。`,
      );
    }
    this.traceChannel.appendLine(
      `[${timestamp()}] ── ${reason}｜以下是发生之前的 ${this.traceBuffer.length} 行协议往来 ──`,
    );
    for (const line of this.traceBuffer) this.traceChannel.appendLine(line);
    this.traceBuffer.length = 0;
  }

  dispose(): void {
    // 关窗口时把还没倒出来的协议往来落一次盘：最多 400 行（约 20 KB）。
    // 万一是"卡住但没报错"这种最难查的情况，这可能是唯一的线索。
    this.dumpTrace('扩展关闭');
    this.channel.dispose();
    this.traceChannel.dispose();
  }
}

function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((l) => '    ' + l)
    .join('\n');
}
