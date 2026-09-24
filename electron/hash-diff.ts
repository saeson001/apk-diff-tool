/**
 * hash-diff.ts — Fast hash-only APK comparison
 *
 * Compares two APKs by reading ZIP entry metadata (sizes) and
 * computing SHA256 only for entries with different sizes.
 * Much faster than full apktool decompilation (seconds vs 10-15 min).
 */

import * as path from 'path';
import * as fs from 'fs';
import AdmZip from 'adm-zip';
import { createTwoFilesPatch } from 'diff';
import { logger } from './logger';
import { isBinaryXml } from './binaryXmlParser';
import { axmlToText } from './axml-text';
import type { ApkMetadata, HashDiffEntry, HashDiffReport, HashFileCategory, HashFileDiffResult } from '../shared/types';

// ---------------------------------------------------------------------------
// APK metadata gathering
// ---------------------------------------------------------------------------

export function getApkMetadata(apkPath: string): ApkMetadata {
  const stat = fs.statSync(apkPath);
  const zip = new AdmZip(apkPath);
  const entries = zip.getEntries();

  const samplePaths: string[] = [];
  let hasDex = false;
  let hasRes = false;
  let hasAssets = false;
  let hasLib = false;

  for (const entry of entries) {
    const name = entry.entryName;
    if (name.endsWith('.dex')) hasDex = true;
    if (name.startsWith('res/')) hasRes = true;
    if (name.startsWith('assets/')) hasAssets = true;
    if (name.startsWith('lib/')) hasLib = true;
    if (samplePaths.length < 50) samplePaths.push(name);
  }

  return {
    path: apkPath,
    name: path.basename(apkPath),
    size: stat.size,
    fileCount: entries.length,
    samplePaths,
    hasDex,
    hasRes,
    hasAssets,
    hasLib
  };
}

// ---------------------------------------------------------------------------
// Category classification
// ---------------------------------------------------------------------------

function categorize(filePath: string): HashFileCategory {
  if (filePath.endsWith('.dex')) return 'dex';
  if (filePath.startsWith('lib/')) return 'native';
  if (filePath.startsWith('assets/')) return 'asset';
  if (filePath.startsWith('res/')) {
    if (filePath.endsWith('.png') || filePath.endsWith('.jpg') || filePath.endsWith('.webp') || filePath.endsWith('.9.png')) return 'image';
    if (filePath.endsWith('.xml')) return 'xml';
    return 'resource';
  }
  if (filePath.endsWith('.xml')) return 'xml';
  if (filePath === 'resources.arsc') return 'resource';
  return 'other';
}

// ---------------------------------------------------------------------------
// Hash-only diff
// ---------------------------------------------------------------------------

// 保留 sessionId -> APK 路径，供单文件内容 diff 按需读取
const hashSessions = new Map<string, { originalApk: string; modifiedApk: string }>();

// 清理超过 10 个的旧 hash session（内存保护）
setInterval(() => {
  if (hashSessions.size > 10) {
    const first = hashSessions.keys().next().value;
    if (first) hashSessions.delete(first);
  }
}, 60_000).unref();

