/**
 * apk-worker.ts — 反编译入口
 *
 * 职责：
 * 1. 检测/自动下载 Java（Azul Zulu 便携版）
 * 2. 检测/自动下载 apktool.jar（固定 v2.9.3）
 * 3. 通过 child_process.spawn 调用 java -jar apktool.jar 反编译 APK
 * 4. 双路降级：Java/apktool 完全不可用时用 adm-zip 解压 zip，smali 部分标记为不可用
 * 5. 流式进度回调给 IPC 广播
 */

import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { spawn, spawnSync, execFile } from 'child_process';
import * as https from 'https';
import AdmZip from 'adm-zip';
import type { DecompProgress } from '../shared/types';
import { logger } from './logger';

const APKTOOL_VERSION = '2.9.3';
const APKTOOL_JAR_FILENAME = `apktool_${APKTOOL_VERSION}.jar`;
const APKTOOL_RELEASE_URL = `https://github.com/iBotPeaches/Apktool/releases/download/v${APKTOOL_VERSION}/${APKTOOL_JAR_FILENAME}`;
const APKTOOL_DOWNLOAD_URLS = [
  // 直连
  APKTOOL_RELEASE_URL,
  // 国内镜像源（按可用性排序）
  `https://mirror.ghproxy.com/${APKTOOL_RELEASE_URL}`,
  `https://ghproxy.com/${APKTOOL_RELEASE_URL}`,
  `https://ghproxy.net/${APKTOOL_RELEASE_URL}`,
  `https://gh.llkk.cc/${APKTOOL_RELEASE_URL}`,
  `https://ghfast.top/${APKTOOL_RELEASE_URL}`,
  `https://github.moeyy.xyz/${APKTOOL_RELEASE_URL}`,
];
// apktool.jar 正常大小约 25MB，低于此阈值视为下载不完整/损坏
const APKTOOL_MIN_SIZE = 1_000_000; // 1MB 下限

interface ApktoolState {
  jarPath: string | null;
  javaCmd: string | null;
  javaVersion: string | null;
  portableJdkDir: string | null;
  /** 诊断数据：搜索过的 jar 路径及结果 */
  jarSearchLog: Array<{ path: string; exists: boolean; size: number; valid: boolean; error?: string }>;
  /** 诊断数据：Java 检测候选 */
  javaSearchLog: Array<{ candidate: string; found: boolean; version?: string }>;
  /** 缓存：ensureApktool 成功后的结果，避免第二个 APK 重复检测导致 OOM 挂死 */
  cachedReady: { version: string | null; jarPath: string | null; javaVersion: string | null; javaCmd: string | null } | null;
}

const state: ApktoolState = {
  jarPath: null,
  javaCmd: null,
  javaVersion: null,
  portableJdkDir: null,
  jarSearchLog: [],
  javaSearchLog: [],
  cachedReady: null
};

// -------------------------------------------------------------------------
// 路径辅助
// -------------------------------------------------------------------------

function toolsDir(): string {
  const dir = path.join(app.getPath('userData'), 'tools');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 内置资源目录（electron-builder extraResources 放置位置） */
function bundledResourcesDir(): string {
  return path.join(path.dirname(app.getPath('exe')), 'resources');
}

/** 内置 Java 路径（打包时随 app 一起分发） */
function bundledJavaCmd(): string | null {
  const base = bundledResourcesDir();
  const cmd = process.platform === 'win32'
    ? path.join(base, 'jre', 'bin', 'java.exe')
    : process.platform === 'darwin'
      ? path.join(base, 'jre', 'bin', 'java')
      : path.join(base, 'jre', 'bin', 'java');
  return fs.existsSync(cmd) ? cmd : null;
}

/** 内置 apktool.jar 路径 */
function bundledJarPath(): string | null {
  const p = path.join(bundledResourcesDir(), 'tools', APKTOOL_JAR_FILENAME);
  return fs.existsSync(p) ? p : null;
}

// -------------------------------------------------------------------------
// 用户配置（手动 Java 路径等）
// -------------------------------------------------------------------------

interface UserSettings {
  javaPath?: string; // 用户手动配置的 java.exe 路径
  ai?: { baseUrl: string; apiKey: string; model: string }; // AI API 配置
}

function settingsFile(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadSettings(): UserSettings {
  try {
    if (fs.existsSync(settingsFile())) {
      return JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    }
  } catch (err) {
    logger.warn('Failed to load settings', err instanceof Error ? err.message : String(err));
  }
  return {};
}

function saveSettings(s: UserSettings): void {
  try {
    fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2));
    logger.info(`Settings saved: javaPath=${s.javaPath || '(none)'}`);
  } catch (err) {
    logger.error('Failed to save settings', err instanceof Error ? err.message : String(err));
  }
}

export function getConfiguredJavaPath(): string | null {
  return loadSettings().javaPath || null;
}

