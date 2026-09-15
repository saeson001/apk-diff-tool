/**
 * 渲染层类型声明。
 * `window.apkDiff` 由 preload.ts 通过 contextBridge 注入，这里补上 TS 类型。
 */
import type { ApkDiffApi } from '../shared/types';

declare global {
  interface Window {
    apkDiff?: ApkDiffApi;
  }
}

export {};
