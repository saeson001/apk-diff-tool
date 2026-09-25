import { app, BrowserWindow, Menu, dialog, shell, ipcMain } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { IPC } from '../shared/types';
import { ensureApktool, getApktoolJarPath, getApktoolVersion, getDebugData, getConfiguredJavaPath, setConfiguredJavaPath, getAISettings, setAISettings, purgeOrphanSessions } from './apk-worker';
import { getAIRecommendation } from './ai-worker';
import { getApkMetadata, startHashDiff } from './hash-diff';
import { registerIpcHandlers } from './ipc-handlers';
import { logger } from './logger';

// 启动时立即检查 Electron 环境
if (typeof app === 'undefined' || app === null) {
  try {
    process.stderr.write('[FATAL] Electron app module not available.\n');
    process.stderr.write('[FATAL] Electron version: ' + (process.versions.electron || 'not detected') + '\n');
  } catch { /* ignore */ }
  process.exit(1);
}

/** 硬编码兜底版本号——当所有动态检测手段都失败时使用 */
const FALLBACK_VERSION = '1.4.3';

/** 版本检测方法记录，用于诊断"为什么版本号显示 unknown" */
export interface VersionCheckMethod {
  name: string;
  source: string;
  success: boolean;
  version: string | null;
  error?: string;
}

interface VersionCheckResult {
  finalVersion: string;
  expectedVersion: string;
  success: boolean;
  isFallback: boolean;
  methods: VersionCheckMethod[];
  checkedAt: string;
}

let _cachedVersionCheck: VersionCheckResult | null = null;

/**
 * 深度版本检测：依次尝试 5 种方法，记录每种方法的结果。
 * 任一方法成功即返回版本号；全部失败则返回 FALLBACK_VERSION 并弹窗告警。
 * 检测结果缓存在 %APPDATA%/APK Diff Tool/app-version.json，下次启动优先读缓存。
 */
