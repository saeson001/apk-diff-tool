/**
 * diff-engine.ts — 四路 diff 引擎
 *
 * 输入：两个 apktool 反编译后的目录（原始 / 修改）
 * 输出：DiffReport（权限 / Manifest 元信息 / Manifest 组件 / smali 类 / 资源）
 *
 * 明确排除：签名（META-INF/）不参与对比。
 */

import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { XMLDocument } from 'xmldoc';
import { diffLines } from 'diff';
import type {
  DiffReport,
  PermissionRow,
  ManifestDiffResult,
  ManifestElementDiff,
  ComponentDiffResult,
  ComponentEntry,
  ComponentType,
  ClassDiffEntry,
  ResourceFileDiff,
  DiffSummary
} from '../shared/types';

const COMPONENT_TYPES: ComponentType[] = ['activity', 'service', 'receiver', 'provider'];

// -------------------------------------------------------------------------
// Manifest 解析
// -------------------------------------------------------------------------

export function parseManifest(manifestDir: string): XMLDocument | null {
  const manifestPath = path.join(manifestDir, 'AndroidManifest.xml');
  if (!fs.existsSync(manifestPath)) return null;
  try {
    const xml = fs.readFileSync(manifestPath, 'utf8');
    return new XMLDocument(xml);
  } catch (err) {
    console.warn('[diff-engine] parse manifest failed:', err);
    return null;
  }
}

function parsePermissions(root: XMLDocument): Map<string, { maxSdk: number | string | null; line: number }> {
  const map = new Map<string, { maxSdk: number | string | null; line: number }>();
  root.querySelectorAll('uses-permission').forEach((node) => {
    const name = node.attr('android:name');
    if (!name) return;
    const maxSdk = node.attr('android:maxSdkVersion');
    // xmldoc 的节点带 line 属性（1-based）
    const line = (node as unknown as { line: number }).line || 0;
    map.set(name, { maxSdk: maxSdk || null, line });
  });
  return map;
}

function parseManifestMeta(root: XMLDocument): Record<string, { value: string | number | null; line: number }> {
  const manifest = root.querySelector('manifest');
  const app = root.querySelector('application');
  const meta: Record<string, { value: string | number | null; line: number }> = {};
  const mLine = (manifest as unknown as { line: number })?.line || 0;
  const aLine = (app as unknown as { line: number })?.line || 0;
  if (manifest) {
    meta['package'] = { value: manifest.attr('package') || null, line: mLine };
    meta['versionCode'] = { value: manifest.attr('android:versionCode') || null, line: mLine };
    meta['versionName'] = { value: manifest.attr('android:versionName') || null, line: mLine };
    meta['platformBuildVersionCode'] = { value: manifest.attr('android:platformBuildVersionCode') || null, line: mLine };
    meta['platformBuildVersionName'] = { value: manifest.attr('android:platformBuildVersionName') || null, line: mLine };
    meta['installLocation'] = { value: manifest.attr('android:installLocation') || null, line: mLine };
  }
  root.querySelectorAll('uses-sdk').forEach((node) => {
    const line = (node as unknown as { line: number }).line || 0;
    const key = `uses-sdk:${node.attr('android:name') || 'default'}`;
    meta[`${key}.minSdkVersion`] = { value: node.attr('android:minSdkVersion') || null, line };
    meta[`${key}.targetSdkVersion`] = { value: node.attr('android:targetSdkVersion') || null, line };
    meta[`${key}.maxSdkVersion`] = { value: node.attr('android:maxSdkVersion') || null, line };
  });
  if (app) {
    meta['application:label'] = { value: app.attr('android:label') || null, line: aLine };
    meta['application:icon'] = { value: app.attr('android:icon') || null, line: aLine };
    meta['application:theme'] = { value: app.attr('android:theme') || null, line: aLine };
    meta['application:allowBackup'] = { value: app.attr('android:allowBackup') || null, line: aLine };
    meta['application:allowBackupOnExternalMedia'] = { value: app.attr('android:allowBackupOnExternalMedia') || null, line: aLine };
    meta['application:usesCleartextTraffic'] = { value: app.attr('android:usesCleartextTraffic') || null, line: aLine };
    meta['application:usesEncryption'] = { value: app.attr('android:usesEncryption') || null, line: aLine };
    meta['application:networkSecurityConfig'] = { value: app.attr('android:networkSecurityConfig') || null, line: aLine };
    meta['application:requestLegacyExternalStorage'] = { value: app.attr('android:requestLegacyExternalStorage') || null, line: aLine };
    meta['application:supportsRtl'] = { value: app.attr('android:supportsRtl') || null, line: aLine };
  }
  return meta;
}

