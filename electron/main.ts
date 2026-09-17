import { app, BrowserWindow, Menu, dialog, shell, ipcMain } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { IPC } from '../shared/types';
import { ensureApktool, getApktoolJarPath, getApktoolVersion, getDebugData } from './apk-worker';
import { registerIpcHandlers } from './ipc-handlers';
import { logger } from './logger';

/** 动态读取 package.json 的 version 字段，避免硬编码导致版本号过期 */
function getAppVersion(): string {
  try {
    const pkgPath = app.isPackaged
      ? path.join(path.dirname(app.getAppPath()), 'package.json')
      : path.join(app.getAppPath(), 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return pkg.version || 'unknown';
  } catch {
    return 'unknown';
  }
}

const isDev = !app.isPackaged || process.env.NODE_ENV === 'development';

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
            const appVersion = getAppVersion();
            dialog.showMessageBox({
              title: '关于 APK Diff Tool',
              message: 'APK Diff Tool',
              detail: `版本 ${appVersion}\napktool ${version || '未安装'}\n\n日志文件: ${logger.getLogFile()}`,
              buttons: ['确定']
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
  logger.info(`APK Diff Tool starting, version=${getAppVersion()}, packaged=${app.isPackaged}`);
  logger.info(`exePath=${app.getPath('exe')}`);
  logger.info(`userData=${app.getPath('userData')}`);

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
    setupMenu();
    registerIpcHandlers(ipcMain);

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
