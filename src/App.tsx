import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  Box,
  AppBar,
  Toolbar,
  Typography,
  Tab,
  Tabs,
  Alert,
  CircularProgress,
  Tooltip,
  IconButton,
  Divider
} from '@mui/material';
import {
  Android as AndroidIcon,
  CompareArrows as CompareIcon,
  Description as DescriptionIcon,
  Inventory2 as ResourcesIcon,
  BugReport as BugReportIcon,
  Settings as SettingsIcon,
  SmartToy as AIIcon,
  Forum as ChatIcon
} from '@mui/icons-material';
import UploadPanel from './components/UploadPanel';
import SummaryPanel from './components/SummaryPanel';
import PermissionsView from './components/PermissionsView';
import ManifestView from './components/ManifestView';
import SmaliDiffView from './components/SmaliDiffView';
import ResourcesView from './components/ResourcesView';
import DebugPanel from './components/DebugPanel';
import JavaSettingsDialog from './components/JavaSettingsDialog';
import AISettingsDialog from './components/AISettingsDialog';
import HashDiffView, { FocusedFilePayload } from './components/HashDiffView';
import AIChatPanel, { ChatAction } from './components/AIChatPanel';
import type { DiffReport, DecompProgress, HashDiffReport, AIRecommendation, VersionCheckResult } from '../shared/types';

type TabKey = 'permissions' | 'manifest' | 'smali' | 'resources';

