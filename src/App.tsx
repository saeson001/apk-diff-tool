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
  BugReport as BugReportIcon
} from '@mui/icons-material';
import UploadPanel from './components/UploadPanel';
import SummaryPanel from './components/SummaryPanel';
import PermissionsView from './components/PermissionsView';
import ManifestView from './components/ManifestView';
import SmaliDiffView from './components/SmaliDiffView';
import ResourcesView from './components/ResourcesView';
import DebugPanel from './components/DebugPanel';
import type { DiffReport, DecompProgress } from '../shared/types';

type TabKey = 'permissions' | 'manifest' | 'smali' | 'resources';

export default function App() {
  const [report, setReport] = useState<DiffReport | null>(null);
  const [progress, setProgress] = useState<DecompProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [apktoolInfo, setApktoolInfo] = useState<{ version: string | null; installed: boolean; javaVersion: string | null } | null>(null);
  const [tab, setTab] = useState<TabKey>('permissions');
  const [showDebug, setShowDebug] = useState(false);
  const sessionIdRef = useRef<string>('');

  useEffect(() => {
    if (!window.apkDiff) return;
    const unsub = window.apkDiff.onProgress(setProgress);
    window.apkDiff.getApktoolInfo().then(setApktoolInfo).catch(() => setApktoolInfo(null));
    // 监听菜单"诊断信息"
    const onDebug = () => setShowDebug(true);
    window.addEventListener('apk-diff-show-debug', onDebug);
    return () => {
      unsub();
      window.removeEventListener('apk-diff-show-debug', onDebug);
    };
  }, []);

  const handleStartDiff = useCallback(async (original: string, modified: string) => {
    if (!window.apkDiff) {
      setError('preload 未就绪：window.apkDiff 不存在');
      return;
    }
    setError(null);
    setReport(null);
    sessionIdRef.current = '';
    try {
      const r = await window.apkDiff.startDiff(original, modified);
      sessionIdRef.current = r.sessionId;
      setReport(r);
      setProgress({ phase: 'done', label: '完成', progress: 100 });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const isRunning = progress && progress.phase !== 'done' && progress.phase !== 'error' && progress.progress < 100;

  return (
    <Box sx={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <AppBar position="static" color="primary" elevation={1}>
        <Toolbar sx={{ gap: 2 }}>
          <AndroidIcon sx={{ mr: 1 }} />
          <Typography variant="h6" sx={{ flexGrow: 1, fontWeight: 600 }}>
            APK Diff Tool
          </Typography>
          <Typography variant="body2" color="rgba(255,255,255,0.85)" sx={{ mr: 1 }}>
            {apktoolInfo
              ? `apktool ${apktoolInfo.version || '待安装'} · Java ${apktoolInfo.javaVersion || '未检测'}`
              : 'apktool/Java 检测中…'}
          </Typography>
          <Tooltip title="诊断信息（查看路径、搜索记录、导出日志）">
            <IconButton color="inherit" size="small" onClick={() => setShowDebug(true)}>
              <BugReportIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Toolbar>
      </AppBar>

      <UploadPanel onStart={handleStartDiff} disabled={!!isRunning} />

      {error && (
        <Alert severity="error" sx={{ mx: 2, mt: 1 }}>
          {error}
        </Alert>
      )}

      {report && <SummaryPanel report={report} onTabClick={(k) => setTab(k)} />}

      {report && (
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
        {!isRunning && report && (
          <Box sx={{ height: '100%', overflow: 'auto' }}>
            {tab === 'permissions' && <PermissionsView rows={report.permissions} />}
            {tab === 'manifest' && <ManifestView result={report.manifest} />}
            {tab === 'smali' && <SmaliDiffView classes={report.classes} reportId={sessionIdRef.current} />}
            {tab === 'resources' && <ResourcesView resources={report.resources} reportId={sessionIdRef.current} />}
          </Box>
        )}
      </Box>

      <DebugPanel open={showDebug} onClose={() => setShowDebug(false)} />
    </Box>
  );
}