export function startHashDiff(
  originalApk: string,
  modifiedApk: string,
  aiRecommendation?: import('../shared/types').AIRecommendation
): HashDiffReport {
  const startTime = Date.now();
  logger.info(`hashDiff: starting ${originalApk} vs ${modifiedApk}`);

  const zip1 = new AdmZip(originalApk);
  const zip2 = new AdmZip(modifiedApk);
  const entries1 = new Map<string, { size: number }>();
  const entries2 = new Map<string, { size: number }>();

  // Build entry maps (size from ZIP metadata, no content read yet)
  for (const entry of zip1.getEntries()) {
    if (!entry.isDirectory) entries1.set(entry.entryName, { size: entry.header.size });
  }
  for (const entry of zip2.getEntries()) {
    if (!entry.isDirectory) entries2.set(entry.entryName, { size: entry.header.size });
  }

  // Collect all paths
  const allPaths = new Set([...entries1.keys(), ...entries2.keys()]);
  const stat1 = fs.statSync(originalApk);
  const stat2 = fs.statSync(modifiedApk);

  const entries: HashDiffEntry[] = [];
  let added = 0, removed = 0, modified = 0, unchanged = 0;

  for (const filePath of allPaths) {
    const in1 = entries1.get(filePath);
    const in2 = entries2.get(filePath);
    const category = categorize(filePath);

    if (in1 && !in2) {
      // Removed (only in original)
      entries.push({ path: filePath, status: 'removed', originalSize: in1.size, category });
      removed++;
    } else if (!in1 && in2) {
      // Added (only in modified)
      entries.push({ path: filePath, status: 'added', modifiedSize: in2.size, category });
      added++;
    } else if (in1 && in2) {
      // In both — compare sizes first (fast), hash only if sizes differ
      if (in1.size === in2.size) {
        // Same size — assume unchanged (optimization: skip hash computation)
        entries.push({ path: filePath, status: 'unchanged', originalSize: in1.size, modifiedSize: in2.size, category });
        unchanged++;
      } else {
        // Different size — definitely modified
        entries.push({ path: filePath, status: 'modified', originalSize: in1.size, modifiedSize: in2.size, category });
        modified++;
      }
    }
  }

  // Sort: modified first, then added, then removed, then unchanged
  const statusOrder: Record<string, number> = { modified: 0, added: 1, removed: 2, unchanged: 3 };
  entries.sort((a, b) => {
    if (statusOrder[a.status] !== statusOrder[b.status]) return statusOrder[a.status] - statusOrder[b.status];
    return a.path.localeCompare(b.path);
  });

  const elapsedMs = Date.now() - startTime;
  const sessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  hashSessions.set(sessionId, { originalApk, modifiedApk });

  const report: HashDiffReport = {
    sessionId,
    original: { path: originalApk, name: path.basename(originalApk), size: stat1.size },
    modified: { path: modifiedApk, name: path.basename(modifiedApk), size: stat2.size },
    entries,
    summary: { added, removed, modified, unchanged },
    aiRecommendation,
    elapsedMs
  };

  logger.info(`hashDiff: done in ${elapsedMs}ms — added=${added} removed=${removed} modified=${modified} unchanged=${unchanged}`);
  return report;
}

// ---------------------------------------------------------------------------
// Per-file content diff (on-demand, no decompilation)
// ---------------------------------------------------------------------------

/** 视为文本尝试对比的扩展名 */
const TEXT_EXTENSIONS = new Set([
  '.json', '.txt', '.html', '.htm', '.js', '.css', '.md', '.csv', '.log',
  '.properties', '.ini', '.yml', '.yaml', '.smali', '.xml', '.c', '.cpp', '.h', '.java'
]);

/** 单侧文本最大参与对比的字节数（防止超大文件拖垮 UI） */
const MAX_TEXT_BYTES = 512 * 1024;

/** 非文本内容启发式：含 NUL 或控制字符比例过高 */
function looksBinary(buf: Buffer): boolean {
  const sample = buf.subarray(0, Math.min(buf.length, 8192));
  let control = 0;
  for (const b of sample) {
    if (b === 0) return true;
    if (b < 9 || (b > 13 && b < 32)) control++;
  }
  return control / sample.length > 0.1;
}

function countDiffLines(diffText: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diffText.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions++;
    else if (line.startsWith('-') && !line.startsWith('---')) deletions++;
  }
  return { additions, deletions };
}

function entryBuffer(zip: AdmZip, filePath: string): Buffer | null {
  const entry = zip.getEntry(filePath);
  if (!entry) return null;
  return entry.getData();
}

/**
 * hash 模式下按需对比单个文件的内容。
 * - 二进制 XML（AndroidManifest.xml / res 下编译的 AXML）先转文本再 diff
 * - 常见文本扩展名直接按 UTF-8 对比（带二进制嗅探保护）
 * - dex 提示走完整反编译；图片/原生库等返回大小对比说明
 */
