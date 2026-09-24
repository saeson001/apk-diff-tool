/**
 * ipc-handlers.ts — IPC 通道注册
 *
 * 五个通道：
 *   apk-diff:open-apk-picker   → dialog.showOpenDialog
 *   apk-diff:start-diff        → 反编译两个 APK + buildDiffReport
 *   apk-diff:get-class-diff    → 懒加载某类 smali 的 unified diff
 *   apk-diff:get-resource-diff → 懒加载某资源文件的 unified diff
 *   apk-diff:get-apktool-info  → 返回 apktool/java 状态（main.ts 里已注册）
 *
 * 事件广播：
 *   apk-diff:on-progress       → 反编译进度实时广播到渲染层
 *   apk-diff:file-selected-*   → 由 main.ts 的菜单触发，preload 转发为 DOM 事件
 */

import * as fs from 'fs';
import * as path from 'path';
import { app, dialog, BrowserWindow } from 'electron';
import type { IpcMain } from 'electron';
import type { DecompProgress, DiffReport } from '../shared/types';
import { IPC } from '../shared/types';
import { ensureApktool, decompileApk, getAISettings } from './apk-worker';
import { buildDiffReport, getClassUnifiedDiff, getResourceUnifiedDiff } from './diff-engine';
import { getHashFileContentDiff } from './hash-diff';
import { chatWithAI } from './ai-chat';
import type { ChatMessage } from '../shared/types';

// 保留每个 sessionId 对应的产物目录，供懒加载 IPC 使用
const sessions = new Map<string, { originalDir: string; modifiedDir: string; report: DiffReport }>();

function broadcastProgress(win: BrowserWindow | null, payload: DecompProgress) {
  const target = win || BrowserWindow.getAllWindows()[0];
  target?.webContents.send(IPC.ON_PROGRESS, payload);
}

export function registerIpcHandlers(ipcMain: IpcMain): void {
  // 打开文件对话框
  ipcMain.handle(IPC.OPEN_APK, async (event, _options?: { defaultPath?: string }) => {
    const win = BrowserWindow.fromWebContents(event.sender) || undefined;
    const result = await dialog.showOpenDialog(win!, {
      properties: ['openFile'],
      filters: [{ name: 'APK files', extensions: ['apk'] }]
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  // 触发对比
  ipcMain.handle(IPC.START_DIFF, async (event, originalApk: string, modifiedApk: string) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const sessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    broadcastProgress(win, { phase: 'preparing', label: '准备环境…', progress: 5 });

    // 预热 apktool / Java
    const ready = await ensureApktool((pct) => {
      broadcastProgress(win, { phase: 'preparing', label: '准备 apktool/Java', progress: pct });
    });

    // 串行反编译（避免两个 JVM 抢内存）
    const resultOriginal = await decompileApk(originalApk, (p) => {
      broadcastProgress(win, { ...p, label: `[原版] ${p.label}` });
    });

    broadcastProgress(win, { phase: 'extracting', label: '开始反编译修改版…', progress: 50 });
    const resultModified = await decompileApk(modifiedApk, (p) => {
      // 映射到 50..100
      const scaled = Math.round(50 + p.progress * 0.5);
      broadcastProgress(win, { ...p, progress: scaled, label: `[修改版] ${p.label}` });
    });

    broadcastProgress(win, { phase: 'comparing', label: '正在对比…', progress: 96 });

    const usedFallback = resultOriginal.usedFallback || resultModified.usedFallback;
    const fallbackReason = resultOriginal.fallbackReason || resultModified.fallbackReason;
    const report = await buildDiffReport({
      sessionId,
      originalApk,
      modifiedApk,
      originalDir: resultOriginal.outDir,
      modifiedDir: resultModified.outDir,
      apktoolVersion: ready.version,
      usedFallback,
      fallbackReason
    });

    sessions.set(sessionId, {
      originalDir: resultOriginal.outDir,
      modifiedDir: resultModified.outDir,
      report
    });

    broadcastProgress(win, { phase: 'done', label: '对比完成', progress: 100 });
    return report;
  });

  // 懒加载：单类 smali diff
  ipcMain.handle(IPC.GET_CLASS_DIFF, async (_event, sessionId: string, classPath: string) => {
    const session = sessions.get(sessionId);
    if (!session) return '';
    return getClassUnifiedDiff(sessionId, classPath, session.originalDir, session.modifiedDir);
  });

  // 懒加载：单资源文件 diff
  ipcMain.handle(IPC.GET_RESOURCE_DIFF, async (_event, sessionId: string, resourcePath: string) => {
    const session = sessions.get(sessionId);
    if (!session) return '';
    return getResourceUnifiedDiff(sessionId, resourcePath, session.originalDir, session.modifiedDir);
  });

  // hash 模式：单文件内容 diff（按需、不反编译）
  ipcMain.handle(IPC.GET_HASH_FILE_DIFF, async (_event, sessionId: string, filePath: string) => {
    return getHashFileContentDiff(sessionId, filePath);
  });

  // AI 对话：消息历史 + 对比上下文由渲染层传入，系统提示词由主进程注入
  ipcMain.handle(IPC.AI_CHAT, async (_event, messages: ChatMessage[], context: string) => {
    const settings = getAISettings();
    const result = await chatWithAI(settings, messages || [], context || '');
    return result;
  });
}

// 清理超过 10 个的旧 session（内存保护）
setInterval(() => {
  if (sessions.size > 10) {
    const first = sessions.keys().next().value;
    if (first) sessions.delete(first);
  }
}, 60_000).unref();