export function setConfiguredJavaPath(p: string | null): void {
  const s = loadSettings();
  if (p) s.javaPath = p;
  else delete s.javaPath;
  saveSettings(s);
}

export function getAISettings(): { baseUrl: string; apiKey: string; model: string } {
  const s = loadSettings();
  return s.ai || { baseUrl: '', apiKey: '', model: '' };
}

export function setAISettings(s: { baseUrl: string; apiKey: string; model: string }): void {
  const settings = loadSettings();
  if (s.baseUrl && s.apiKey && s.model) {
    settings.ai = s;
  } else {
    delete settings.ai;
  }
  saveSettings(settings);
  logger.info(`AI settings saved: baseUrl=${s.baseUrl || '(none)'}, model=${s.model || '(none)'}`);
}

/**
 * 验证 jar 文件是否为有效的 ZIP（apktool.jar 实际是 ZIP 格式）
 * 1) 检查 PK\x03\x04 魔数
 * 2) 尝试用 adm-zip 打开并读取条目列表（可捕获截断/损坏的 ZIP）
 */
function isValidJar(filePath: string): boolean {
  try {
    // 1) 魔数检查
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(4);
    fs.readSync(fd, buf, 0, 4, 0);
    fs.closeSync(fd);
    if (!(buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04)) {
      logger.debug(`isValidJar: magic bytes fail at ${filePath}`, buf.toString('hex'));
      return false;
    }
    // 2) 尝试实际打开 ZIP（截断/损坏会抛异常）
    const zip = new AdmZip(filePath);
    const entries = zip.getEntries();
    if (entries.length === 0) {
      logger.debug(`isValidJar: ZIP has 0 entries at ${filePath}`);
      return false;
    }
    return true;
  } catch (err) {
    logger.debug(`isValidJar: exception at ${filePath}`, err instanceof Error ? err.message : String(err));
    return false;
  }
}

/** 搜索 apktool.jar，检查多个可能位置 */
export function getApktoolJarPath(): string | null {
  const exeDir = path.dirname(app.getPath('exe'));
  // 内置 jar（extraResources，最高优先级）
  const bundled = bundledJarPath();
  if (bundled) {
    logger.info(`jar FOUND (bundled): ${bundled}`);
    return bundled;
  }
  const candidates = [
    { label: 'userData/tools', path: path.join(toolsDir(), APKTOOL_JAR_FILENAME) },
    { label: 'exeDir/tools', path: path.join(exeDir, 'tools', APKTOOL_JAR_FILENAME) },
    { label: 'exeDir', path: path.join(exeDir, APKTOOL_JAR_FILENAME) },
  ];
  state.jarSearchLog = [];

  logger.info(`getApktoolJarPath: exeDir=${exeDir}`);
  logger.info(`getApktoolJarPath: toolsDir=${toolsDir()}`);
  logger.info(`getApktoolJarPath: isPackaged=${app.isPackaged}`);

  for (const { label, path: p } of candidates) {
    const exists = fs.existsSync(p);
    let size = 0;
    let valid = false;
    let error: string | undefined;
    if (exists) {
      size = fs.statSync(p).size;
      if (size < APKTOOL_MIN_SIZE) {
        error = `size ${size} < min ${APKTOOL_MIN_SIZE}`;
      } else {
        valid = isValidJar(p);
        if (!valid) error = 'ZIP invalid';
      }
    }
    state.jarSearchLog.push({ path: p, exists, size, valid, error });
    logger.info(`jar check [${label}]: ${p} exists=${exists} size=${exists ? size : '-'} valid=${valid} error=${error || '-'}`);
    if (valid) {
      logger.info(`jar FOUND: ${p}`);
      return p;
    }
  }
  logger.warn('jar NOT found in any location');
  return null;
}

// -------------------------------------------------------------------------
// Java 检测：JAVA_HOME → PATH → 常见目录 → 便携版
// -------------------------------------------------------------------------

