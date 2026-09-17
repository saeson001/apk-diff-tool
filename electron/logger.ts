/**
 * logger.ts — 应用日志模块
 *
 * 写入 %APPDATA%/APK Diff Tool/logs/app-YYYY-MM-DD.log
 * 同时输出到 console，方便开发调试。
 * 提供 getDebugInfo() 收集路径/检测状态等诊断数据。
 */

import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';

type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

class Logger {
  private logDir: string;
  private logFile: string;
  private buffer: string[] = [];

  constructor() {
    try {
      this.logDir = path.join(app.getPath('userData'), 'logs');
      fs.mkdirSync(this.logDir, { recursive: true });
      const date = new Date().toISOString().slice(0, 10);
      this.logFile = path.join(this.logDir, `app-${date}.log`);
    } catch (err) {
      console.error('[logger] init failed:', err);
      this.logDir = '';
      this.logFile = '';
    }
  }

  write(level: LogLevel, message: string, ...args: unknown[]): void {
    const ts = new Date().toISOString();
    const extra = args.length > 0
      ? ' ' + args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ')
      : '';
    const line = `[${ts}] [${level}] ${message}${extra}`;
    // console
    if (level === 'ERROR') console.error(line);
    else if (level === 'WARN') console.warn(line);
    else console.log(line);
    // file
    if (this.logFile) {
      this.buffer.push(line);
      // flush every 20 lines or on error
      if (this.buffer.length >= 20 || level === 'ERROR') this.flush();
    }
  }

  debug(msg: string, ...args: unknown[]): void { this.write('DEBUG', msg, ...args); }
  info(msg: string, ...args: unknown[]): void { this.write('INFO', msg, ...args); }
  warn(msg: string, ...args: unknown[]): void { this.write('WARN', msg, ...args); }
  error(msg: string, ...args: unknown[]): void { this.write('ERROR', msg, ...args); }

  flush(): void {
    if (this.buffer.length === 0 || !this.logFile) return;
    try {
      fs.appendFileSync(this.logFile, this.buffer.join('\n') + '\n');
      this.buffer = [];
    } catch (err) {
      console.error('[logger] flush failed:', err);
    }
  }

  /** 返回日志文件路径（用于导出/打开） */
  getLogFile(): string {
    return this.logFile;
  }

  /** 返回日志目录 */
  getLogDir(): string {
    return this.logDir;
  }

  /** 收集诊断信息 */
  collectDebugInfo(extra?: Record<string, unknown>): Record<string, unknown> {
    const info: Record<string, unknown> = {
      appVersion: 'unknown',
      isPackaged: app.isPackaged,
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      electronVersion: process.versions.electron,
      exePath: app.getPath('exe'),
      appPath: app.getAppPath(),
      userDataPath: app.getPath('userData'),
      logFile: this.logFile,
      logDir: this.logDir,
    };
    try {
      const pkgPath = app.isPackaged
        ? path.join(path.dirname(app.getAppPath()), 'package.json')
        : path.join(app.getAppPath(), 'package.json');
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      info.appVersion = pkg.version || 'unknown';
    } catch { /* noop */ }
    if (extra) Object.assign(info, extra);
    return info;
  }
}

export const logger = new Logger();