function parseComponents(root: XMLDocument, type: ComponentType): Map<string, ComponentEntry> {
  const map = new Map<string, ComponentEntry>();
  root.querySelectorAll(type).forEach((node) => {
    const name = node.attr('android:name');
    if (!name) return;
    const entry: ComponentEntry = { name };
    if (node.hasAttr('android:exported')) entry.exported = node.attr('android:exported') === 'true';
    if (node.hasAttr('android:enabled')) entry.enabled = node.attr('android:enabled') === 'true';
    if (node.hasAttr('android:permission')) entry.permission = node.attr('android:permission') || undefined;
    // 加入 intent-filter 数量作为附加指纹
    const filterCount = node.querySelectorAll('intent-filter').length;
    if (filterCount > 0) entry.permission = entry.permission || `__intent-filter:${filterCount}`;
    // 记录 XML 行号
    entry.line = (node as unknown as { line: number }).line || 0;
    map.set(name, entry);
  });
  return map;
}

// -------------------------------------------------------------------------
// 各维度 diff 生成
// -------------------------------------------------------------------------

function diffPermissions(
  original: Map<string, { maxSdk: number | string | null; line: number }>,
  modified: Map<string, { maxSdk: number | string | null; line: number }>
): PermissionRow[] {
  const rows: PermissionRow[] = [];
  const allKeys = new Set([...original.keys(), ...modified.keys()]);
  for (const key of Array.from(allKeys).sort()) {
    const o = original.get(key);
    const m = modified.get(key);
    if (!original.has(key)) {
      rows.push({ permission: key, status: 'added', originalMaxSdk: null, modifiedMaxSdk: m?.maxSdk ?? null, modifiedLine: m?.line });
    } else if (!modified.has(key)) {
      rows.push({ permission: key, status: 'removed', originalMaxSdk: o?.maxSdk ?? null, modifiedMaxSdk: null, originalLine: o?.line });
    } else {
      // 权限名两边都有，status 用 kept；maxSdk 变化通过 originalMaxSdk !== modifiedMaxSdk 判断
      rows.push({
        permission: key,
        status: 'kept',
        originalMaxSdk: o!.maxSdk,
        modifiedMaxSdk: m!.maxSdk,
        originalLine: o!.line,
        modifiedLine: m!.line
      });
    }
  }
  return rows;
}

function diffManifestMeta(
  original: Record<string, { value: string | number | null; line: number }>,
  modified: Record<string, { value: string | number | null; line: number }>
): ManifestElementDiff[] {
  const keys = Array.from(new Set([...Object.keys(original), ...Object.keys(modified)])).sort();
  return keys.map((field) => {
    const o = original[field];
    const m = modified[field];
    const same = String(o?.value ?? '') === String(m?.value ?? '');
    return {
      field,
      original: o?.value ?? null,
      modified: m?.value ?? null,
      status: same ? 'unchanged' : 'modified',
      originalLine: o?.line || undefined,
      modifiedLine: m?.line || undefined
    };
  });
}

function diffComponent(
  type: ComponentType,
  original: Map<string, ComponentEntry>,
  modified: Map<string, ComponentEntry>
): ComponentDiffResult {
  const result: ComponentDiffResult = {
    type,
    added: [],
    removed: [],
    changed: [],
    unchangedCount: 0
  };
  const compareFields = (a: ComponentEntry, b: ComponentEntry): Array<{ field: string; from: string; to: string }> => {
    const changes: Array<{ field: string; from: string; to: string }> = [];
    for (const f of ['exported', 'enabled', 'permission'] as Array<keyof ComponentEntry>) {
      const x = String(a[f] ?? '');
      const y = String(b[f] ?? '');
      if (x !== y) changes.push({ field: f, from: x, to: y });
    }
    return changes;
  };
  for (const [name, entry] of original) {
    const m = modified.get(name);
    if (!m) {
      result.removed.push(entry);
    } else {
      const changes = compareFields(entry, m);
      if (changes.length > 0) {
        result.changed.push({
          name,
          changes,
          originalLine: entry.line,
          modifiedLine: m.line
        });
      } else {
        result.unchangedCount++;
      }
    }
  }
  for (const [name, entry] of modified) {
    if (!original.has(name)) result.added.push(entry);
  }
  return result;
}