function findSystemJava(): { cmd: string; version: string } | null {
  const candidates: string[] = [];

  // 0) 内置 JRE（extraResources，最高优先级）
  const bundled = bundledJavaCmd();
  if (bundled) {
    candidates.push(bundled);
    logger.info(`Using bundled JRE: ${bundled}`);
  }

  // 1) 用户手动配置的路径
  const configuredPath = getConfiguredJavaPath();
  if (configuredPath) {
    candidates.push(configuredPath);
    logger.info(`Using configured Java path: ${configuredPath}`);
  }

  if (process.env.JAVA_HOME) {
    candidates.push(path.join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'));
    candidates.push(process.env.JAVA_HOME);
  }
  candidates.push('java');
  candidates.push('java.exe');
  if (process.platform === 'win32') {
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    candidates.push(path.join(programFiles, 'Eclipse Adoptium', 'jdk-17-hotspot', 'bin', 'java.exe'));
    candidates.push(path.join(programFiles, 'Zulu', 'zulu17', 'bin', 'java.exe'));
    candidates.push(path.join(programFilesX86, 'Java', 'jdk17', 'bin', 'java.exe'));
    candidates.push(path.join(programFiles, 'Java', 'jdk17', 'bin', 'java.exe'));
    candidates.push(path.join(programFiles, 'AdoptOpenJDK', 'jdk-17', 'bin', 'java.exe'));
  }

  state.javaSearchLog = [];

  for (const candidate of candidates) {
    try {
      const result = spawnSync(candidate, ['-version'], {
        timeout: 5000,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
      });
      // Java 通常把版本信息写到 stderr
      const versionLine = (result.stderr || result.stdout || '').split('\n').find((l) => l.includes('"'));
      if (versionLine) {
        const match = versionLine.match(/"([^"]+)"/);
        if (match) {
          state.javaSearchLog.push({ candidate, found: true, version: match[1] });
          logger.info(`Java found: ${candidate} version=${match[1]}`);
          return { cmd: candidate, version: match[1] };
        }
      }
      state.javaSearchLog.push({ candidate, found: false });
      logger.debug(`Java check: ${candidate} not found or no version output`);
    } catch (err) {
      state.javaSearchLog.push({ candidate, found: false });
      logger.debug(`Java check: ${candidate} error`, err instanceof Error ? err.message : String(err));
    }
  }
  logger.warn('No system Java found');
  return null;
}

function downloadFile(url: string, destPath: string, onProgress?: (pct: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    const tmpPath = destPath + '.part';
    const file = fs.createWriteStream(tmpPath);

    const reqHeaders: Record<string, string> = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': '*/*',
    };
    const request = https.get(url, { headers: reqHeaders, timeout: 30000 }, (response) => {
      const location = response.headers.location;
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && location) {
        file.end();
        file.on('close', () => {
          try { fs.unlinkSync(tmpPath); } catch { /* noop */ }
          resolve(downloadFile(location, destPath, onProgress));
        });
        return;
      }
      if (response.statusCode !== 200) {
        file.end();
        file.on('close', () => {
          try { fs.unlinkSync(tmpPath); } catch { /* noop */ }
          reject(new Error(`下载失败 HTTP ${response.statusCode}: ${url}`));
        });
        return;
      }

      const total = parseInt(response.headers['content-length'] || '0', 10);
      let received = 0;
      logger.info(`Download started: ${url} total=${total} bytes`);
      response.on('data', (chunk) => {
        received += chunk.length;
        if (total > 0 && onProgress) onProgress(Math.round((received / total) * 100));
      });
      response.pipe(file);
      file.on('finish', () => {
        file.end(() => {
          try {
            if (fs.existsSync(destPath)) {
              fs.unlinkSync(destPath);
            }
            fs.renameSync(tmpPath, destPath);
            logger.info(`Download complete: ${destPath} received=${received} bytes`);
            resolve();
          } catch (err) {
            try { fs.unlinkSync(tmpPath); } catch { /* noop */ }
            reject(err);
          }
        });
      });
      response.on('error', (err) => {
        logger.warn(`Download response error: ${url}`, err.message);
        file.end();
        file.on('close', () => {
          try { fs.unlinkSync(tmpPath); } catch { /* noop */ }
          reject(err);
        });
      });
    });
    request.on('timeout', () => {
      logger.warn(`Download timeout: ${url}`);
      request.destroy();
      file.end();
      file.on('close', () => {
        try { fs.unlinkSync(tmpPath); } catch { /* noop */ }
        reject(new Error(`下载超时: ${url}`));
      });
    });
    request.on('error', (err) => {
      logger.warn(`Download error: ${url}`, err.message);
      file.end();
      file.on('close', () => {
        try { fs.unlinkSync(tmpPath); } catch { /* noop */ }
        reject(err);
      });
    });
    file.on('error', (err) => reject(err));
  });
}

