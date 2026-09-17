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
import { spawn, spawnSync } from 'child_process';
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
}

const state: ApktoolState = {
  jarPath: null,
  javaCmd: null,
  javaVersion: null,
  portableJdkDir: null,
  jarSearchLog: [],
  javaSearchLog: []
};

// -------------------------------------------------------------------------
// 路径辅助
// -------------------------------------------------------------------------

function toolsDir(): string {
  const dir = path.join(app.getPath('userData'), 'tools');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
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

    const request = https.get(url, (response) => {
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
            resolve();
          } catch (err) {
            try { fs.unlinkSync(tmpPath); } catch { /* noop */ }
            reject(err);
          }
        });
      });
    });
    request.on('error', (err) => {
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

  // Azul Zulu 便携包下载
  const urls: Array<{ url: string; ext: string }> =
    process.platform === 'win32'
      ? [{ url: 'https://cdn.azul.com/zulu/bin/zulu17.54.0.11-ca-jdk17.0.13-win_x64.zip', ext: 'zip' }]
      : process.platform === 'darwin'
        ? [{ url: 'https://cdn.azul.com/zulu/bin/zulu17.54.0.11-ca-jdk17.0.13-macosx_aarch64.tar.gz', ext: 'tgz' }]
        : [{ url: 'https://cdn.azul.com/zulu/bin/zulu17.54.0.11-ca-jdk17.0.13-linux_x64.tar.gz', ext: 'tgz' }];

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
    logger.info(`getApktoolVersion: running "${state.javaCmd} -jar ${state.jarPath} --version"`);
    const result = spawnSync(state.javaCmd, ['-jar', state.jarPath, '--version'], {
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
  logger.info('=== ensureApktool start ===');
  const javaInfo = await ensureJava(onProgress);
  if (javaInfo) {
    state.javaCmd = javaInfo.cmd;
    state.javaVersion = javaInfo.version;
  }
  const jarPath = await ensureApktoolJar(onProgress);
  const version = javaInfo && jarPath ? await getApktoolVersion() : null;
  logger.info(`=== ensureApktool done: version=${version} jarPath=${jarPath} javaVersion=${state.javaVersion} ===`);
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
    jarPath: state.jarPath,
    javaCmd: state.javaCmd,
    javaVersion: state.javaVersion,
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

export async function decompileApk(
  apkPath: string,
  onProgress: (p: DecompProgress) => void
): Promise<DecompileResult> {
  const outDir = path.join(
    app.getPath('userData'),
    'apk-out',
    `${Date.now()}-${path.basename(apkPath, '.apk')}`
  );
  fs.mkdirSync(outDir, { recursive: true });
  logger.info(`decompileApk: ${apkPath} -> ${outDir}`);

  const ready = await ensureApktool((pct) => {
    onProgress({ phase: 'preparing', label: '准备 apktool/Java', progress: pct });
  });

  if (ready.jarPath && ready.javaVersion) {
    logger.info(`Using apktool: ${ready.javaCmd} -jar ${ready.jarPath}`);
    try {
      return await runApktool(apkPath, ready.javaCmd!, ready.jarPath, outDir, onProgress);
    } catch (err) {
      logger.warn('apktool failed, falling back to zip extraction:', err instanceof Error ? err.message : String(err));
    }
  }

  logger.info('Using zip fallback');
  return runZipFallback(apkPath, outDir, onProgress, ready);
}

async function runApktool(
  apkPath: string,
  javaCmd: string,
  jarPath: string,
  outDir: string,
  onProgress: (p: DecompProgress) => void
): Promise<DecompileResult> {
  logger.info(`runApktool: ${javaCmd} -jar ${jarPath} d -f -o ${outDir} ${apkPath}`);
  onProgress({ phase: 'extracting', label: 'apktool 反编译中…', progress: 10 });
  await new Promise<void>((resolve, reject) => {
    const args = ['-jar', jarPath, 'd', '-f', '-o', outDir, apkPath];
    const child = spawn(javaCmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let progress = 10;
    const interval = setInterval(() => {
      progress = Math.min(progress + 3, 88);
      onProgress({ phase: 'extracting', label: 'apktool 反编译中…', progress });
    }, 1000);

    let stderrBuf = '';
    child.stdout.on('data', (chunk) => {
      const s = chunk.toString();
      if (/Loading resource table/i.test(s)) progress = 30;
      if (/Copying raw resources/i.test(s)) progress = 50;
      if (/Decoding file-resources/i.test(s)) progress = 70;
      if (/Decoding values*/i.test(s)) progress = 80;
      if (/Decoding AndroidManifest.xml/i.test(s)) progress = 85;
    });
    child.stderr.on('data', (chunk) => {
      stderrBuf += chunk.toString();
    });

    child.on('error', (err) => {
      clearInterval(interval);
      logger.error(`apktool spawn error: ${err.message}`);
      reject(err);
    });
    child.on('close', (code) => {
      clearInterval(interval);
      if (code === 0) {
        logger.info('apktool completed successfully');
        resolve();
      } else {
        logger.error(`apktool exit ${code}: ${stderrBuf.slice(0, 500)}`);
        reject(new Error(`apktool exit ${code}: ${stderrBuf.slice(0, 500)}`));
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
