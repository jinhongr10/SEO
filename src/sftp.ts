import fs from 'node:fs';
import path from 'node:path';
import { posix as posixPath } from 'node:path';
import SftpClient from 'ssh2-sftp-client';

export interface SftpConfig {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKeyPath?: string;
  remoteWpRoot: string;
  uploadsRelative: string;
}

export class WPSftpClient {
  private client = new SftpClient();
  private connected = false;

  constructor(private readonly config: SftpConfig) {}

  async connect() {
    if (this.connected) return;
    const payload: {
      host: string;
      port: number;
      username: string;
      password?: string;
      privateKey?: Buffer;
    } = {
      host: this.config.host,
      port: this.config.port,
      username: this.config.username,
    };

    if (this.config.privateKeyPath) {
      payload.privateKey = fs.readFileSync(path.resolve(this.config.privateKeyPath));
    } else {
      payload.password = this.config.password;
    }

    await this.client.connect(payload);
    this.connected = true;
  }

  async disconnect() {
    if (!this.connected) return;
    await this.client.end();
    this.connected = false;
  }

  resolveRemotePath(relativeUploadPath: string): string {
    const cleaned = relativeUploadPath.replace(/^\/+/, '');
    const root = this.config.remoteWpRoot.replace(/\/+$/, '');
    const uploads = this.config.uploadsRelative.replace(/^\/+|\/+$/g, '');
    return posixPath.join(root, uploads, cleaned);
  }

  async downloadRemoteFile(remotePath: string, localPath: string): Promise<number> {
    const fullLocalPath = path.resolve(localPath);
    fs.mkdirSync(path.dirname(fullLocalPath), { recursive: true });
    await this.client.fastGet(remotePath, fullLocalPath);
    return fs.statSync(fullLocalPath).size;
  }

  async uploadLocalFile(localPath: string, remotePath: string): Promise<void> {
    await this.client.fastPut(path.resolve(localPath), remotePath);
  }

  async stat(remotePath: string) {
    return this.client.stat(remotePath);
  }

  async ensureReadable(remotePath: string): Promise<void> {
    const stats = await this.client.stat(remotePath);
    if (!stats || stats.isDirectory) {
      throw new Error(`Remote file is not readable: ${remotePath}`);
    }
  }
}
