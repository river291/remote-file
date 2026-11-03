/**
 * 一个"按剧本回复"的最小 FTP 服务器，用来复现真实服务器那些不规范的时序。
 *
 * 存在的理由：用 ftp-srv 测不出"服务器发了 150 却再也不发 226"这类故障，
 * 而这正是用户实际遇到的（主动模式在 NAT 后面，数据连接连不回来）。
 *
 * 它只实现测试需要的那几条命令，其余一概交给剧本回调。
 */
import * as net from 'node:net';

export interface ScriptedFtpContext {
  /** 当前命令原文。 */
  readonly command: string;
  /** 回一行控制应答（会自动补 CRLF）。 */
  say: (line: string) => void;
  /** 数据连接是否已经由服务器回连成功。 */
  readonly dataConnected: boolean;
  /** 主动关掉数据连接，但不发结束应答（模拟"卡住"）。 */
  closeData: () => void;
  /**
   * 发 150、把文本写进数据连接、关闭它，再发结束应答。
   * 用于正常成功的 LIST/MLSD 场景。
   */
  sendData: (text: string, finalLine?: string) => Promise<void>;
  /** 只往数据连接里写内容（150/226 由剧本自己控制，用于复现乱序应答）。 */
  writeData: (text: string) => Promise<void>;
  /** 等服务器回连的数据连接建立。 */
  waitForData: () => Promise<boolean>;
}

export interface ScriptedFtpServer {
  port: number;
  /** 收到过的所有命令原文，按顺序。 */
  commands: string[];
  close: () => Promise<void>;
}

export type CommandHandler = (context: ScriptedFtpContext) => void | Promise<void>;

export interface ScriptedFtpOptions {
  /**
   * 指定 EPSV 报出去的端口且**不开监听**，用来复现"被动数据端口连不上"。
   * 不指定时服务器会真的开一个临时监听。
   */
  epsvPort?: number;
}

const FEAT_REPLY = ['211-Extensions supported:', ' MLST type*;size*;modify*;', ' MLSD', '211 End'];

export async function startScriptedFtpServer(
  onCommand: CommandHandler,
  options: ScriptedFtpOptions = {},
): Promise<ScriptedFtpServer> {
  const commands: string[] = [];
  const sockets = new Set<net.Socket>();
  const servers = new Set<net.Server>();

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding('utf8');
    socket.on('error', () => undefined);

    let buffer = '';
    let dataSocket: net.Socket | null = null;
    let dataWaiter: ((s: net.Socket | null) => void) | null = null;

    const waitForData = (timeoutMs = 1000): Promise<net.Socket | null> =>
      new Promise((resolve) => {
        if (dataSocket) return resolve(dataSocket);
        dataWaiter = resolve;
        setTimeout(() => {
          if (dataWaiter === resolve) {
            dataWaiter = null;
            resolve(null);
          }
        }, timeoutMs).unref?.();
      });

    const context: ScriptedFtpContext = {
      command: '',
      say: (line) => socket.write(line + '\r\n'),
      get dataConnected() {
        return !!dataSocket;
      },
      closeData: () => {
        dataSocket?.destroy();
        dataSocket = null;
      },
      sendData: async (text, finalLine = '226 Transfer complete') => {
        socket.write('150 Opening data connection\r\n');
        const data = await waitForData();
        if (data) {
          data.end(text);
        }
        socket.write(finalLine + '\r\n');
      },
      writeData: async (text) => {
        const data = await waitForData();
        if (data) data.end(text);
      },
      waitForData: async () => !!(await waitForData()),
    };

    const handle = async (line: string): Promise<void> => {
      const upper = line.toUpperCase();
      commands.push(line);

      if (upper.startsWith('USER')) return context.say('331 Password required');
      if (upper.startsWith('PASS')) return context.say('230 Logged in');
      if (upper.startsWith('FEAT')) {
        socket.write(FEAT_REPLY.join('\r\n') + '\r\n');
        return;
      }
      if (upper.startsWith('TYPE')) return context.say('200 Type set to I');
      // 被动模式：开一个临时监听并把端口报回去
      if (upper.startsWith('EPSV')) {
        if (options.epsvPort !== undefined) {
          context.say(`229 Entering Extended Passive Mode (|||${options.epsvPort}|)`);
          return;
        }
        const pasv = net.createServer();
        servers.add(pasv);
        pasv.once('error', () => undefined);
        await new Promise<void>((resolve) => pasv.listen(0, '127.0.0.1', () => resolve()));
        const addr = pasv.address();
        const pasvPort = typeof addr === 'object' && addr ? addr.port : 0;
        context.say(`229 Entering Extended Passive Mode (|||${pasvPort}|)`);
        pasv.once('connection', (s) => {
          sockets.add(s);
          s.on('error', () => undefined);
          dataSocket = s;
          dataWaiter?.(s);
          dataWaiter = null;
          pasv.close();
          servers.delete(pasv);
        });
        return;
      }
      if (upper.startsWith('PASV')) {
        return context.say('500 use EPSV');
      }
      // 故意不支持 EPRT，逼客户端走 PORT（和用户那台服务器一样）
      if (upper.startsWith('EPRT')) return context.say('500 EPRT not understood');
      if (upper.startsWith('PORT')) {
        const nums = (line.split(' ')[1] ?? '').split(',').map(Number);
        if (nums.length === 6 && nums.every((n) => Number.isInteger(n))) {
          const host = nums.slice(0, 4).join('.');
          const port = nums[4] * 256 + nums[5];
          context.say('200 PORT command successful');
          // 每次 PORT 都换一条新的数据连接，别让上一次的残留 socket 顶替
          dataSocket = null;
          const s = net.connect({ host, port });
          sockets.add(s);
          s.on('error', () => undefined);
          s.on('connect', () => {
            dataSocket = s;
            dataWaiter?.(s);
            dataWaiter = null;
          });
          return;
        }
        return context.say('501 Bad PORT');
      }
      if (upper.startsWith('QUIT')) {
        context.say('221 Bye');
        socket.end();
        return;
      }

      (context as { command: string }).command = line;
      await onCommand(context);
    };

    socket.write('220 scripted ftp ready\r\n');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        void handle(line);
      }
    });
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') return reject(new Error('无法获取端口'));
      resolve(addr.port);
    });
  });

  return {
    port,
    commands,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        for (const srv of servers) {
          try {
            srv.close();
          } catch {
            /* ignore */
          }
        }
        server.close(() => resolve());
      }),
  };
}