async function ensurePortableJdk(onProgress?: (pct: number) => void): Promise<{ cmd: string; version: string } | null> {
  const jdkDir = path.join(toolsDir(), 'zulu-jdk17');
  const jdkCmd =
    process.platform === 'win32'
      ? path.join(jdkDir, 'bin', 'java.exe')
      : process.platform === 'darwin'
        ? path.join(jdkDir, 'zulu-17.jdk', 'Contents', 'Home', 'bin', 'java')
        : path.join(jdkDir, 'bin', 'java');

  if (fs.existsSync(jdkCmd)) {
    try {
      const result = spawnSync(jdkCmd, ['-version'], { timeout: 5000, encoding: 'utf8' });
      const versionLine = (result.stderr || '').split('\n').find((l) => l.includes('"'));
      if (versionLine) {
        const match = versionLine.match(/"([^"]+)"/);
        if (match) {
          logger.info(`Portable JDK found: ${jdkCmd} version=${match[1]}`);
          return { cmd: jdkCmd, version: match[1] };
        }
      }
    } catch { /* fall through */ }
  }

  // Azul Zulu 便携 JRE 下载（多版本兜底，JRE 比 JDK 小很多 ~45MB）
  const urls: Array<{ url: string; ext: string }> =
    process.platform === 'win32'
      ? [
          { url: 'https://cdn.azul.com/zulu/bin/zulu17.68.203-ca-jre17.0.20.1-win_x64.zip', ext: 'zip' },
          { url: 'https://cdn.azul.com/zulu/bin/zulu17.66.19-ca-jre17.0.19-win_x64.zip', ext: 'zip' },
          { url: 'https://cdn.azul.com/zulu/bin/zulu17.64.17-ca-jre17.0.18-win_x64.zip', ext: 'zip' },
        ]
      : process.platform === 'darwin'
        ? [
            { url: 'https://cdn.azul.com/zulu/bin/zulu17.68.203-ca-jre17.0.20.1-macosx_aarch64.tar.gz', ext: 'tgz' },
            { url: 'https://cdn.azul.com/zulu/bin/zulu17.66.19-ca-jre17.0.19-macosx_aarch64.tar.gz', ext: 'tgz' },
          ]
        : [
            { url: 'https://cdn.azul.com/zulu/bin/zulu17.68.203-ca-jre17.0.20.1-linux_x64.tar.gz', ext: 'tgz' },
            { url: 'https://cdn.azul.com/zulu/bin/zulu17.66.19-ca-jre17.0.19-linux_x64.tar.gz', ext: 'tgz' },
          ];

  for (const { url, ext } of urls) {
    try {
      logger.info(`Downloading portable JDK: ${url}`);
      const archivePath = path.join(toolsDir(), `zulu-17.${ext}`);
      onProgress?.(10);
      await downloadFile(url, archivePath, (pct) => onProgress?.(10 + Math.round(pct * 0.7)));
      onProgress?.(85);

      fs.mkdirSync(jdkDir, { recursive: true });
      if (ext === 'tgz') {
        spawnSync('tar', ['-xzf', archivePath, '-C', jdkDir], { timeout: 120000 });
      } else {
        spawnSync('tar', ['-xf', archivePath, '-C', jdkDir], { timeout: 120000 });
      }
      try { fs.unlinkSync(archivePath); } catch { /* noop */ }
      onProgress?.(95);

      if (fs.existsSync(jdkCmd)) {
        const result = spawnSync(jdkCmd, ['-version'], { timeout: 5000, encoding: 'utf8' });
        const versionLine = (result.stderr || '').split('\n').find((l) => l.includes('"'));
        if (versionLine) {
          const match = versionLine.match(/"([^"]+)"/);
          if (match) {
            logger.info(`Portable JDK downloaded: ${jdkCmd} version=${match[1]}`);
            return { cmd: jdkCmd, version: match[1] };
          }
        }
      }
    } catch (err) {
      logger.warn(`Portable JDK download failed: ${url}`, err instanceof Error ? err.message : String(err));
    }
  }
  return null;
}

async function ensureJava(onProgress?: (pct: number) => void): Promise<{ cmd: string; version: string } | null> {
  logger.info('=== Java detection start ===');
  const systemJava = findSystemJava();
  if (systemJava) {
    state.javaCmd = systemJava.cmd;
    state.javaVersion = systemJava.version;
    logger.info(`Java resolved: ${systemJava.cmd} v${systemJava.version}`);
    return systemJava;
  }
  // 尝试下载便携 JDK
  logger.info('System Java not found, trying portable JDK download...');
  const portable = await ensurePortableJdk(onProgress);
  if (portable) {
    state.javaCmd = portable.cmd;
    state.javaVersion = portable.version;
    state.portableJdkDir = path.dirname(path.dirname(portable.cmd));
    logger.info(`Java resolved (portable): ${portable.cmd} v${portable.version}`);
    return portable;
  }
  logger.warn('No Java available (system + portable both failed)');
  return null;
}

// -------------------------------------------------------------------------
// apktool 检测/下载
// -------------------------------------------------------------------------

