/**
 * diff-worker.ts — worker_threads 入口：在独立线程执行 buildDiffReport
 *
 * 根因背景：buildDiffReport 对超大反编译树（46 dex、数十万文件）做全量对比，
 * 同步 fs 遍历会阻塞主进程事件循环数分钟以上——窗口冻结（未响应），
 * 用户/系统结束进程表现为"闪退"，且日志缓冲丢失（v1.4.1 及之前的问题）。
 * 移入 worker 后主进程保持响应，进度、心跳、日志全部正常。
 *
 * 协议：workerData.params = buildDiffReport 的参数；完成后 postMessage
 * { ok: true, report } 或 { ok: false, error }。
 */

import { parentPort, workerData } from 'worker_threads';
import { buildDiffReport } from './diff-engine';

const params = workerData && workerData.params;

if (!parentPort || !params) {
  // 直接被 node 执行而非 Worker 启动时，给出明确报错
  console.error('[diff-worker] must be started as a Worker with workerData.params');
  process.exit(1);
}

buildDiffReport(params)
  .then((report) => {
    parentPort!.postMessage({ ok: true, report });
  })
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    try {
      // 与主进程日志对齐，便于诊断（worker 内 logger 不可用时兜底输出）
      process.stderr.write(`[diff-worker] failed: ${message}\n${stack || ''}\n`);
    } catch { /* ignore */ }
    parentPort!.postMessage({ ok: false, error: message });
  });