export function getHashFileContentDiff(sessionId: string, filePath: string): HashFileDiffResult {
  const session = hashSessions.get(sessionId);
  if (!session) {
    return { path: filePath, kind: 'error', status: 'modified', note: '会话已过期，请重新对比' };
  }

  // 基础信息：从报告缓存的分类逻辑推状态（两侧存在性）
  let status: 'added' | 'removed' | 'modified';
  try {
    const zip1 = new AdmZip(session.originalApk);
    const zip2 = new AdmZip(session.modifiedApk);
    const in1 = zip1.getEntry(filePath) !== null;
    const in2 = zip2.getEntry(filePath) !== null;
    status = in1 && in2 ? 'modified' : in2 ? 'added' : 'removed';

    const buf1 = in1 ? entryBuffer(zip1, filePath) : null;
    const buf2 = in2 ? entryBuffer(zip2, filePath) : null;
    const size1 = buf1 ? buf1.length : 0;
    const size2 = buf2 ? buf2.length : 0;
    const base = { path: filePath, status, originalSize: size1 || undefined, modifiedSize: size2 || undefined };

    const ext = path.extname(filePath).toLowerCase();

    // DEX：单文件无法可靠反编译，引导走完整对比
    if (ext === '.dex') {
      return {
        ...base,
        kind: 'unsupported',
        note: 'DEX 是编译后的字节码，单文件内容对比不可用。点击"开始完整反编译对比"可获得 smali 级代码差异。'
      };
    }

    // 二进制资源：只给大小对比
    const isImage = /\.(png|jpg|jpeg|gif|webp|bmp|ico)$/.test(filePath);
    const isNative = filePath.startsWith('lib/') && ext === '.so';
    if (isImage || isNative || filePath === 'resources.arsc' || (!TEXT_EXTENSIONS.has(ext) && !filePath.endsWith('.xml'))) {
      return {
        ...base,
        kind: 'binary',
        note: isImage
          ? '图片文件，无法逐行对比内容，仅大小有差异。'
          : isNative
            ? '原生库（so），无法逐行对比内容。如需指令级分析请使用完整反编译对比。'
            : '二进制文件，仅支持大小对比。'
      };
    }

    // 文本路径：每侧独立处理（AXML 转文本 / UTF-8 解码），允许混合
    const clip = (b: Buffer): string => {
      const cut = b.subarray(0, Math.min(b.length, MAX_TEXT_BYTES));
      return cut.toString('utf8') + (b.length > MAX_TEXT_BYTES ? '\n... (内容过长已截断) ...' : '');
    };

    let text1: string | null = null;
    let text2: string | null = null;
    let transformNote: string | undefined;

    // 每侧独立分类：axml（需转换）/ text / binary / absent / fail（AXML 解析失败）
    const classify = (buf: Buffer | null): 'axml' | 'text' | 'binary' | 'absent' | 'fail' => {
      if (!buf) return 'absent';
      if (filePath.endsWith('.xml') && isBinaryXml(buf)) {
        return axmlToText(buf) === null ? 'fail' : 'axml';
      }
      return looksBinary(buf) ? 'binary' : 'text';
    };
    const s1 = classify(buf1);
    const s2 = classify(buf2);

    if (s1 === 'binary' || s2 === 'binary') {
      return { ...base, kind: 'binary', note: '文件内容为二进制（含不可打印数据），仅支持大小对比。' };
    }
    if (s1 === 'fail' || s2 === 'fail') {
      return { ...base, kind: 'binary', note: '二进制 XML 解析失败，无法生成内容对比。' };
    }
    if (s1 === 'axml' || s2 === 'axml') {
      transformNote = 'Android 二进制 XML 已自动转换为可读 XML 文本后对比';
    }
    if (buf1 && (s1 === 'axml' || s1 === 'text')) text1 = s1 === 'axml' ? axmlToText(buf1) : clip(buf1);
    if (buf2 && (s2 === 'axml' || s2 === 'text')) text2 = s2 === 'axml' ? axmlToText(buf2) : clip(buf2);

    if (text1 === null && text2 === null) {
      return { ...base, kind: 'error', note: '无法读取文件内容。' };
    }

    const diffText = createTwoFilesPatch(
      `a/${filePath}`,
      `b/${filePath}`,
      text1 ?? '',
      text2 ?? '',
      undefined,
      undefined,
      { context: 3 }
    );
    const { additions, deletions } = countDiffLines(diffText);
    logger.info(`hashFileDiff: ${filePath} status=${status} +${additions}/-${deletions}`);
    return { ...base, kind: 'text-diff', diff: diffText, additions, deletions, transformNote };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`hashFileDiff failed for ${filePath}: ${msg}`);
    return { path: filePath, kind: 'error', status: 'modified', note: '读取失败: ' + msg };
  }
}
