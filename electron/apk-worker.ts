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

const APKTOOL_VERSION = '2.9.3';
const APKTOOL_DOWNLOAD_URLS = [
  `https://github.com/iBotPeaches/Apktool/releases/download/v${APKTOOL_VERSION}/apktool_${APKTOOL_VERSION}.jar`,
  `https://ghproxy.com/https://github.com/iBotPeaches/Apktool/releases/download/v${APKTOOL_VERSION}/apktool_${APKTOOL_VERSION}.jar`,
  `https://mirror.ghproxy.com/https://github.com/iBotPeaches/Apktool/releases/download/v${APKTOOL_VERSION}/apktool_${APKTOOL_VERSION}.jar`,
];

interface ApkooleState {
  jarPath: string | null;
  javaCmd: string | null;
  javaVersion: string | null;
  portableJdkDir: string | null;
}

const state: ApkooleState = {
  jarPath: null,
  javaCmd: null,
  javaVersion: null,
  portableJdkDir: null
};

// -------------------------------------------------------------------------
// 路径辅助
// -------------------------------------------------------------------------

function toolsDir(): string {
  const dir = path.join(app.getPath('userData'), 'tools');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function getApktoolJarPath(): string {
  return path.join(toolsDir(), `apktool_${APKTOOL_VERSION}.jar`);
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
        if (match) return { cmd: candidate, version: match[1] };
      }
    } catch (_err) {
      // 忽略，尝试下一个候选
    }
  }
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
        // 跟随跳转
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
        // 先结束写入流，等 close 事件后再 rename，避免 Windows EPERM
        file.end(() => {
          try {
            // 如果目标文件已存在（上次残留），先删除
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
        if (match) return { cmd: jdkCmd, version: match[1] };
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
      const archivePath = path.join(toolsDir(), `zulu-17.${ext}`);
      onProgress?.(10);
      await downloadFile(url, archivePath, (pct) => onProgress?.(10 + Math.round(pct * 0.7)));
      onProgress?.(85);

      fs.mkdirSync(jdkDir, { recursive: true });
      // 解压到 jdkDir
      if (ext === 'zip' || ext === 'tgz') {
        // 用系统 tar/unzip
        if (ext === 'tgz') {
          spawnSync('tar', ['-xzf', archivePath, '-C', jdkDir], { timeout: 120000 });
        } else {
          spawnSync('tar', ['-xf', archivePath, '-C', jdkDir], { timeout: 120000 });
        }
        try { fs.unlinkSync(archivePath); } catch { /* noop */ }
      }
      onProgress?.(95);

      if (fs.existsSync(jdkCmd)) {
        const result = spawnSync(jdkCmd, ['-version'], { timeout: 5000, encoding: 'utf8' });
        const versionLine = (result.stderr || '').split('\n').find((l) => l.includes('"'));
        if (versionLine) {
          const match = versionLine.match(/"([^"]+)"/);
          if (match) return { cmd: jdkCmd, version: match[1] };
        }
      }
    } catch (err) {
      console.warn('[apk-worker] portable JDK download failed:', err);
    }
  }
  return null;
}

async function ensureJava(onProgress?: (pct: number) => void): Promise<{ cmd: string; version: string } | null> {
  const systemJava = findSystemJava();
  if (systemJava) {
    state.javaCmd = systemJava.cmd;
    state.javaVersion = systemJava.version;
    return systemJava;
  }
  // 尝试下载便携 JDK
  const portable = await ensurePortableJdk(onProgress);
  if (portable) {
    state.javaCmd = portable.cmd;
    state.javaVersion = portable.version;
    state.portableJdkDir = path.dirname(path.dirname(portable.cmd));
    return portable;
  }
  return null;
}

// -------------------------------------------------------------------------
// apktool 检测/下载
// -------------------------------------------------------------------------

async function ensureApktoolJar(onProgress?: (pct: number) => void): Promise<string | null> {
  const jarPath = getApktoolJarPath();
  if (fs.existsSync(jarPath) && fs.statSync(jarPath).size > 1_000_000) {
    state.jarPath = jarPath;
    return jarPath;
  }
  // 尝试多个下载源，每个源最多重试 2 次
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const url of APKTOOL_DOWNLOAD_URLS) {
      try {
        console.log(`[apk-worker] downloading apktool from ${url} (attempt ${attempt + 1})`);
        await downloadFile(url, jarPath, onProgress);
        if (fs.existsSync(jarPath) && fs.statSync(jarPath).size > 1_000_000) {
          state.jarPath = jarPath;
          return jarPath;
        }
      } catch (err) {
        console.warn(`[apk-worker] apktool download failed from ${url}:`, err);
        // 清理不完整的下载
        try { if (fs.existsSync(jarPath)) fs.unlinkSync(jarPath); } catch { /* noop */ }
      }
    }
  }
  console.error('[apk-worker] all apktool download sources failed');
  return null;
}

export async function getApktoolVersion(): Promise<string | null> {
  if (!state.jarPath || !state.javaCmd) return null;
  try {
    const result = spawnSync(state.javaCmd, ['-jar', state.jarPath, '--version'], {
      timeout: 10000,
      encoding: 'utf8'
    });
    const text = (result.stdout || result.stderr || '').trim();
    return text || APKTOOL_VERSION;
  } catch {
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
  const javaInfo = await ensureJava(onProgress);
  if (javaInfo) {
    state.javaCmd = javaInfo.cmd;
    state.javaVersion = javaInfo.version;
  }
  const jarPath = await ensureApktoolJar(onProgress);
  const version = javaInfo && jarPath ? await getApktoolVersion() : null;
  return { version, jarPath, javaVersion: state.javaVersion, javaCmd: state.javaCmd };
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

  const ready = await ensureApktool((pct) => {
    onProgress({ phase: 'preparing', label: '准备 apktool/Java', progress: pct });
  });

  if (ready.jarPath && ready.javaVersion) {
    try {
      return await runApktool(apkPath, ready.javaCmd!, ready.jarPath, outDir, onProgress);
    } catch (err) {
      console.warn('[apk-worker] apktool failed, falling back to zip extraction:', err);
    }
  }

  // 降级：仅解压 zip
  return runZipFallback(apkPath, outDir, onProgress, ready);
}

async function runApktool(
  apkPath: string,
  javaCmd: string,
  jarPath: string,
  outDir: string,
  onProgress: (p: DecompProgress) => void
): Promise<DecompileResult> {
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
      // apktool 会输出 "I: Copying raw resources..." / "I: Loading resource table..."
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
      reject(err);
    });
    child.on('close', (code) => {
      clearInterval(interval);
      if (code === 0) resolve();
      else reject(new Error(`apktool exit ${code}: ${stderrBuf.slice(0, 500)}`));
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
  onProgress({ phase: 'extracting', label: '降级：直接解压 APK（无 Java/apktool）', progress: 40 });
  const fallbackReason = !ready.javaVersion
    ? '系统未找到 Java 且便携 JDK 下载失败，无法反编译 smali'
    : 'apktool 反编译失败，使用 zip 解压模式';
  try {
    const zip = new AdmZip(apkPath);
    zip.extractAllTo(outDir, true);
    onProgress({ phase: 'comparing', label: 'zip 降级模式', progress: 100, detail: fallbackReason });
  } catch (err) {
    onProgress({ phase: 'error', label: '解压失败', progress: 100, detail: String(err) });
  }
  return { outDir, usedFallback: true, fallbackReason };
}