// -------------------------------------------------------------------------
// smali / res 文件对比
// -------------------------------------------------------------------------

function walkSmali(dir: string): Map<string, string> {
  // 键：相对 root 的路径（smali/... 或 smali_classes2/...），不含 basename 前缀
  const map = new Map<string, string>();
  if (!fs.existsSync(dir)) return map;
  const walk = (d: string, prefix: string) => {
    if (!fs.existsSync(d)) return;
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(abs, rel);
      else if (entry.isFile() && entry.name.endsWith('.smali')) {
        try {
          map.set(rel, fs.readFileSync(abs, 'utf8'));
        } catch {
          // 跳过读取失败
        }
      }
    }
  };
  walk(dir, '');
  return map;
}

function walkAllFiles(dir: string, extensions: Set<string>): Map<string, { abs: string; ext: string }> {
  const map = new Map<string, { abs: string; ext: string }>();
  if (!fs.existsSync(dir)) return map;
  const walk = (d: string, prefix: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(abs, rel);
      else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase() || '';
        // 空 Set 表示"不过滤"（收集所有文件）
        if (extensions.size > 0 && !extensions.has(ext)) continue;
        map.set(rel, { abs, ext });
      }
    }
  };
  walk(dir, path.basename(dir));
  return map;
}

function isProbablyBinary(abs: string): boolean {
  try {
    const buf = fs.readFileSync(abs);
    // 前 4KB 里有 null 字节视为二进制
    const slice = buf.subarray(0, 4096);
    for (const b of slice) if (b === 0) return true;
    return false;
  } catch {
    return true;
  }
}

function sha256Short(abs: string): string {
  try {
    const buf = fs.readFileSync(abs);
    return createHash('sha256').update(buf).digest('hex').slice(0, 16);
  } catch {
    return '';
  }
}

function makeUnifiedDiff(originalText: string, modifiedText: string): { patch: string; additions: number; deletions: number } {
  // diffLines 返回 Change[]。手动遍历生成标准 unified diff（带 @@ hunk 头，便于 UI 显示行号）
  const changes = diffLines(originalText, modifiedText);
  const lines: string[] = ['--- original', '+++ modified'];
  let additions = 0;
  let deletions = 0;
  let origLine = 1; // 1-based
  let modLine = 1; // 1-based
  for (const c of changes) {
    const raw = (c.value || '').split('\n');
    // 去掉末尾空行（split 会产生）
    while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
    if (raw.length === 0) continue;
    if (c.added) {
      lines.push(`@@ -${origLine},0 +${modLine},${raw.length} @@`);
      for (const line of raw) {
        lines.push('+' + line);
        modLine++;
        additions++;
      }
    } else if (c.removed) {
      lines.push(`@@ -${origLine},${raw.length} +${modLine},0 @@`);
      for (const line of raw) {
        lines.push('-' + line);
        origLine++;
        deletions++;
      }
    } else {
      for (const line of raw) {
        lines.push(' ' + line);
        origLine++;
        modLine++;
      }
    }
  }
  return { patch: lines.join('\n'), additions, deletions };
}