function getAppVersionDetailed(): VersionCheckResult {
  const methods: VersionCheckMethod[] = [];
  const checkedAt = new Date().toISOString();

  // 方法 1: app.getVersion() — Electron 内置 API，从 app.asar 内读取 package.json
  try {
    const v = app.getVersion();
    methods.push({ name: 'app.getVersion()', source: 'Electron API', success: !!v && v !== '0.0.0' && v !== '0.0.0.0', version: v || null, error: !v || v === '0.0.0' ? 'returned 0.0.0' : undefined });
    if (v && v !== '0.0.0' && v !== '0.0.0.0') {
      const result: VersionCheckResult = { finalVersion: v, expectedVersion: FALLBACK_VERSION, success: true, isFallback: false, methods, checkedAt };
      _cachedVersionCheck = result;
      writeVersionCache(result);
      return result;
    }
  } catch (e) {
    methods.push({ name: 'app.getVersion()', source: 'Electron API', success: false, version: null, error: e instanceof Error ? e.message : String(e) });
  }

  // 方法 2: 直接读 app.asar 内的 package.json
  try {
    const asarPkgPath = path.join(app.getAppPath(), 'package.json');
    const pkg = JSON.parse(fs.readFileSync(asarPkgPath, 'utf8'));
    methods.push({ name: 'asar:package.json', source: asarPkgPath, success: !!pkg.version, version: pkg.version || null, error: !pkg.version ? 'no version field' : undefined });
    if (pkg.version) {
      const result: VersionCheckResult = { finalVersion: pkg.version, expectedVersion: FALLBACK_VERSION, success: true, isFallback: false, methods, checkedAt };
      _cachedVersionCheck = result;
      writeVersionCache(result);
      return result;
    }
  } catch (e) {
    methods.push({ name: 'asar:package.json', source: path.join(app.getAppPath(), 'package.json'), success: false, version: null, error: e instanceof Error ? e.message : String(e) });
  }

  // 方法 3: 读 exe 旁边的 package.json（开发模式或手动放置）
  try {
    const pkgPath = path.join(path.dirname(app.getPath('exe')), 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    methods.push({ name: 'exe-dir:package.json', source: pkgPath, success: !!pkg.version, version: pkg.version || null, error: !pkg.version ? 'no version field' : undefined });
    if (pkg.version) {
      const result: VersionCheckResult = { finalVersion: pkg.version, expectedVersion: FALLBACK_VERSION, success: true, isFallback: false, methods, checkedAt };
      _cachedVersionCheck = result;
      writeVersionCache(result);
      return result;
    }
  } catch (e) {
    methods.push({ name: 'exe-dir:package.json', source: path.join(path.dirname(app.getPath('exe')), 'package.json'), success: false, version: null, error: e instanceof Error ? e.message : String(e) });
  }

  // 方法 4: 读 userData 下的版本缓存（上次成功检测的结果）
  try {
    const cacheFile = path.join(app.getPath('userData'), 'app-version.json');
    const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (cache.finalVersion && cache.success) {
      methods.push({ name: 'userData:app-version.json (cache)', source: cacheFile, success: true, version: cache.finalVersion });
      const result: VersionCheckResult = { finalVersion: cache.finalVersion, expectedVersion: FALLBACK_VERSION, success: true, isFallback: false, methods, checkedAt };
      _cachedVersionCheck = result;
      return result;
    }
    methods.push({ name: 'userData:app-version.json (cache)', source: cacheFile, success: false, version: null, error: 'cache not valid' });
  } catch (e) {
    methods.push({ name: 'userData:app-version.json (cache)', source: path.join(app.getPath('userData'), 'app-version.json'), success: false, version: null, error: e instanceof Error ? e.message : String(e) });
  }

  // 方法 5: 硬编码兜底
  methods.push({ name: 'FALLBACK_VERSION (hardcoded)', source: 'main.ts', success: true, version: FALLBACK_VERSION });
  const result: VersionCheckResult = { finalVersion: FALLBACK_VERSION, expectedVersion: FALLBACK_VERSION, success: true, isFallback: true, methods, checkedAt };
  _cachedVersionCheck = result;
  writeVersionCache(result);
  return result;
}

/** 写入版本缓存文件，下次启动优先读 */
function writeVersionCache(result: VersionCheckResult): void {
  try {
    const cacheFile = path.join(app.getPath('userData'), 'app-version.json');
    fs.writeFileSync(cacheFile, JSON.stringify(result, null, 2), 'utf8');
  } catch { /* ignore */ }
}

/** 简单的 getAppVersion() 包装，保持向后兼容 */
function getAppVersion(): string {
  if (!_cachedVersionCheck) _cachedVersionCheck = getAppVersionDetailed();
  return _cachedVersionCheck.finalVersion;
}

/** 获取版本检测详情，供 About 对话框和诊断面板使用 */
function getVersionCheckDetail(): VersionCheckResult {
  if (!_cachedVersionCheck) _cachedVersionCheck = getAppVersionDetailed();
  return _cachedVersionCheck;
}

/** 强制重新检测版本（用于版本校验按钮） */
function recheckVersion(): VersionCheckResult {
  _cachedVersionCheck = getAppVersionDetailed();
  return _cachedVersionCheck;
}

// 安全获取 app 对象（防止模块加载时 app 未定义导致崩溃）
const safeApp = typeof app !== 'undefined' ? app : null;
const isDev = !safeApp?.isPackaged || process.env.NODE_ENV === 'development';

// 全局异常捕获：记录崩溃原因并 flush 日志缓冲，防止日志丢失
if (safeApp) {
  process.on('uncaughtException', (err) => {
    logger.error(`uncaughtException: ${err.message}`, err.stack);
    logger.flush();
    // 弹窗告知用户，杜绝"无声闪退"（磁盘满等场景下日志可能写不出来，弹窗是最后防线）
    try {
      dialog.showErrorBox('APK Diff Tool 遇到内部错误', `${err.message}\n\n详细信息已尽量写入日志（工具 > 诊断信息可打开日志目录）。`);
    } catch { /* ignore */ }
    safeApp.quit();
  });
  process.on('unhandledRejection', (reason) => {
    logger.error(`unhandledRejection: ${reason instanceof Error ? reason.message : String(reason)}`);
    logger.flush();
  });
}

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1400,
    height: 920,
    minWidth: 960,
    minHeight: 640,
    title: 'APK Diff Tool',
    backgroundColor: '#f5f7fa',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      devTools: true
    }
  });

  if (isDev && process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadFile(path.join(__dirname, '../../dist/index.html'));
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // 渲染进程加载失败诊断
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    logger.error(`Renderer did-fail-load: code=${code} desc=${desc} url=${url}`);
  });
  win.webContents.on('did-finish-load', () => {
    logger.info('Renderer did-finish-load OK');
  });
  // 渲染进程控制台日志转发到主进程日志
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    const tag = level === 3 ? 'ERROR' : level === 2 ? 'WARN' : 'LOG';
    logger.info(`[renderer ${tag}] ${message} (line ${line} of ${sourceId})`);
  });

  win.once('ready-to-show', () => win.show());
  return win;
}

function setupMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: '文件',
      submenu: [
        {
          label: '打开原版 APK…',
          accelerator: 'CmdOrCtrl+O',
          click: async (_item, win) => {
            const bw = win as unknown as BrowserWindow;
            const result = await dialog.showOpenDialog(bw, {
              properties: ['openFile'],
              filters: [{ name: 'APK files', extensions: ['apk'] }]
            });
            if (!result.canceled && result.filePaths.length > 0) {
              bw?.webContents.send('apk-diff:file-selected-original', result.filePaths[0]);
            }
          }
        },
        {
          label: '打开修改版 APK…',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: async (_item, win) => {
            const bw = win as unknown as BrowserWindow;
            const result = await dialog.showOpenDialog(bw, {
              properties: ['openFile'],
              filters: [{ name: 'APK files', extensions: ['apk'] }]
            });
            if (!result.canceled && result.filePaths.length > 0) {
              bw?.webContents.send('apk-diff:file-selected-modified', result.filePaths[0]);
            }
          }
        },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: '工具',
      submenu: [
        {
          label: '诊断信息',
          click: () => {
            const win = BrowserWindow.getAllWindows()[0];
            if (win) win.webContents.send('apk-diff:show-debug');
          }
        },
        {
          label: '打开日志目录',
          click: () => {
            shell.openPath(logger.getLogDir());
          }
        },
        {
          label: '导出日志…',
          click: async () => {
            const win = BrowserWindow.getAllWindows()[0];
            if (!win) return;
            const result = await dialog.showSaveDialog(win, {
              defaultPath: `apk-diff-tool-log-${new Date().toISOString().slice(0, 10)}.txt`,
              filters: [{ name: 'Text files', extensions: ['txt'] }]
            });
            if (!result.canceled && result.filePath) {
              try {
                logger.flush();
                const src = logger.getLogFile();
                if (fs.existsSync(src)) {
                  fs.copyFileSync(src, result.filePath);
                  logger.info(`Log exported to ${result.filePath}`);
                }
              } catch (err) {
                logger.error('Log export failed', err instanceof Error ? err.message : String(err));
              }
            }
          }
        }
      ]
    },
    {
      label: '关于',
      submenu: [
        {
          label: '关于 APK Diff Tool',
          click: async () => {
            const version = await getApktoolVersion().catch(() => null);
            const check = getVersionCheckDetail();
            const methodLines = check.methods.map(m => {
              const status = m.success ? 'OK' : 'FAIL';
              const v = m.version || '-';
              return `[${status}] ${m.name} → ${v} (${m.source})${m.error ? ` | ${m.error}` : ''}`;
            }).join('\n');
            const fallbackWarn = check.isFallback ? '\n\n⚠️ 版本检测失败，使用兜底版本！请删除目录后重新解压。' : '';
            dialog.showMessageBox({
              title: '关于 APK Diff Tool',
              message: 'APK Diff Tool',
              detail: `版本 ${check.finalVersion} (期望 ${check.expectedVersion})${fallbackWarn}\napktool ${version || '未安装'}\n\n版本检测结果:\n${methodLines}\n\n日志文件: ${logger.getLogFile()}`,
              buttons: ['确定', '重新检测'],
              defaultId: 0,
              cancelId: 0
            }).then(res => {
              if (res.response === 1) {
                // 用户点击"重新检测"
                recheckVersion();
              }
            });
          }
        }
      ]
    },
    { role: 'help', submenu: [{ role: 'toggleDevTools' }] }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function main(): Promise<void> {
  // 启动时立即做版本检测，记录所有方法的尝试结果
  const versionCheck = getAppVersionDetailed();
  logger.info(`APK Diff Tool starting, version=${versionCheck.finalVersion}, packaged=${app.isPackaged}, isFallback=${versionCheck.isFallback}`);
  logger.info(`exePath=${app.getPath('exe')}`);
  logger.info(`userData=${app.getPath('userData')}`);
  // 记录所有版本检测方法的尝试结果
  for (const m of versionCheck.methods) {
    if (m.success) {
      logger.info(`[version-check] OK: ${m.name} → ${m.version} (${m.source})`);
    } else {
      logger.warn(`[version-check] FAIL: ${m.name} (${m.source}): ${m.error}`);
    }
  }
  if (versionCheck.isFallback) {
    logger.error(`[version-check] ALL methods failed! Using FALLBACK_VERSION=${FALLBACK_VERSION}. This means package.json may not be properly packaged into app.asar.`);
  }

  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.on('second-instance', () => {
    const focused = BrowserWindow.getAllWindows()[0];
    if (focused) {
      if (focused.isMinimized()) focused.restore();
      focused.focus();
    }
  });

  app.whenReady().then(async () => {
    // 反编译产物只在内存会话中有效，启动时清理上次运行遗留的孤儿目录（每个可达数 GB）
    purgeOrphanSessions();

    setupMenu();
    registerIpcHandlers(ipcMain);

    // 应用版本号（UI 右上角显示）
    ipcMain.handle(IPC.GET_APP_VERSION, async () => getAppVersion());

    // 版本检测详情（About 对话框 / 诊断面板）
    ipcMain.handle(IPC.GET_VERSION_CHECK, async () => getVersionCheckDetail());

    // 强制重新检测版本
    ipcMain.handle(IPC.RECHECK_VERSION, async () => recheckVersion());

    // apktool 状态
    ipcMain.handle(IPC.GET_APKTOOL_INFO, async () => {
      const info = await ensureApktool();
      return {
        version: info.version,
        installed: !!info.jarPath,
        javaVersion: info.javaVersion
      };
    });

    // 诊断信息
    ipcMain.handle(IPC.GET_DEBUG_INFO, async () => {
      const data = getDebugData();
      const loggerInfo = logger.collectDebugInfo({
        jarSearchLog: data.jarSearchLog,
        javaSearchLog: data.javaSearchLog,
        jarPath: data.jarPath,
        javaCmd: data.javaCmd,
        javaVersion: data.javaVersion,
        toolsDir: data.toolsDir,
        apktoolMinSize: data.apktoolMinSize,
        apktoolJarFilename: data.apktoolJarFilename,
      });
      return loggerInfo;
    });

    // 打开日志目录
    ipcMain.handle(IPC.OPEN_LOG_DIR, async () => {
      shell.openPath(logger.getLogDir());
    });

    // 导出日志
    ipcMain.handle(IPC.EXPORT_LOG, async (event) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win) return null;
      const result = await dialog.showSaveDialog(win, {
        defaultPath: `apk-diff-tool-log-${new Date().toISOString().slice(0, 10)}.txt`,
        filters: [{ name: 'Text files', extensions: ['txt'] }]
      });
      if (result.canceled || !result.filePath) return null;
      try {
        logger.flush();
        const src = logger.getLogFile();
        if (fs.existsSync(src)) {
          fs.copyFileSync(src, result.filePath);
          logger.info(`Log exported to ${result.filePath}`);
          return result.filePath;
        }
      } catch (err) {
        logger.error('Log export failed', err instanceof Error ? err.message : String(err));
      }
      return null;
    });

    // 获取配置的 Java 路径
    ipcMain.handle(IPC.GET_JAVA_PATH, async () => {
      return getConfiguredJavaPath();
    });

    // 设置 Java 路径
    ipcMain.handle(IPC.SET_JAVA_PATH, async (_event, p: string | null) => {
      setConfiguredJavaPath(p);
      // 重新检测 Java
      await ensureApktool();
      logger.info(`Java path configured: ${p || '(cleared)'}`);
    });

    // 通过文件对话框选择 java.exe
    ipcMain.handle(IPC.PICK_JAVA_PATH, async (event) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win) return null;
      const result = await dialog.showOpenDialog(win, {
        properties: ['openFile'],
        filters: [
          { name: 'Java executable', extensions: ['exe'] },
          { name: 'All files', extensions: ['*'] }
        ]
      });
      if (!result.canceled && result.filePaths.length > 0) {
        const p = result.filePaths[0];
        setConfiguredJavaPath(p);
        await ensureApktool();
        logger.info(`Java path picked: ${p}`);
        return p;
      }
      return null;
    });

    // AI settings
    ipcMain.handle(IPC.GET_AI_SETTINGS, async () => {
      return getAISettings();
    });

    ipcMain.handle(IPC.SET_AI_SETTINGS, async (_event, s: { baseUrl: string; apiKey: string; model: string }) => {
      setAISettings(s);
    });

    // APK metadata (for AI analysis)
    ipcMain.handle(IPC.GET_APK_METADATA, async (_event, apkPath: string) => {
      return getApkMetadata(apkPath);
    });

    // AI recommendation
    ipcMain.handle(IPC.GET_AI_RECOMMENDATION, async (_event, originalMeta: unknown, modifiedMeta: unknown) => {
      const settings = getAISettings();
      return getAIRecommendation(settings, originalMeta as import('../shared/types').ApkMetadata, modifiedMeta as import('../shared/types').ApkMetadata);
    });

    // Hash-only diff
    ipcMain.handle(IPC.START_HASH_DIFF, async (_event, original: string, modified: string, recommendation?: import('../shared/types').AIRecommendation) => {
      return startHashDiff(original, modified, recommendation);
    });

    createMainWindow();
    // Warm up: pre-check Java/apktool so the first user action is snappy.
    void ensureApktool().catch((err) => {
      logger.warn('[main] apktool warm-up failed:', err instanceof Error ? err.message : String(err));
    });
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
  });

  app.on('window-all-closed', () => {
    logger.info('All windows closed, flushing log');
    logger.flush();
    if (process.platform !== 'darwin') app.quit();
  });
}

void main();

// Re-export for tests / debugging.
export { getApktoolJarPath };
export type { BrowserWindow };