async function ensureApktoolJar(onProgress?: (pct: number) => void): Promise<string | null> {
  logger.info('=== apktool jar detection start ===');
  // 先检查多个位置是否已有有效 jar（含 ZIP 签名校验）
  const existing = getApktoolJarPath();
  if (existing) {
    state.jarPath = existing;
    logger.info(`apktool jar detected: ${existing}`);
    return existing;
  }
  // 没有有效 jar，下载到标准位置
  const jarPath = path.join(toolsDir(), APKTOOL_JAR_FILENAME);
  if (fs.existsSync(jarPath)) {
    try { fs.unlinkSync(jarPath); } catch { /* noop */ }
  }
  // 逐个源尝试下载，成功即返回；全部失败返回 null
  for (let attempt = 0; attempt < 2; attempt++) {
    for (let i = 0; i < APKTOOL_DOWNLOAD_URLS.length; i++) {
      const url = APKTOOL_DOWNLOAD_URLS[i];
      try {
        logger.info(`Downloading apktool from source ${i + 1}/${APKTOOL_DOWNLOAD_URLS.length} (attempt ${attempt + 1}): ${url}`);
        onProgress?.(5 + Math.round((i / APKTOOL_DOWNLOAD_URLS.length) * 40));
        await downloadFile(url, jarPath, onProgress);
        if (fs.existsSync(jarPath) && fs.statSync(jarPath).size >= APKTOOL_MIN_SIZE && isValidJar(jarPath)) {
          logger.info(`apktool jar downloaded OK, size=${fs.statSync(jarPath).size}`);
          state.jarPath = jarPath;
          return jarPath;
        }
        logger.warn('Downloaded file invalid, trying next source');
        try { if (fs.existsSync(jarPath)) fs.unlinkSync(jarPath); } catch { /* noop */ }
      } catch (err) {
        logger.warn(`apktool download failed from source ${i + 1}: ${url}`, err instanceof Error ? err.message : String(err));
        try { if (fs.existsSync(jarPath)) fs.unlinkSync(jarPath); } catch { /* noop */ }
      }
    }
  }
  logger.error('All apktool download sources failed');
  return null;
}

export async function getApktoolVersion(): Promise<string | null> {
  if (!state.jarPath || !state.javaCmd) return null;
  try {
    logger.info(`getApktoolVersion: running "${state.javaCmd} -Xmx256m -jar ${state.jarPath} --version"`);
    const result = spawnSync(state.javaCmd, ['-Xmx256m', '-jar', state.jarPath, '--version'], {
      timeout: 10000,
      encoding: 'utf8'
    });
    const text = (result.stdout || result.stderr || '').trim();
    logger.info(`getApktoolVersion result: ${text}`);
    return text || APKTOOL_VERSION;
  } catch (err) {
    logger.error('getApktoolVersion failed', err instanceof Error ? err.message : String(err));
    return null;
  }
}

// -------------------------------------------------------------------------
// 对外入口：确保 java + apktool 可用
// -------------------------------------------------------------------------

export async function ensureApktool(onProgress?: (pct: number) => void): Promise<{
  version: string | null;
  jarPath: string | null;
  javaVersion: string | null;
  javaCmd: string | null;
}> {
  // 缓存命中：跳过重复检测（避免第二个 APK 重新 spawnSync java 导致 OOM 挂死）
  if (state.cachedReady) {
    logger.info('=== ensureApktool cached hit, skipping re-detection ===');
    return state.cachedReady;
  }
  logger.info('=== ensureApktool start ===');
  const javaInfo = await ensureJava(onProgress);
  if (javaInfo) {
    state.javaCmd = javaInfo.cmd;
    state.javaVersion = javaInfo.version;
  }
  const jarPath = await ensureApktoolJar(onProgress);
  const version = javaInfo && jarPath ? await getApktoolVersion() : null;
  logger.info(`=== ensureApktool done: version=${version} jarPath=${jarPath} javaVersion=${state.javaVersion} ===`);
  // 缓存成功结果（version 或 jarPath 至少有一个非空）
  if (version || jarPath) {
    state.cachedReady = { version, jarPath, javaVersion: state.javaVersion, javaCmd: state.javaCmd };
  }
  return { version, jarPath, javaVersion: state.javaVersion, javaCmd: state.javaCmd };
}

/** 收集诊断信息（供 DebugPanel 使用） */
export function getDebugData(): Record<string, unknown> {
  const exeDir = path.dirname(app.getPath('exe'));
  return {
    exeDir,
    exePath: app.getPath('exe'),
    userData: app.getPath('userData'),
    toolsDir: toolsDir(),
    isPackaged: app.isPackaged,
    appPath: app.getAppPath(),
    bundledJavaCmd: bundledJavaCmd(),
    bundledJarPath: bundledJarPath(),
    jarPath: state.jarPath,
    javaCmd: state.javaCmd,
    javaVersion: state.javaVersion,
    configuredJavaPath: getConfiguredJavaPath(),
    jarSearchLog: state.jarSearchLog,
    javaSearchLog: state.javaSearchLog,
    apktoolMinSize: APKTOOL_MIN_SIZE,
    apktoolJarFilename: APKTOOL_JAR_FILENAME,
  };
}

// -------------------------------------------------------------------------
// 反编译
// -------------------------------------------------------------------------

export interface DecompileResult {
  outDir: string;
  usedFallback: boolean;
  fallbackReason?: string;
}

/** 目标盘最低剩余空间：低于此值直接拒绝反编译（估算见 preflightDiskSpace） */
const MIN_FREE_BEFORE = 1.5 * 1024 * 1024 * 1024;
/** 反编译运行中目标盘剩余空间红线：低于此值主动终止 java */
const MIN_FREE_DURING = 500 * 1024 * 1024;
/** 数据盘采用阈值：候选数据盘剩余空间需大于此值才启用 */
const DATA_DISK_MIN_FREE = 10 * 1024 * 1024 * 1024;
/** 运行时保留的会话目录数上限（每个可达数 GB，FIFO 清理） */
const MAX_SESSION_DIRS = 4;