function diffSmaliClasses(
  original: Map<string, string>,
  modified: Map<string, string>
): ClassDiffEntry[] {
  const result: ClassDiffEntry[] = [];
  const allKeys = new Set([...original.keys(), ...modified.keys()]);
  for (const rel of Array.from(allKeys).sort()) {
    const o = original.get(rel);
    const m = modified.get(rel);
    const className = rel.replace(/\.smali$/, '').replace(/\\/g, '.').replace(/\//g, '.');
    if (!o) {
      const additions = (m || '').split('\n').length;
      result.push({ path: rel, className, status: 'added', additions, deletions: 0 });
    } else if (!m) {
      const deletions = o.split('\n').length;
      result.push({ path: rel, className, status: 'removed', additions: 0, deletions });
    } else if (o !== m) {
      const { additions, deletions } = makeUnifiedDiff(o, m);
      result.push({ path: rel, className, status: 'modified', additions, deletions });
    } else {
      result.push({ path: rel, className, status: 'unchanged', additions: 0, deletions: 0 });
    }
  }
  return result;
}

function diffResources(
  original: Map<string, { abs: string; ext: string }>,
  modified: Map<string, { abs: string; ext: string }>
): ResourceFileDiff[] {
  const result: ResourceFileDiff[] = [];
  const allKeys = new Set([...original.keys(), ...modified.keys()]);
  for (const rel of Array.from(allKeys).sort()) {
    const o = original.get(rel);
    const m = modified.get(rel);
    if (!o) {
      const abs = m!.abs;
      const binary = isProbablyBinary(abs);
      result.push({
        path: rel,
        kind: binary ? 'binary' : 'text',
        status: 'added',
        modifiedSize: fs.statSync(abs).size,
        modifiedHash: binary ? sha256Short(abs) : undefined
      });
    } else if (!m) {
      const abs = o!.abs;
      const binary = isProbablyBinary(abs);
      result.push({
        path: rel,
        kind: binary ? 'binary' : 'text',
        status: 'removed',
        originalSize: fs.statSync(abs).size,
        originalHash: binary ? sha256Short(abs) : undefined
      });
    } else {
      const oAbs = o!.abs;
      const mAbs = m!.abs;
      const oStat = fs.statSync(oAbs);
      const mStat = fs.statSync(mAbs);
      if (oStat.size === mStat.size && sha256Short(oAbs) === sha256Short(mAbs)) {
        result.push({
          path: rel,
          kind: 'text',
          status: 'unchanged',
          originalSize: oStat.size,
          modifiedSize: mStat.size
        });
        continue;
      }
      const binary = isProbablyBinary(oAbs) || isProbablyBinary(mAbs);
      if (binary) {
        result.push({
          path: rel,
          kind: 'binary',
          status: 'modified',
          originalSize: oStat.size,
          modifiedSize: mStat.size,
          originalHash: sha256Short(oAbs),
          modifiedHash: sha256Short(mAbs)
        });
      } else {
        try {
          const oText = fs.readFileSync(oAbs, 'utf8');
          const mText = fs.readFileSync(mAbs, 'utf8');
          const { additions, deletions } = makeUnifiedDiff(oText, mText);
          result.push({
            path: rel,
            kind: 'text',
            status: 'modified',
            originalSize: oStat.size,
            modifiedSize: mStat.size,
            additions,
            deletions
          });
        } catch {
          result.push({
            path: rel,
            kind: 'binary',
            status: 'modified',
            originalSize: oStat.size,
            modifiedSize: mStat.size,
            originalHash: sha256Short(oAbs),
            modifiedHash: sha256Short(mAbs)
          });
        }
      }
    }
  }
  return result;
}

// -------------------------------------------------------------------------
// 主入口
// -------------------------------------------------------------------------

const TEXT_EXTS = new Set([
  '.xml', '.txt', '.java', '.smali', '.json', '.properties',
  '.rs', '.cpp', '.c', '.h', '.js', '.ts', '.py', '.html', '.css', '.scss',
  '.ttf', '.otf' // 部分 font 也走文本对比（虽然二进制，但通常不变）
]);

export async function buildDiffReport(params: {
  sessionId: string;
  originalApk: string;
  modifiedApk: string;
  originalDir: string;
  modifiedDir: string;
  apktoolVersion: string | null;
  usedFallback: boolean;
  fallbackReason?: string;
}): Promise<DiffReport> {
  const { sessionId, originalApk, modifiedApk, originalDir, modifiedDir, apktoolVersion, usedFallback, fallbackReason } = params;

  // Manifest
  const oManifest = parseManifest(originalDir);
  const mManifest = parseManifest(modifiedDir);

  let permissions: PermissionRow[] = [];
  let manifestDiff: ManifestDiffResult = { meta: [], components: [] };
  if (oManifest && mManifest) {
    permissions = diffPermissions(parsePermissions(oManifest), parsePermissions(mManifest));
    manifestDiff.meta = diffManifestMeta(parseManifestMeta(oManifest), parseManifestMeta(mManifest));
    manifestDiff.components = COMPONENT_TYPES.map((t) =>
      diffComponent(t, parseComponents(oManifest!, t), parseComponents(mManifest!, t))
    );
  } else if (oManifest && !mManifest) {
    // 修改版 Manifest 丢失，全部标记为 removed
    manifestDiff.meta = Object.entries(parseManifestMeta(oManifest)).map(([field, v]) => ({
      field, original: v.value, modified: null, status: 'removed' as const, originalLine: v.line || undefined
    }));
    manifestDiff.components = COMPONENT_TYPES.map((t) => {
      const map = parseComponents(oManifest!, t);
      return { type: t, added: [], removed: Array.from(map.values()), changed: [], unchangedCount: 0 };
    });
  } else if (!oManifest && mManifest) {
    manifestDiff.meta = Object.entries(parseManifestMeta(mManifest)).map(([field, v]) => ({
      field, original: null, modified: v.value, status: 'added' as const, modifiedLine: v.line || undefined
    }));
    manifestDiff.components = COMPONENT_TYPES.map((t) => {
      const map = parseComponents(mManifest!, t);
      return { type: t, added: Array.from(map.values()), removed: [], changed: [], unchangedCount: 0 };
    });
  }

  // smali
  const oSmali = walkSmali(originalDir);
  const mSmali = walkSmali(modifiedDir);
  const classes = diffSmaliClasses(oSmali, mSmali);

  // 资源：res/ + assets/ + AndroidManifest.xml，全部文件（文本 + 二进制）
  const resDirs = ['res', 'assets'];
  const oFiles = new Map<string, { abs: string; ext: string }>();
  const mFiles = new Map<string, { abs: string; ext: string }>();
  for (const sub of resDirs) {
    const oMap = walkAllFiles(path.join(originalDir, sub), new Set());
    const mMap = walkAllFiles(path.join(modifiedDir, sub), new Set());
    // walkAllFiles 的 prefix = basename(sub) = 'res' / 'assets'，
    // rel 已经是 'res/xxx' / 'assets/xxx' 形式，直接用即可
    for (const [rel, info] of oMap) oFiles.set(rel, info);
    for (const [rel, info] of mMap) mFiles.set(rel, info);
  }
  // AndroidManifest.xml 也加入资源 diff
  const oManifestAbs = path.join(originalDir, 'AndroidManifest.xml');
  const mManifestAbs = path.join(modifiedDir, 'AndroidManifest.xml');
  if (fs.existsSync(oManifestAbs)) oFiles.set('AndroidManifest.xml', { abs: oManifestAbs, ext: '.xml' });
  if (fs.existsSync(mManifestAbs)) mFiles.set('AndroidManifest.xml', { abs: mManifestAbs, ext: '.xml' });

  const resources = diffResources(oFiles, mFiles);

  // 汇总
  const summary: DiffSummary = {
    addedFiles: resources.filter((r) => r.status === 'added').length,
    removedFiles: resources.filter((r) => r.status === 'removed').length,
    modifiedFiles: resources.filter((r) => r.status === 'modified').length,
    addedClasses: classes.filter((c) => c.status === 'added').length,
    removedClasses: classes.filter((c) => c.status === 'removed').length,
    modifiedClasses: classes.filter((c) => c.status === 'modified').length,
    permissionsAdded: permissions.filter((p) => p.status === 'added').length,
    permissionsRemoved: permissions.filter((p) => p.status === 'removed').length,
    permissionsModified: permissions.filter((p) => p.status === 'kept' && p.originalMaxSdk !== p.modifiedMaxSdk).length,
    totalPermissions: permissions.length
  };

  return {
    sessionId,
    original: {
      path: originalApk,
      name: path.basename(originalApk),
      size: fs.statSync(originalApk).size
    },
    modified: {
      path: modifiedApk,
      name: path.basename(modifiedApk),
      size: fs.statSync(modifiedApk).size
    },
    decompiledAt: Date.now(),
    apktoolVersion,
    usedFallbackExtractor: usedFallback,
    fallbackReason,
    permissions,
    manifest: manifestDiff,
    classes,
    resources,
    summary
  };
}

// 供懒加载 IPC 使用：给定 reportId + classPath，返回该类的 unified diff
export function getClassUnifiedDiff(reportId: string, classRel: string, originalDir: string, modifiedDir: string): string {
  void reportId;
  // classRel 已经是 "smali/com/xxx" 或 "smali_classes2/com/xxx" 形式（walkSmali 的 key）
  const oText = readMaybe(path.join(originalDir, classRel)) || '';
  const mText = readMaybe(path.join(modifiedDir, classRel)) || '';
  if (!oText && !mText) return '';
  return makeUnifiedDiff(oText, mText).patch;
}

export function getResourceUnifiedDiff(
  reportId: string,
  resourceRel: string,
  originalDir: string,
  modifiedDir: string
): string {
  void reportId;
  const oText = readMaybe(path.join(originalDir, resourceRel));
  const mText = readMaybe(path.join(modifiedDir, resourceRel));
  if (oText === null && mText === null) return '';
  return makeUnifiedDiff(oText || '', mText || '').patch;
}

function readMaybe(abs: string): string | null {
  if (!fs.existsSync(abs)) return null;
  try {
    return fs.readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}
