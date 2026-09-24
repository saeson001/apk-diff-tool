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
import { Worker } from 'worker_threads';
import type { DecompProgress, DiffReport } from '../shared/types';
import { IPC } from '../shared/types';
import { ensureApktool, decompileApk, getAISettings } from './apk-worker';
import { getClassUnifiedDiff, getResourceUnifiedDiff } from './diff-engine';
import { getHashFileContentDiff } from './hash-diff';
import { chatWithAI } from './ai-chat';
import type { ChatMessage } from '../shared/types';

// 保留每个 sessionId 对应的产物目录，供懒加载 IPC 使用
const sessions = new Map<string, { originalDir: string; modifiedDir: string; report: DiffReport }>();

const DIFF_WORKER_TIMEOUT_MS = 30 * 60 * 1000; // 与反编译超时一致

/**
 * 在 worker_threads 中执行 buildDiffReport。
 * 根因背景：全量对比超大反编译树（数十万文件）会阻塞主进程事件循环数分钟，
 * 导致窗口"未响应"、心跳/日志停止，被结束进程后表现为闪退（v1.4.1 及之前）。
 */
function runDiffWorker(params: {
  sessionId: string;
  originalApk: string;
  modifiedApk: string;
  originalDir: string;
  modifiedDir: string;
  apktoolVersion: string | null;
  usedFallback: boolean;
  fallbackReason?: string;
}): Promise<DiffReport> {
  return new Promise<DiffReport>((resolve, reject) => {
    let settled = false;
    const worker = new Worker(path.join(__dirname, 'diff-worker.js'), { workerData: { params } });
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      fn();
    };
    const timeout = setTimeout(() => {
      if (!settled) {
        try { worker.terminate(); } catch { /* noop */ }
      }
      finish(() => reject(new Error('对比超时（>30 分钟），已终止对比线程。')));
    }, DIFF_WORKER_TIMEOUT_MS);
    worker.on('message', (m: { ok: boolean; report?: DiffReport; error?: string }) => {
      if (m && m.ok && m.report) {
        const report: DiffReport = m.report;
        finish(() => resolve(report));
      } else {
        finish(() => reject(new Error((m && m.error) || '对比线程返回未知结果')));
      }
    });
    worker.on('error', (err) => finish(() => reject(err)));
    worker.on('exit', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(new Error(`对比线程异常退出（code=${code}）`));
      }
    });
  });
}

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

    broadcastProgress(win, { phase: 'comparing', label: '正在对比反编译结果（大包可能需要数分钟，请耐心等待）…', progress: 96 });

    const usedFallback = resultOriginal.usedFallback || resultModified.usedFallback;
    const fallbackReason = resultOriginal.fallbackReason || resultModified.fallbackReason;
    // 在独立线程执行对比，主进程保持响应（窗口/日志/心跳不受影响）
    const report = await runDiffWorker({
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
