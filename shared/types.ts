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

// ---------------------------------------------------------------------------
// AI recommendation types
// ---------------------------------------------------------------------------

export interface AISettings {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface ApkMetadata {
  path: string;
  name: string;
  size: number;
  fileCount: number;
  /** 前 50 个文件路径，供 AI 分析结构相似度 */
  samplePaths: string[];
  hasDex: boolean;
  hasRes: boolean;
  hasAssets: boolean;
  hasLib: boolean;
}

export interface AIRecommendation {
  approach: 'full_apktool' | 'hash_only';
  reasoning: string;
  confidence: number; // 0.0 - 1.0
}

// ---------------------------------------------------------------------------
// Hash-only diff types
// ---------------------------------------------------------------------------

export type HashFileCategory = 'dex' | 'xml' | 'image' | 'resource' | 'asset' | 'native' | 'other';

export interface HashDiffEntry {
  path: string;
  status: 'added' | 'removed' | 'modified' | 'unchanged';
  originalSize?: number;
  modifiedSize?: number;
  category: HashFileCategory;
}

export interface HashDiffReport {
  sessionId: string;
  original: { path: string; name: string; size: number };
  modified: { path: string; name: string; size: number };
  entries: HashDiffEntry[];
  summary: { added: number; removed: number; modified: number; unchanged: number };
  aiRecommendation?: AIRecommendation;
  elapsedMs: number;
}

// ---------------------------------------------------------------------------
// Hash-mode per-file content diff (on-demand, no decompilation)
// ---------------------------------------------------------------------------

export interface HashFileDiffResult {
  path: string;
  /** text-diff: unified diff available; binary: sizes/hash only; unsupported: needs full decompile; error */
  kind: 'text-diff' | 'binary' | 'unsupported' | 'error';
  status: 'added' | 'removed' | 'modified';
  /** Unified diff text (kind === 'text-diff') */
  diff?: string;
  additions?: number;
  deletions?: number;
  originalSize?: number;
  modifiedSize?: number;
  /** Human-readable explanation for binary/unsupported/error */
  note?: string;
  /** e.g. "AXML 已转换为 XML 文本后对比" */
  transformNote?: string;
}

// ---------------------------------------------------------------------------
// AI chat (conversation about the current diff)
// ---------------------------------------------------------------------------

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface AIChatResult {
  content: string;
  elapsedMs: number;
}

export interface OpenOptions {
  defaultPath?: string;
}

// ---------------------------------------------------------------------------
// IPC channels & API surface
// ---------------------------------------------------------------------------

/** 版本检测方法记录 */
export interface VersionCheckMethod {
  name: string;
  source: string;
  success: boolean;
  version: string | null;
  error?: string;
}

/** 版本检测结果 */
export interface VersionCheckResult {
  finalVersion: string;
  expectedVersion: string;
  success: boolean;
  isFallback: boolean;
  methods: VersionCheckMethod[];
  checkedAt: string;
}

export const IPC = {
  OPEN_APK: 'apk-diff:open-apk',
  START_DIFF: 'apk-diff:start-diff',
  GET_CLASS_DIFF: 'apk-diff:get-class-diff',
  GET_RESOURCE_DIFF: 'apk-diff:get-resource-diff',
  GET_APKTOOL_INFO: 'apk-diff:get-apktool-info',
  GET_APP_VERSION: 'apk-diff:get-app-version',
  GET_VERSION_CHECK: 'apk-diff:get-version-check',
  RECHECK_VERSION: 'apk-diff:recheck-version',
  ON_PROGRESS: 'apk-diff:on-progress',
  GET_DEBUG_INFO: 'apk-diff:get-debug-info',
  OPEN_LOG_DIR: 'apk-diff:open-log-dir',
  EXPORT_LOG: 'apk-diff:export-log',
  GET_JAVA_PATH: 'apk-diff:get-java-path',
  SET_JAVA_PATH: 'apk-diff:set-java-path',
  PICK_JAVA_PATH: 'apk-diff:pick-java-path',
  // AI
  GET_AI_SETTINGS: 'apk-diff:get-ai-settings',
  SET_AI_SETTINGS: 'apk-diff:set-ai-settings',
  GET_APK_METADATA: 'apk-diff:get-apk-metadata',
  GET_AI_RECOMMENDATION: 'apk-diff:get-ai-recommendation',
  START_HASH_DIFF: 'apk-diff:start-hash-diff',
  // Hash-mode per-file content diff + AI chat
  GET_HASH_FILE_DIFF: 'apk-diff:get-hash-file-diff',
  AI_CHAT: 'apk-diff:ai-chat'
} as const;

export interface ApkDiffApi {
  openApkPicker: (options?: OpenOptions) => Promise<string | null>;
  startDiff: (original: string, modified: string) => Promise<DiffReport>;
  getClassDiff: (reportId: string, classPath: string) => Promise<string>;
  getResourceDiff: (reportId: string, resourcePath: string) => Promise<string>;
  getApktoolInfo: () => Promise<{ version: string | null; installed: boolean; javaVersion: string | null }>;
  getAppVersion: () => Promise<string>;
  getVersionCheck: () => Promise<VersionCheckResult>;
  recheckVersion: () => Promise<VersionCheckResult>;
  onProgress: (callback: (p: DecompProgress) => void) => () => void;
  getDebugInfo: () => Promise<Record<string, unknown>>;
  openLogDir: () => Promise<void>;
  exportLog: () => Promise<string | null>;
  getJavaPath: () => Promise<string | null>;
  setJavaPath: (path: string | null) => Promise<void>;
  pickJavaPath: () => Promise<string | null>;
  // AI
  getAISettings: () => Promise<AISettings>;
  setAISettings: (s: AISettings) => Promise<void>;
  getApkMetadata: (apkPath: string) => Promise<ApkMetadata>;
  getAIRecommendation: (originalMeta: ApkMetadata, modifiedMeta: ApkMetadata) => Promise<AIRecommendation>;
  startHashDiff: (original: string, modified: string, recommendation?: AIRecommendation) => Promise<HashDiffReport>;
  getHashFileDiff: (sessionId: string, filePath: string) => Promise<HashFileDiffResult>;
  sendAIChat: (messages: ChatMessage[], context: string) => Promise<AIChatResult>;
}
