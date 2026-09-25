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
import { parseManifestFromDir, isBinaryXmlBuffer, parseBinaryXmlBuffer, type ParsedManifest } from './binaryXmlParser';
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

interface SmaliMeta {
  abs: string;
  /** 内容 sha256 前 16 位（不保留文件全文，防止数十万 smali 文件把内存打爆） */
  hash: string;
  size: number;
  lines: number;
}

function walkSmali(dir: string): Map<string, SmaliMeta> {
  // 键：相对 root 的路径（smali/... 或 smali_classes2/...），不含 basename 前缀
  const map = new Map<string, SmaliMeta>();
  if (!fs.existsSync(dir)) return map;
  const walk = (d: string, prefix: string) => {
    if (!fs.existsSync(d)) return;
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(abs, rel);
      else if (entry.isFile() && entry.name.endsWith('.smali')) {
        try {
          // 只保留哈希/大小/行数，绝不保留全文（v1.4.2 及之前保留全文导致大包 OOM 闪退）
          const buf = fs.readFileSync(abs);
          const hash = createHash('sha256').update(buf).digest('hex').slice(0, 16);
          let lines = 0;
          for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) lines++;
          map.set(rel, { abs, hash, size: buf.length, lines });
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
    // AndroidManifest.xml 在降级模式下是二进制 XML，但可解析为文本
    if (path.basename(abs) === 'AndroidManifest.xml') {
      if (isBinaryXmlBuffer(buf)) {
        // 是二进制 XML — 可以解析，不算"纯二进制"
        const parsed = parseBinaryXmlBuffer(buf);
        if (parsed && (parsed.package || parsed.permissions.length > 0 || parsed.versionName)) {
          return false; // 可解析，标记为文本
        }
        return true; // 二进制但解析失败
      }
    }
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
  original: Map<string, SmaliMeta>,
  modified: Map<string, SmaliMeta>
): ClassDiffEntry[] {
  const result: ClassDiffEntry[] = [];
  const allKeys = new Set([...original.keys(), ...modified.keys()]);
  for (const rel of Array.from(allKeys).sort()) {
    const o = original.get(rel);
    const m = modified.get(rel);
    const className = rel.replace(/\.smali$/, '').replace(/\\/g, '.').replace(/\//g, '.');
    if (!o) {
      result.push({ path: rel, className, status: 'added', additions: m!.lines, deletions: 0 });
    } else if (!m) {
      result.push({ path: rel, className, status: 'removed', additions: 0, deletions: o.lines });
    } else if (o.hash !== m.hash) {
      // 哈希不同即判为修改；增删行数不在列表构建时计算（大包数十万类会拖垮耗时与内存），
      // 单类完整 diff 由点击时懒加载 IPC 提供
      result.push({ path: rel, className, status: 'modified' });
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

// -------------------------------------------------------------------------
// 二进制 XML 降级 diff（apktool 不可用时）
// -------------------------------------------------------------------------

function diffBinaryPermissions(
  original: Array<{ name: string; maxSdkVersion: string | null; line: number }>,
  modified: Array<{ name: string; maxSdkVersion: string | null; line: number }>
): PermissionRow[] {
  const oMap = new Map(original.map((p) => [p.name, p]));
  const mMap = new Map(modified.map((p) => [p.name, p]));
  const allNames = new Set([...oMap.keys(), ...mMap.keys()]);
  const rows: PermissionRow[] = [];
  for (const name of Array.from(allNames).sort()) {
    const o = oMap.get(name);
    const m = mMap.get(name);
    if (!m) {
      rows.push({ permission: name, status: 'removed', originalMaxSdk: o!.maxSdkVersion, modifiedMaxSdk: null, originalLine: o!.line });
    } else if (!o) {
      rows.push({ permission: name, status: 'added', originalMaxSdk: null, modifiedMaxSdk: m!.maxSdkVersion, modifiedLine: m!.line });
    } else {
      const maxSdkChanged = o.maxSdkVersion !== m.maxSdkVersion;
      rows.push({
        permission: name,
        status: maxSdkChanged ? 'kept' : 'kept',
        originalMaxSdk: o.maxSdkVersion,
        modifiedMaxSdk: m.maxSdkVersion,
        originalLine: o.line,
        modifiedLine: m.line
      });
    }
  }
  return rows;
}

function diffBinaryManifestMeta(
  original: ParsedManifest,
  modified: ParsedManifest
): ManifestElementDiff[] {
  const fields: Array<{ key: string; o: string | null; m: string | null }> = [
    { key: 'package', o: original.package, m: modified.package },
    { key: 'versionCode', o: original.versionCode, m: modified.versionCode },
    { key: 'versionName', o: original.versionName, m: modified.versionName },
    { key: 'platformBuildVersionCode', o: original.platformBuildVersionCode, m: modified.platformBuildVersionCode },
    { key: 'platformBuildVersionName', o: original.platformBuildVersionName, m: modified.platformBuildVersionName },
    { key: 'installLocation', o: original.installLocation, m: modified.installLocation },
    { key: 'uses-sdk.minSdkVersion', o: original.minSdkVersion, m: modified.minSdkVersion },
    { key: 'uses-sdk.targetSdkVersion', o: original.targetSdkVersion, m: modified.targetSdkVersion },
    { key: 'uses-sdk.maxSdkVersion', o: original.maxSdkVersion, m: modified.maxSdkVersion },
    { key: 'application:label', o: original.applicationLabel, m: modified.applicationLabel },
    { key: 'application:icon', o: original.applicationIcon, m: modified.applicationIcon },
    { key: 'application:theme', o: original.applicationTheme, m: modified.applicationTheme },
  ];
  return fields.map((f) => {
    const same = (f.o || '') === (f.m || '');
    return {
      field: f.key,
      original: f.o,
      modified: f.m,
      status: same ? 'unchanged' as const : 'modified' as const
    };
  });
}

function diffComponentFromMaps(
  type: ComponentType,
  original: Map<string, { name: string; exported: boolean | null; enabled: boolean | null; line: number }>,
  modified: Map<string, { name: string; exported: boolean | null; enabled: boolean | null; line: number }>
): ComponentDiffResult {
  const result: ComponentDiffResult = { type, added: [], removed: [], changed: [], unchangedCount: 0 };
  const toEntry = (e: { name: string; exported: boolean | null; enabled: boolean | null; line: number }): ComponentEntry => ({
    name: e.name, exported: e.exported ?? undefined, enabled: e.enabled ?? undefined, line: e.line
  });
  for (const [name, entry] of original) {
    const m = modified.get(name);
    if (!m) {
      result.removed.push(toEntry(entry));
    } else {
      const changes: Array<{ field: string; from: string; to: string }> = [];
      for (const f of ['exported', 'enabled'] as const) {
        const x = String(entry[f] ?? '');
        const y = String(m[f] ?? '');
        if (x !== y) changes.push({ field: f, from: x, to: y });
      }
      if (changes.length > 0) {
        result.changed.push({ name, changes, originalLine: entry.line, modifiedLine: m.line });
      } else {
        result.unchangedCount++;
      }
    }
  }
  for (const [name, entry] of modified) {
    if (!original.has(name)) {
      result.added.push(toEntry(entry));
    }
  }
  return result;
}

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

  // 如果文本 XML 解析全部失败（apktool 降级模式，manifest 是二进制 XML），
  // 尝试用纯 JS 二进制 XML 解析器提取 manifest 信息
  if (!oManifest && !mManifest) {
    const oBin = parseManifestFromDir(originalDir);
    const mBin = parseManifestFromDir(modifiedDir);
    if (oBin && mBin) {
      console.log('[diff-engine] using binary XML parser for manifest diff');
      // 权限 diff
      permissions = diffBinaryPermissions(oBin.permissions, mBin.permissions);
      // 元数据 diff
      manifestDiff.meta = diffBinaryManifestMeta(oBin, mBin);
      // 组件 diff
      manifestDiff.components = COMPONENT_TYPES.map((t) => {
        const typeKey = t === 'activity' ? 'activities' : t === 'service' ? 'services' : t === 'receiver' ? 'receivers' : 'providers';
        const oList = (oBin as any)[typeKey] as Array<{ name: string; exported: boolean | null; enabled: boolean | null; line: number }>;
        const mList = (mBin as any)[typeKey] as Array<{ name: string; exported: boolean | null; enabled: boolean | null; line: number }>;
        const oMap = new Map(oList.map((c) => [c.name, c]));
        const mMap = new Map(mList.map((c) => [c.name, c]));
        return diffComponentFromMaps(t, oMap, mMap);
      });
    } else {
      console.warn('[diff-engine] binary XML parsing failed, manifest diff unavailable');
    }
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

/** 将二进制 XML manifest 转为可读文本表示，用于 diff 展示 */
function binaryManifestToText(m: ParsedManifest): string {
  const lines: string[] = [];
  lines.push(`<manifest package="${m.package || ''}"`);
  if (m.versionName) lines.push(`  android:versionName="${m.versionName}"`);
  if (m.versionCode) lines.push(`  android:versionCode="${m.versionCode}"`);
  if (m.platformBuildVersionCode) lines.push(`  android:platformBuildVersionCode="${m.platformBuildVersionCode}"`);
  if (m.platformBuildVersionName) lines.push(`  android:platformBuildVersionName="${m.platformBuildVersionName}"`);
  if (m.installLocation) lines.push(`  android:installLocation="${m.installLocation}"`);
  lines.push('>');
  if (m.minSdkVersion) lines.push(`  <uses-sdk android:minSdkVersion="${m.minSdkVersion}"`);
  if (m.targetSdkVersion) lines.push(`    android:targetSdkVersion="${m.targetSdkVersion}"`);
  if (m.maxSdkVersion) lines.push(`    android:maxSdkVersion="${m.maxSdkVersion}"/>`);
  for (const p of m.permissions) {
    if (p.maxSdkVersion) lines.push(`  <uses-permission android:name="${p.name}" android:maxSdkVersion="${p.maxSdkVersion}"/>`);
    else lines.push(`  <uses-permission android:name="${p.name}"/>`);
  }
  if (m.applicationLabel || m.applicationIcon || m.applicationTheme) {
    lines.push(`  <application`);
    if (m.applicationLabel) lines.push(`    android:label="${m.applicationLabel}"`);
    if (m.applicationIcon) lines.push(`    android:icon="${m.applicationIcon}"`);
    if (m.applicationTheme) lines.push(`    android:theme="${m.applicationTheme}"`);
    lines.push(`>`);
    for (const a of m.activities) {
      lines.push(`    <activity android:name="${a.name}"`);
      if (a.exported !== null) lines.push(`      android:exported="${a.exported}"`);
      if (a.enabled !== null) lines.push(`      android:enabled="${a.enabled}"`);
      lines.push(`    />`);
    }
    for (const s of m.services) {
      lines.push(`    <service android:name="${s.name}"`);
      if (s.exported !== null) lines.push(`      android:exported="${s.exported}"`);
      if (s.enabled !== null) lines.push(`      android:enabled="${s.enabled}"`);
      lines.push(`    />`);
    }
    for (const r of m.receivers) {
      lines.push(`    <receiver android:name="${r.name}"`);
      if (r.exported !== null) lines.push(`      android:exported="${r.exported}"`);
      if (r.enabled !== null) lines.push(`      android:enabled="${r.enabled}"`);
      lines.push(`    />`);
    }
    for (const p of m.providers) {
      lines.push(`    <provider android:name="${p.name}"`);
      if (p.exported !== null) lines.push(`      android:exported="${p.exported}"`);
      if (p.enabled !== null) lines.push(`      android:enabled="${p.enabled}"`);
      if (p.authority) lines.push(`      android:authority="${p.authority}"`);
      lines.push(`    />`);
    }
    for (const md of m.metaData) {
      lines.push(`    <meta-data android:name="${md.name}"`);
      if (md.value) lines.push(`      android:value="${md.value}"`);
      lines.push(`    />`);
    }
    lines.push(`  </application>`);
  }
  lines.push('</manifest>');
  return lines.join('\n');
}

function readMaybe(abs: string): string | null {
  if (!fs.existsSync(abs)) return null;
  try {
    const buf = fs.readFileSync(abs);
    // 检测是否为二进制 XML（AndroidManifest.xml 在降级模式下是二进制格式）
    const basename = path.basename(abs);
    if (basename === 'AndroidManifest.xml' && isBinaryXmlBuffer(buf)) {
      try {
        const parsed = parseBinaryXmlBuffer(buf);
        if (parsed) {
          return binaryManifestToText(parsed);
        }
      } catch {
        // 解析失败，回退到原始文本读取
      }
    }
    return fs.readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}
