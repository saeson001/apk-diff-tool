import { app, BrowserWindow, Menu, dialog, shell, ipcMain } from 'electron';
import * as path from 'path';
import { IPC } from '../shared/types';
import { ensureApktool, getApktoolJarPath, getApktoolVersion } from './apk-worker';
import { registerIpcHandlers } from './ipc-handlers';

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
      label: '关于',
      submenu: [
        {
          label: '关于 APK Diff Tool',
          click: async () => {
            const version = await getApktoolVersion().catch(() => null);
            dialog.showMessageBox({
              title: '关于 APK Diff Tool',
              message: 'APK Diff Tool',
              detail: `版本 1.0.0\napktool ${version || '未安装'}`,
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
  // Ensure single-instance: prevent a second copy from clobbering userData.
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
    ipcMain.handle(IPC.GET_APKTOOL_INFO, async () => {
      const info = await ensureApktool();
      return {
        version: info.version,
        installed: !!info.jarPath,
        javaVersion: info.javaVersion
      };
    });
    createMainWindow();
    // Warm up: pre-check Java/apktool so the first user action is snappy.
    void ensureApktool().catch((err) => {
      console.warn('[main] apktool warm-up failed:', err);
    });
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

void main();

// Re-export for tests / debugging.
export { getApktoolJarPath };
export type { BrowserWindow };
