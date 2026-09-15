import { contextBridge, ipcRenderer } from 'electron';
import type { ApkDiffApi, DecompProgress } from '../shared/types';
import { IPC } from '../shared/types';

/**
 * Whitelist only the RPCs the renderer should be able to call.
 * Anything not exported here is invisible to the page.
 */
const api: ApkDiffApi = {
  openApkPicker: (options) => ipcRenderer.invoke(IPC.OPEN_APK, options),
  startDiff: (original, modified) => ipcRenderer.invoke(IPC.START_DIFF, original, modified),
  getClassDiff: (reportId, classPath) => ipcRenderer.invoke(IPC.GET_CLASS_DIFF, reportId, classPath),
  getResourceDiff: (reportId, resourcePath) => ipcRenderer.invoke(IPC.GET_RESOURCE_DIFF, reportId, resourcePath),
  getApktoolInfo: () => ipcRenderer.invoke(IPC.GET_APKTOOL_INFO),
  onProgress: (callback: (p: DecompProgress) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: DecompProgress) => callback(payload);
    ipcRenderer.on(IPC.ON_PROGRESS, listener);
    return () => ipcRenderer.removeListener(IPC.ON_PROGRESS, listener);
  }
};

contextBridge.exposeInMainWorld('apkDiff', api);

// 菜单快捷键触发的文件选择事件（由 main.ts 发送）转发为 DOM 事件，
// 让渲染层的 UploadPanel 能订阅到"原版/修改版"路径。
type FilePickPayload = { kind: 'original' | 'modified'; path: string };
ipcRenderer.on('apk-diff:file-selected-original', (_e, p: string) => {
  window.dispatchEvent(new CustomEvent('apk-diff-file-selected', { detail: { kind: 'original' as const, path: p } satisfies FilePickPayload }));
});
ipcRenderer.on('apk-diff:file-selected-modified', (_e, p: string) => {
  window.dispatchEvent(new CustomEvent('apk-diff-file-selected', { detail: { kind: 'modified' as const, path: p } satisfies FilePickPayload }));
});
