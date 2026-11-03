/** 统一的远程客户端工厂：按协议挑实现。 */
import type { ServerConfig, RemoteClient } from '../core/types';
import { FtpClient } from './ftpClient';
import { SftpRemoteClient } from './sftpClient';

export function createRemoteClient(profile: ServerConfig, log?: (message: string) => void): RemoteClient {
  if (profile.protocol === 'sftp') {
    return new SftpRemoteClient({
      host: profile.host,
      port: profile.port,
      username: profile.username,
      password: profile.password,
      privateKeyPath: profile.privateKeyPath,
      passphrase: profile.passphrase,
      connectTimeout: profile.connectTimeout,
      log,
    });
  }

  return new FtpClient({
    host: profile.host,
    port: profile.port,
    username: profile.username,
    password: profile.password,
    secureMode: profile.secure ? profile.ftpsMode : 'none',
    allowUnauthorizedTls: profile.allowUnauthorizedTls,
    mode: profile.ftpMode,
    activeCommand: profile.ftpActiveCommand,
    connectTimeout: profile.connectTimeout,
    encoding: profile.encoding,
    log,
  });
}

export { FtpClient } from './ftpClient';
export { SftpRemoteClient } from './sftpClient';