function freeBytesOf(dir: string): number | null {
  try {
    const st = fs.statfsSync(dir);
    return st.bsize * st.bavail;
  } catch {
    return null;
  }
}

/**
 * 反编译输出根目录选择：
 * 优先数据盘 D:\testcode\apk-diff-tool\apk-out（反编译产物可达数 GB，禁止挤占系统盘），
 * D 盘不存在或剩余不足 10GB 时降级回 userData\apk-out。
 * 根因背景：v1.4.0 及之前固定写在 C 盘 userData，大 APK 完整反编译写满 C 盘导致主进程死亡（闪退）。
 */
export function getDecompileRoot(): string {  const dataRoot = 'D:\\testcode\\apk-diff-tool\\apk-out';
  const free = freeBytesOf('D:\\');
  if (free !== null && free >= DATA_DISK_MIN_FREE) {
    return dataRoot;
  }
  const fallback = path.join(app.getPath('userData'), 'apk-out');
  logger.info(`decompileApk: D 盘不可用或剩余不足（free=${free === null ? 'N/A' : Math.round(free / 1024 / 1024 / 1024) + 'GB'}），降级使用 ${fallback}`);
  return fallback;
}

/**
 * 空间预检：baksmali 输出通常为 APK 体积的 10-20 倍，取 15 倍 + 1GB 余量估算。
 * 空间不足时直接抛错（UI 会显示），绝不带着必满的磁盘开跑。
 */
export function preflightDiskSpace(apkPath: string, outDir: string): void {
  const apkSize = fs.statSync(apkPath).size;
  const required = apkSize * 15 + 1024 * 1024 * 1024;
  const drive = path.parse(outDir).root;
  const free = freeBytesOf(drive);
  if (free === null) return; // 无法探测时放行（由运行中监控兜底）
  if (free < Math.max(required, MIN_FREE_BEFORE)) {
    const msg = `磁盘空间不足：输出盘 ${drive} 仅剩 ${Math.round(free / 1024 / 1024 / 1024) * 10 / 10}GB，本次反编译预计需要约 ${Math.round(required / 1024 / 1024 / 1024) * 10 / 10}GB（APK ${Math.round(apkSize / 1024 / 1024)}MB，反编译输出通常为 APK 体积的 10-20 倍）。请清理 ${drive} 盘空间后重试。`;
    logger.error(`preflightDiskSpace FAIL: ${msg}`);
    throw new Error(msg);
  }
}