export default function App() {
  const [report, setReport] = useState<DiffReport | null>(null);
  const [hashReport, setHashReport] = useState<HashDiffReport | null>(null);
  const [progress, setProgress] = useState<DecompProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [apktoolInfo, setApktoolInfo] = useState<{ version: string | null; installed: boolean; javaVersion: string | null } | null>(null);
  const [tab, setTab] = useState<TabKey>('permissions');
  const [showDebug, setShowDebug] = useState(false);
  const [showJavaSettings, setShowJavaSettings] = useState(false);
  const [showAISettings, setShowAISettings] = useState(false);
  const [aiConfigured, setAiConfigured] = useState(false);
  const [aiThinking, setAiThinking] = useState(false);
  const [aiRecommendation, setAiRecommendation] = useState<AIRecommendation | null>(null);
  const [appVersion, setAppVersion] = useState<string>('');
  const [versionCheck, setVersionCheck] = useState<VersionCheckResult | null>(null);
  const [preloadError, setPreloadError] = useState(false);
  // AI 对话面板状态
  const [chatOpen, setChatOpen] = useState(false);
  const [chatPrefill, setChatPrefill] = useState<string | null>(null);
  const [focusedFile, setFocusedFile] = useState<FocusedFilePayload | null>(null);
  const [chatViewRequest, setChatViewRequest] = useState<string | null>(null);
  const lastPathsRef = useRef<{ original: string; modified: string } | null>(null);
  const sessionIdRef = useRef<string>('');

  useEffect(() => {
    if (!window.apkDiff) {
      setPreloadError(true);
      return;
    }
    const unsub = window.apkDiff.onProgress(setProgress);
    window.apkDiff.getApktoolInfo().then(setApktoolInfo).catch(() => setApktoolInfo(null));
    window.apkDiff.getAppVersion().then(setAppVersion).catch(() => {});
    window.apkDiff.getVersionCheck().then(setVersionCheck).catch(() => {});
    window.apkDiff.getAISettings().then(s => setAiConfigured(!!(s.baseUrl && s.apiKey && s.model))).catch(() => {});
    const onDebug = () => setShowDebug(true);
    window.addEventListener('apk-diff-show-debug', onDebug);
    return () => {
      unsub();
      window.removeEventListener('apk-diff-show-debug', onDebug);
    };
  }, []);

  // Refresh AI config status when dialog closes
  const refreshAiStatus = useCallback(() => {
    if (!window.apkDiff) return;
    window.apkDiff.getAISettings().then(s => setAiConfigured(!!(s.baseUrl && s.apiKey && s.model))).catch(() => {});
  }, []);

  const handleStartDiff = useCallback(async (original: string, modified: string, forceFull?: boolean) => {
    if (!window.apkDiff) {
      setError('preload 未就绪：window.apkDiff 不存在');
      return;
    }
    setError(null);
    setReport(null);
    setHashReport(null);
    setAiRecommendation(null);
    setFocusedFile(null);
    setChatOpen(false);
    lastPathsRef.current = { original, modified };
    sessionIdRef.current = '';

    // Step 1: Gather APK metadata
    setAiThinking(true);
    setProgress({ phase: 'preparing', label: '分析 APK 元数据…', progress: 5 });

    try {
      const [origMeta, modMeta] = await Promise.all([
        window.apkDiff.getApkMetadata(original),
        window.apkDiff.getApkMetadata(modified)
      ]);

      // Step 2: If AI is configured, get recommendation (skip when user explicitly wants full diff)
      if (aiConfigured && !forceFull) {
        setProgress({ phase: 'preparing', label: 'AI 分析中…', progress: 15 });
        try {
          const rec = await window.apkDiff.getAIRecommendation(origMeta, modMeta);
          setAiRecommendation(rec);

          // If AI recommends hash_only, use it
          if (rec.approach === 'hash_only') {
            setProgress({ phase: 'comparing', label: 'AI 推荐：快速哈希比对…', progress: 40 });
            const hr = await window.apkDiff.startHashDiff(original, modified, rec);
            setHashReport(hr);
            setProgress({ phase: 'done', label: '哈希比对完成', progress: 100 });
            setAiThinking(false);
            return;
          }
        } catch (err) {
          console.warn('AI recommendation failed, falling back to full apktool', err);
        }
      }

      // Step 3: Full apktool decompile (default / fallback)
      setProgress({ phase: 'preparing', label: '完整反编译对比中…', progress: 20 });
      const r = await window.apkDiff.startDiff(original, modified);
      sessionIdRef.current = r.sessionId;
      setReport(r);
      setProgress({ phase: 'done', label: '完成', progress: 100 });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAiThinking(false);
    }
  }, [aiConfigured]);

  // 从 AI 推荐栏 / 对话操作发起完整反编译对比
  const startFullDiff = useCallback(() => {
    const p = lastPathsRef.current;
    if (!p) return;
    setChatOpen(false);
    handleStartDiff(p.original, p.modified, true);
  }, [handleStartDiff]);

  // 从文件对话框 / AI 回复发起"就此文件提问"
  const askAIAboutFile = useCallback((path: string) => {
    setChatPrefill(path ? `请分析 ${path} 的差异内容：改了什么，有什么影响？` : null);
    setChatOpen(true);
  }, []);

  // AI 回复中的操作请求
  const handleChatAction = useCallback((action: ChatAction) => {
    if (action.type === 'view_file' && action.path) {
      if (hashReport) {
        setChatViewRequest(action.path);
      }
    } else if (action.type === 'full_diff') {
      startFullDiff();
    }
  }, [hashReport, startFullDiff]);

  // 构建 AI 对话的对比上下文（主进程会注入为 system 消息）
  const buildChatContext = useCallback((): string => {
    const mb = (n: number) => (n / 1024 / 1024).toFixed(1) + ' MB';
    if (hashReport) {
      const s = hashReport.summary;
      const lines: string[] = [
        `对比模式: 快速哈希比对（未反编译，只能看到文件级差异）`,
        `原版: ${hashReport.original.name} (${mb(hashReport.original.size)})`,
        `修改版: ${hashReport.modified.name} (${mb(hashReport.modified.size)})`,
        `统计: 新增 ${s.added} / 删除 ${s.removed} / 修改 ${s.modified} / 未变 ${s.unchanged}`
      ];
      const changed = hashReport.entries.filter(e => e.status !== 'unchanged');
      const shown = changed.slice(0, 100);
      lines.push(`变更文件（共 ${changed.length} 个，最多显示 100 条，格式: 状态 | 路径 | 原大小B | 新大小B）:`);
      for (const e of shown) {
        lines.push(`${e.status} | ${e.path} | ${e.originalSize ?? '-'} | ${e.modifiedSize ?? '-'}`);
      }
      if (changed.length > shown.length) lines.push(`(其余 ${changed.length - shown.length} 个变更文件未列出)`);
      return lines.join('\n');
    }
    if (report) {
      const s = report.summary;
      const lines: string[] = [
        `对比模式: 完整 apktool 反编译对比`,
        `原版: ${report.original.name} (${mb(report.original.size)})`,
        `修改版: ${report.modified.name} (${mb(report.modified.size)})`,
        `统计: 文件 新增${s.addedFiles}/删除${s.removedFiles}/修改${s.modifiedFiles}；权限 新增${s.permissionsAdded}/删除${s.permissionsRemoved}/修改${s.permissionsModified}`
      ];
      const permChanges = report.permissions.filter(p => p.status !== 'kept').slice(0, 30);
      if (permChanges.length) {
        lines.push('权限变更（前30）: ' + permChanges.map(p => `${p.permission}(${p.status})`).join(', '));
      }
      const changedClasses = report.classes.filter(c => c.status !== 'unchanged').slice(0, 50);
      if (changedClasses.length) {
        lines.push(`变更类（前50，共 ${report.classes.filter(c => c.status !== 'unchanged').length} 个）:`);
        for (const c of changedClasses) lines.push(`${c.status} | ${c.className}`);
      }
      const changedRes = report.resources.filter(r => r.status !== 'unchanged').slice(0, 50);
      if (changedRes.length) {
        lines.push(`变更资源（前50，共 ${report.resources.filter(r => r.status !== 'unchanged').length} 个）:`);
        for (const r of changedRes) lines.push(`${r.status} | ${r.path}`);
      }
      return lines.join('\n');
    }
    return '';
  }, [hashReport, report]);

  const isRunning = progress && progress.phase !== 'done' && progress.phase !== 'error' && progress.progress < 100;
  const isHashMode = hashReport !== null;
  const chatKey = hashReport?.sessionId || report?.sessionId || 'none';

  // 预加载脚本加载失败时的降级 UI
  if (preloadError) {
    return (
      <Box sx={{ height: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 3, p: 4 }}>
        <BugReportIcon color="error" sx={{ fontSize: 64 }} />
        <Typography variant="h5" color="error" fontWeight="bold">
          预加载脚本加载失败
        </Typography>
        <Typography variant="body1" color="text.secondary" textAlign="center" sx={{ maxWidth: 500 }}>
          Electron preload 脚本未正确加载，可能原因：
          <br />1. 解压不完整（请删除旧目录后重新解压）
          <br />2. 文件被占用（请关闭旧进程后重新解压）
          <br />3. 版本文件混用（请完全删除后重新下载）
        </Typography>
        <Alert severity="warning" sx={{ maxWidth: 500 }}>
          请删除 D:\test\apkdiff\ 目录，然后重新解压最新版本的 ZIP 文件
        </Alert>
        {appVersion && (
          <Typography variant="body2" color="text.secondary">
            当前应用版本: v{appVersion}
          </Typography>
        )}
      </Box>
    );
  }

  return (
    <Box sx={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <AppBar position="static" color="primary" elevation={1}>
        <Toolbar sx={{ gap: 2 }}>
          <AndroidIcon sx={{ mr: 1 }} />
          <Typography variant="h6" sx={{ flexGrow: 1, fontWeight: 600 }}>
            APK Diff Tool
          </Typography>
          {appVersion && (
            <Typography variant="body2" sx={{ mr: 1, px: 1, py: 0.25, borderRadius: 1, backgroundColor: 'rgba(255,255,255,0.15)', color: 'rgba(255,255,255,0.95)', fontWeight: 600, fontFamily: 'monospace' }}>
              v{appVersion}
            </Typography>
          )}
          <Typography variant="body2" color="rgba(255,255,255,0.85)" sx={{ mr: 1 }}>
            {apktoolInfo
              ? apktoolInfo.version
                ? `apktool ${apktoolInfo.version} · Java ${apktoolInfo.javaVersion || ''}`
                : apktoolInfo.installed
                  ? 'apktool jar 已就绪 · Java 未就绪（点击齿轮图标配置）'
                  : 'apktool 待安装'
              : 'apktool/Java 检测中…'}
          </Typography>
          <Tooltip title="AI 对话（针对当前对比结果提问）">
            <IconButton color="inherit" size="small" onClick={() => setChatOpen(true)}>
              <ChatIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title="诊断信息（查看路径、搜索记录、导出日志）">
            <IconButton color="inherit" size="small" onClick={() => setShowDebug(true)}>
              <BugReportIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title="Java 路径配置">
            <IconButton color="inherit" size="small" onClick={() => setShowJavaSettings(true)}>
              <SettingsIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title={aiConfigured ? 'AI API 已配置（点击修改）' : 'AI API 配置（启用后自动推荐分析方案）'}>
            <IconButton color="inherit" size="small" onClick={() => setShowAISettings(true)}>
              <AIIcon fontSize="small" style={aiConfigured ? { color: '#4caf50' } : undefined} />
            </IconButton>
          </Tooltip>
        </Toolbar>
      </AppBar>

      {/* 版本检测失败警告 */}
      {versionCheck && versionCheck.isFallback && (
        <Alert severity="error" sx={{ mx: 2, mt: 1, fontWeight: 'bold' }}>
          版本检测失败！当前显示的是兜底版本号 v{versionCheck.finalVersion}，可能不是最新版本。
          请完全删除安装目录后重新解压最新 ZIP 文件。
        </Alert>
      )}

      <UploadPanel onStart={(o, m) => handleStartDiff(o, m)} disabled={!!isRunning} />

      {error && (
        <Alert severity="error" sx={{ mx: 2, mt: 1 }}>
          {error}
        </Alert>
      )}

      {/* Full apktool report */}
      {report && !isHashMode && <SummaryPanel report={report} onTabClick={(k) => setTab(k)} />}

      {report && !isHashMode && (
        <Tabs
          value={tab}
          onChange={(_e, v: TabKey) => setTab(v)}
          sx={{ px: 2, mt: 1, borderBottom: '1px solid #e2e8f0' }}
          variant="scrollable"
          scrollButtons="auto"
        >
          <Tab value="permissions" icon={<AndroidIcon />} label={`权限 (${report.permissions.length})`} />
          <Tab value="manifest" icon={<DescriptionIcon />} label="Manifest" />
          <Tab value="smali" icon={<CompareIcon />} label={`smali (${report.classes.filter((c) => c.status !== 'unchanged').length} 变更)`} />
          <Tab value="resources" icon={<ResourcesIcon />} label={`资源 (${report.resources.filter((r) => r.status !== 'unchanged').length} 变更)`} />
        </Tabs>
      )}

      <Box sx={{ flex: 1, overflow: 'hidden', px: 2, pb: 2, pt: 1 }}>
        {isRunning && (
          <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 2 }}>
            <CircularProgress />
            <Typography>{progress?.label || '处理中…'}</Typography>
            <Typography variant="body2" color="text.secondary">{progress?.progress || 0}%</Typography>
          </Box>
        )}
        {!isRunning && report && !isHashMode && (
          <Box sx={{ height: '100%', overflow: 'auto' }}>
            {tab === 'permissions' && <PermissionsView rows={report.permissions} />}
            {tab === 'manifest' && <ManifestView result={report.manifest} />}
            {tab === 'smali' && <SmaliDiffView classes={report.classes} reportId={sessionIdRef.current} />}
            {tab === 'resources' && <ResourcesView resources={report.resources} reportId={sessionIdRef.current} />}
          </Box>
        )}
        {hashReport && (
          <Box sx={{ height: '100%', overflow: 'auto' }}>
            <HashDiffView
              report={hashReport}
              onStartFullDiff={startFullDiff}
              onAskAI={askAIAboutFile}
              onFocusedFileChange={setFocusedFile}
              openPathRequest={chatViewRequest}
              onOpenPathRequestDone={() => setChatViewRequest(null)}
            />
          </Box>
        )}
      </Box>

      {/* 底部状态栏 */}
      <Box sx={{ px: 2, py: 0.5, borderTop: '1px solid #e2e8f0', display: 'flex', alignItems: 'center', gap: 2, fontSize: 12, color: 'text.secondary', backgroundColor: '#fafafa' }}>
        <Typography variant="caption" sx={{ fontFamily: 'monospace', fontWeight: 600 }}>
          v{appVersion || '检测中…'}
        </Typography>
        {versionCheck && versionCheck.isFallback && (
          <Typography variant="caption" color="error" sx={{ fontWeight: 'bold' }}>
            (兜底版本 - 检测失败)
          </Typography>
        )}
        <Box sx={{ flex: 1 }} />
        <Typography variant="caption">
          {versionCheck ? `检测于 ${new Date(versionCheck.checkedAt).toLocaleTimeString()} · ${versionCheck.methods.filter(m => m.success).length}/${versionCheck.methods.length} 方法成功` : ''}
        </Typography>
      </Box>

      <DebugPanel open={showDebug} onClose={() => setShowDebug(false)} />
      <JavaSettingsDialog open={showJavaSettings} onClose={() => setShowJavaSettings(false)} />
      <AISettingsDialog open={showAISettings} onClose={() => { setShowAISettings(false); refreshAiStatus(); }} />
      <AIChatPanel
        key={chatKey}
        open={chatOpen}
        onClose={() => setChatOpen(false)}
        context={buildChatContext()}
        aiConfigured={aiConfigured}
        onOpenAISettings={() => setShowAISettings(true)}
        focusedFile={focusedFile}
        prefill={chatPrefill}
        onPrefillConsumed={() => setChatPrefill(null)}
        onAction={handleChatAction}
      />
    </Box>
  );
}
