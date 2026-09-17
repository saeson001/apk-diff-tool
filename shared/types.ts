/**
 * Shared type definitions between Electron main and the renderer.
 * These live outside `electron/` and `src/` so both builds can import them.
 */

export type DiffStatus = 'added' | 'removed' | 'modified' | 'unchanged';

export interface DiffSummary {
  addedFiles: number;
  removedFiles: number;
  modifiedFiles: number;
  addedClasses: number;
  removedClasses: number;
  modifiedClasses: number;
  permissionsAdded: number;
  permissionsRemoved: number;
  permissionsModified: number;
  totalPermissions: number;
}

export interface PermissionRow {
  permission: string;
  status: 'added' | 'removed' | 'kept';
  originalMaxSdk: number | string | null;
  modifiedMaxSdk: number | string | null;
  /** 该权限在原版 AndroidManifest.xml 的行号（1-based） */
  originalLine?: number;
  /** 该权限在修改版 AndroidManifest.xml 的行号（1-based） */
  modifiedLine?: number;
}

export interface ComponentEntry {
  name: string;
  exported?: boolean;
  enabled?: boolean;
  permission?: string;
  /** 该组件在 AndroidManifest.xml 的行号（1-based） */
  line?: number;
}

export type ComponentType = 'activity' | 'service' | 'receiver' | 'provider' | 'meta-data' | 'intent-filter';

export interface ComponentDiffResult {
  type: ComponentType;
  added: ComponentEntry[];
  removed: ComponentEntry[];
  changed: Array<{ name: string; changes: Array<{ field: string; from: string; to: string }>; originalLine?: number; modifiedLine?: number }>;
  unchangedCount: number;
}

export interface ManifestElementDiff {
  field: string;
  original: string | number | null;
  modified: string | number | null;
  status: 'added' | 'removed' | 'modified' | 'unchanged';
  /** 该字段在原版 AndroidManifest.xml 的行号（1-based） */
  originalLine?: number;
  /** 该字段在修改版 AndroidManifest.xml 的行号（1-based） */
  modifiedLine?: number;
}

export interface ManifestDiffResult {
  meta: ManifestElementDiff[];
  components: ComponentDiffResult[];
}

export interface ClassDiffEntry {
  /** Class file path relative to the smali root, e.g. `smali/com/acme/Foo.smali` */
  path: string;
  /** FQN of the class */
  className: string;
  status: 'added' | 'removed' | 'modified' | 'unchanged';
  /** Line-level diff payload, present only for modified/added/removed */
  diff?: string;
  /** Diff stats for quick preview */
  additions?: number;
  deletions?: number;
}

export interface ResourceFileDiff {
  /** Relative path inside the decompiled dir */
  path: string;
  /** 'res/...' or 'assets/...' or 'AndroidManifest.xml' */
  kind: 'text' | 'binary' | 'text-like';
  status: 'added' | 'removed' | 'modified' | 'unchanged';
  /** For binary resources */
  originalSize?: number;
  modifiedSize?: number;
  originalHash?: string;
  modifiedHash?: string;
  /** For text resources */
  diff?: string;
  additions?: number;
  deletions?: number;
}

export interface DiffReport {
  /** Session identifier for lazy-load IPC (getClassDiff/getResourceDiff) */
  sessionId: string;
  original: {
    path: string;
    name: string;
    size: number;
  };
  modified: {
    path: string;
    name: string;
    size: number;
  };
  decompiledAt: number;
  apktoolVersion: string | null;
  usedFallbackExtractor: boolean;
  /** 降级模式下的具体原因（如 apktool 下载失败、Java 缺失等），供 UI 提示用户 */
  fallbackReason?: string;
  permissions: PermissionRow[];
  manifest: ManifestDiffResult;
  classes: ClassDiffEntry[];
  resources: ResourceFileDiff[];
  summary: DiffSummary;
}

export interface DecompProgress {
  phase: 'idle' | 'preparing' | 'extracting' | 'smali' | 'comparing' | 'done' | 'error';
  label: string;
  progress: number; // 0..100
  detail?: string;
}

export interface ApkInfo {
  path: string;
  name: string;
  size: number;
}

export interface OpenOptions {
  defaultPath?: string;
}

// ---------------------------------------------------------------------------
// IPC channels & API surface
// ---------------------------------------------------------------------------

export const IPC = {
  OPEN_APK: 'apk-diff:open-apk',
  START_DIFF: 'apk-diff:start-diff',
  GET_CLASS_DIFF: 'apk-diff:get-class-diff',
  GET_RESOURCE_DIFF: 'apk-diff:get-resource-diff',
  GET_APKTOOL_INFO: 'apk-diff:get-apktool-info',
  ON_PROGRESS: 'apk-diff:on-progress'
} as const;

export interface ApkDiffApi {
  openApkPicker: (options?: OpenOptions) => Promise<string | null>;
  startDiff: (original: string, modified: string) => Promise<DiffReport>;
  getClassDiff: (reportId: string, classPath: string) => Promise<string>;
  getResourceDiff: (reportId: string, resourcePath: string) => Promise<string>;
  getApktoolInfo: () => Promise<{ version: string | null; installed: boolean; javaVersion: string | null }>;
  onProgress: (callback: (p: DecompProgress) => void) => () => void;
}