/** 启动时清理上次运行遗留的孤儿会话目录（会话映射只在内存中，重启后必然失效） */
export function purgeOrphanSessions(): void {
  try {
    const root = getDecompileRoot();
    if (!fs.existsSync(root)) return;
    for (const name of fs.readdirSync(root)) {
      const full = path.join(root, name);
      try {
        fs.rmSync(full, { recursive: true, force: true });
        logger.info(`purgeOrphanSessions: removed ${full}`);
      } catch { /* 单个目录删除失败不阻塞启动 */ }
    }
  } catch (err) {
    logger.warn(`purgeOrphanSessions failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 运行时 FIFO：会话目录超过上限时删除最旧的（防止单次运行内无限膨胀） */
function enforceSessionDirLimit(root: string, keep: number): void {
  try {
    const entries = fs.readdirSync(root)
      .map(name => {
        const full = path.join(root, name);
        return { full, mtime: fs.statSync(full).mtimeMs };
      })
      .sort((a, b) => a.mtime - b.mtime);
    while (entries.length > keep) {
      const oldest = entries.shift()!;
      try {
        fs.rmSync(oldest.full, { recursive: true, force: true });
        logger.info(`sessionDirLimit: removed oldest ${oldest.full}`);
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

export async function decompileApk(
  apkPath: string,
  onProgress: (p: DecompProgress) => void
): Promise<DecompileResult> {
  const root = getDecompileRoot();
  fs.mkdirSync(root, { recursive: true });
  const outDir = path.join(root, `${Date.now()}-${path.basename(apkPath, '.apk')}`);
  preflightDiskSpace(apkPath, outDir);
  fs.mkdirSync(outDir, { recursive: true });
  logger.info(`decompileApk: ${apkPath} -> ${outDir} (free=${(() => { const f = freeBytesOf(root); return f === null ? 'N/A' : Math.round(f / 1024 / 1024 / 1024) + 'GB'; })()})`);

  const ready = await ensureApktool((pct) => {
    onProgress({ phase: 'preparing', label: '准备 apktool/Java', progress: pct });
  });

  if (ready.jarPath && ready.javaVersion) {
    logger.info(`Using apktool: ${ready.javaCmd} -jar ${ready.jarPath}`);
    try {
      const result = await runApktool(apkPath, ready.javaCmd!, ready.jarPath, outDir, onProgress);
      enforceSessionDirLimit(root, MAX_SESSION_DIRS);
      return result;
    } catch (err) {
      // 磁盘空间类错误直接上抛：降级 zip 解压同样要写盘，只会把磁盘写得更满
      const msg = err instanceof Error ? err.message : String(err);
      if (/磁盘空间不足|ENOSPC/.test(msg)) throw err;
      logger.warn('apktool failed, falling back to zip extraction:', msg);
    }
  }

  logger.info('Using zip fallback');
  const result = runZipFallback(apkPath, outDir, onProgress, ready);
  enforceSessionDirLimit(root, MAX_SESSION_DIRS);
  return result;
}

async function runApktool(
  apkPath: string,
  javaCmd: string,
  jarPath: string,
  outDir: string,
  onProgress: (p: DecompProgress) => void
): Promise<DecompileResult> {
  const startTime = Date.now();
  const TIMEOUT_MS = 30 * 60 * 1000; // 30 分钟超时
  // JVM 内存参数：
  //   -Xmx768m                    堆内存（降为 768m 为系统留出更多余量）
  //   -XX:MaxDirectMemorySize=384m 堆外 DirectByteBuffer 硬上限（apktool 拷贝 dex 时大量分配）
  //   -XX:MaxMetaspaceSize=256m    类元数据上限
  //   -XX:+ExitOnOutOfMemoryError   JVM 自身 OOM 时干净退出，能拿到 exit code
  // 总 JVM 上限 ≈ 768+384+256+~100(overhead) ≈ 1.5GB
  const JVM_HEAP = '768m';
  const JVM_DIRECT = '384m';
  const JVM_META = '256m';
  const args = [
    `-Xmx${JVM_HEAP}`,
    `-XX:MaxDirectMemorySize=${JVM_DIRECT}`,
    `-XX:MaxMetaspaceSize=${JVM_META}`,
    '-XX:+ExitOnOutOfMemoryError',
    '-jar', jarPath, 'd', '-f', '-o', outDir, apkPath,
  ];
  logger.info(`runApktool: ${javaCmd} ${args.join(' ')}`);
  onProgress({ phase: 'extracting', label: 'apktool 反编译中…', progress: 10 });
  await new Promise<void>((resolve, reject) => {
    const child = spawn(javaCmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let progress = 10;
    let lastPhase = '启动';
    let resolved = false;
    let stderrBuf = '';
    let lastOutputAt = Date.now();

    const cleanup = () => {
      clearInterval(interval);
      clearTimeout(timeout);
      clearInterval(heartbeat);
    };

    // 每秒递增进度（上限 88，避免虚假 100%）
    const interval = setInterval(() => {
      progress = Math.min(progress + 3, 88);
      onProgress({ phase: 'extracting', label: `apktool 反编译中… (${lastPhase})`, progress });
    }, 1000);

    // 超时保护：防止 apktool 永久挂死
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        cleanup();
        try { child.kill('SIGKILL'); } catch { /* noop */ }
        const msg = `apktool 超时（>${Math.floor(TIMEOUT_MS / 1000)}s），已终止进程`;
        logger.error(msg);
        reject(new Error(msg));
      }
    }, TIMEOUT_MS);

    // 心跳日志：每 30 秒记录一次运行状态 + Java 进程内存（异步 tasklist，不阻塞事件循环）
    const heartbeat = setInterval(async () => {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      const silentFor = Math.floor((Date.now() - lastOutputAt) / 1000);
      // 磁盘监控：目标盘剩余低于红线时主动终止，防止写满系统盘导致应用死亡
      const diskFree = freeBytesOf(outDir);
      let diskInfo = '';
      if (diskFree !== null) {
        diskInfo = `, diskFree=${Math.round(diskFree / 1024 / 1024 / 1024) * 10 / 10}GB`;
        if (diskFree < MIN_FREE_DURING) {
          if (!resolved) {
            resolved = true;
            cleanup();
            try { child.kill('SIGKILL'); } catch { /* noop */ }
            const msg = `反编译已终止：输出盘 ${path.parse(outDir).root} 剩余空间仅 ${Math.round(diskFree / 1024 / 1024)}MB（红线 ${Math.round(MIN_FREE_DURING / 1024 / 1024)}MB），继续写入会导致系统与应用不稳定。请清理磁盘后重试。`;
            logger.error(`DISK GUARD: ${msg}`);
            reject(new Error(msg));
          }
          return;
        }
      }
      // 异步查询 java.exe 内存（execFile 不阻塞事件循环！v1.3.2 用 spawnSync 导致事件循环阻塞 2 分钟）
      let memInfo = '';
      if (child.pid) {
        try {
          const out = await new Promise<string>((res, rej) => {
            execFile('tasklist', ['/FI', `PID eq ${child.pid}`, '/FO', 'CSV', '/NH'],
              { windowsHide: true, timeout: 5000 }, (err, stdout) => {
                if (err) rej(err); else res(stdout);
              });
          });
          // tasklist CSV: "java.exe","PID","Console","1","1,234,567 K"
          // 最后一列是内存（单位 K），用正则匹配末尾的数字+K
          const m = out.match(/"(\d[\d,]*)\s*K"\s*$/);
          if (m) {
            const kb = parseInt(m[1].replace(/,/g, ''), 10);
            const mb = Math.round(kb / 1024);
            memInfo = `, javaMem=${mb}MB`;
            if (mb > 1800) {
              logger.error(`apktool WARN: java working set ${mb}MB 超过 1.8GB，接近 OS OOM 边缘`);
            }
          }
        } catch { /* tasklist 不可用时忽略 */ }
      }
      logger.warn(`apktool heartbeat: ${elapsed}s, phase=${lastPhase}, progress=${progress}%, silentFor=${silentFor}s${memInfo}${diskInfo}`);
      // 卡死检测：120 秒无任何 java 输出 → 强警告
      if (silentFor >= 120) {
        logger.error(`apktool STUCK: 已 ${silentFor}s 无任何输出，phase=${lastPhase}，可能已 hang 或 Java 进程异常`);
      }
    }, 30000);

    // stdout：apktool 进度信息，实时写入日志
    child.stdout.on('data', (chunk) => {
      lastOutputAt = Date.now();
      const s = chunk.toString();
      const lines = s.split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) logger.warn(`apktool out: ${trimmed.slice(0, 300)}`);
      }
      if (/Loading resource table/i.test(s)) { progress = 30; lastPhase = 'Loading resource table'; }
      else if (/Copying raw resources/i.test(s)) { progress = 50; lastPhase = 'Copying raw resources'; }
      else if (/Decoding file-resources/i.test(s)) { progress = 70; lastPhase = 'Decoding file-resources'; }
      else if (/Decoding values/i.test(s)) { progress = 80; lastPhase = 'Decoding values'; }
      else if (/Decoding AndroidManifest\.xml/i.test(s)) { progress = 85; lastPhase = 'Decoding AndroidManifest.xml'; }
      else if (/Copying assets and libs/i.test(s)) { progress = 90; lastPhase = 'Copying assets and libs'; }
      else if (/Copying original files/i.test(s)) { progress = 92; lastPhase = 'Copying original files'; }
    });

    // stderr：apktool 错误/警告信息，实时写入日志（而非仅在失败时记录）
    child.stderr.on('data', (chunk) => {
      lastOutputAt = Date.now();
      const s = chunk.toString();
      stderrBuf += s;
      // 只保留最后 4KB，防止内存膨胀
      if (stderrBuf.length > 4096) stderrBuf = stderrBuf.slice(-4096);
      const lines = s.split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) logger.warn(`apktool err: ${trimmed.slice(0, 300)}`);
      }
    });

    child.on('error', (err) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      logger.error(`apktool spawn error: ${err.message}`);
      reject(err);
    });

    child.on('close', (code) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      if (code === 0) {
        logger.info(`apktool completed successfully in ${elapsed}s`);
        resolve();
      } else {
        // 检测 JVM OOM（-XX:+ExitOnOutOfMemoryError 触发时 exit code 非 0 且 stderr 含 OutOfMemoryError）
        const isJvmOom = /OutOfMemoryError|heap space|Direct buffer memory/i.test(stderrBuf);
        const msg = isJvmOom
          ? `apktool JVM OOM after ${elapsed}s (Xmx=${JVM_HEAP}, MaxDirect=${JVM_DIRECT}): ${stderrBuf.slice(-500)}`
          : `apktool exit ${code} after ${elapsed}s: ${stderrBuf.slice(-500)}`;
        logger.error(msg);
        reject(new Error(msg));
      }
    });
  });
  onProgress({ phase: 'smali', label: 'smali 已就绪', progress: 95 });
  return { outDir, usedFallback: false };
}

function runZipFallback(
  apkPath: string,
  outDir: string,
  onProgress: (p: DecompProgress) => void,
  ready: { version: string | null; jarPath: string | null; javaVersion: string | null }
): DecompileResult {
  logger.info('runZipFallback: extracting APK as zip');
  onProgress({ phase: 'extracting', label: '降级：直接解压 APK（无 Java/apktool）', progress: 40 });
  const fallbackReason = !ready.javaVersion
    ? '系统未找到 Java 且便携 JDK 下载失败，无法反编译 smali'
    : 'apktool 反编译失败，使用 zip 解压模式';
  try {
    const zip = new AdmZip(apkPath);
    zip.extractAllTo(outDir, true);
    onProgress({ phase: 'comparing', label: 'zip 降级模式', progress: 100, detail: fallbackReason });
    logger.info('Zip fallback extraction completed');
  } catch (err) {
    logger.error('Zip fallback extraction failed', err instanceof Error ? err.message : String(err));
    onProgress({ phase: 'error', label: '解压失败', progress: 100, detail: String(err) });
  }
  return { outDir, usedFallback: true, fallbackReason };
}
