import React, { useEffect, useState } from 'react';
import {
  Box,
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  Typography,
  CircularProgress,
  Divider,
  Chip
} from '@mui/material';

interface DebugPanelProps {
  open: boolean;
  onClose: () => void;
}

interface JarSearchEntry {
  path: string;
  exists: boolean;
  size: number;
  valid: boolean;
  error?: string;
}

interface JavaSearchEntry {
  candidate: string;
  found: boolean;
  version?: string;
}

function StatusChip({ ok, label }: { ok: boolean; label: string }) {
  return (
    <Chip
      size="small"
      label={label}
      color={ok ? 'success' : 'error'}
      sx={{ fontWeight: 600 }}
    />
  );
}

function InfoRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <Box sx={{ display: 'flex', gap: 1, py: 0.5, alignItems: 'baseline' }}>
      <Typography variant="caption" color="text.secondary" sx={{ minWidth: 100, flexShrink: 0 }}>
        {label}
      </Typography>
      <Typography
        variant="body2"
        sx={{
          wordBreak: 'break-all',
          fontFamily: mono ? 'monospace' : undefined,
          fontSize: 13
        }}
      >
        {value}
      </Typography>
    </Box>
  );
}

export default function DebugPanel({ open, onClose }: DebugPanelProps) {
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(false);
  const [exportMsg, setExportMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !window.apkDiff) return;
    setLoading(true);
    window.apkDiff.getDebugInfo()
      .then(setData)
      .catch(() => setData({ error: '无法获取诊断信息' }))
      .finally(() => setLoading(false));
  }, [open]);

  const handleOpenLogDir = async () => {
    if (window.apkDiff) await window.apkDiff.openLogDir();
  };

  const handleExportLog = async () => {
    if (!window.apkDiff) return;
    setExportMsg(null);
    const result = await window.apkDiff.exportLog();
    if (result) setExportMsg(`已导出到: ${result}`);
    else setExportMsg('导出取消或失败');
  };

  const jarSearch = (data?.jarSearchLog as JarSearchEntry[]) || [];
  const javaSearch = (data?.javaSearchLog as JavaSearchEntry[]) || [];
  const jarPath = (data?.jarPath as string) || null;
  const javaCmd = (data?.javaCmd as string) || null;
  const javaVersion = (data?.javaVersion as string) || null;

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <span>诊断信息</span>
          {loading && <CircularProgress size={16} />}
        </Box>
      </DialogTitle>
      <DialogContent dividers>
        {!data && !loading && (
          <Typography color="error">无法获取诊断信息</Typography>
        )}

        {data && (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {/* 状态概览 */}
            <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
              <StatusChip ok={!!jarPath} label={`apktool jar: ${jarPath ? '已找到' : '未找到'}`} />
              <StatusChip ok={!!javaVersion} label={`Java: ${javaVersion || '未检测'}`} />
              <StatusChip ok={!!data.isPackaged} label={`打包模式: ${data.isPackaged ? '是' : '否'}`} />
            </Box>
            <Divider />

            {/* 路径信息 */}
            <Box>
              <Typography variant="subtitle2" gutterBottom>关键路径</Typography>
              <InfoRow label="exePath" value={String(data.exePath || '')} mono />
              <InfoRow label="appPath" value={String(data.appPath || '')} mono />
              <InfoRow label="userData" value={String(data.userDataPath || '')} mono />
              <InfoRow label="logFile" value={String(data.logFile || '')} mono />
            </Box>
            <Divider />

            {/* apktool jar 搜索记录 */}
            <Box>
              <Typography variant="subtitle2" gutterBottom>apktool jar 搜索记录</Typography>
              {jarSearch.length === 0 ? (
                <Typography variant="body2" color="text.secondary">暂无搜索记录</Typography>
              ) : (
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                  {jarSearch.map((entry, i) => (
                    <Box key={i} sx={{ display: 'flex', gap: 1, alignItems: 'baseline', flexWrap: 'wrap' }}>
                      <StatusChip ok={entry.valid} label={entry.valid ? '有效' : '无效'} />
                      <Typography variant="body2" sx={{ fontFamily: 'monospace', fontSize: 12, wordBreak: 'break-all' }}>
                        {entry.path}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        exists={entry.exists} size={entry.exists ? `${(entry.size / 1024 / 1024).toFixed(1)}MB` : '-'}
                        {entry.error ? ` error=${entry.error}` : ''}
                      </Typography>
                    </Box>
                  ))}
                </Box>
              )}
            </Box>
            <Divider />

            {/* Java 搜索记录 */}
            <Box>
              <Typography variant="subtitle2" gutterBottom>Java 搜索记录</Typography>
              {javaSearch.length === 0 ? (
                <Typography variant="body2" color="text.secondary">暂无搜索记录</Typography>
              ) : (
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
                  {javaSearch.map((entry, i) => (
                    <Box key={i} sx={{ display: 'flex', gap: 1, alignItems: 'baseline' }}>
                      <StatusChip ok={entry.found} label={entry.found ? '找到' : '未找到'} />
                      <Typography variant="body2" sx={{ fontFamily: 'monospace', fontSize: 12, wordBreak: 'break-all' }}>
                        {entry.candidate}
                      </Typography>
                      {entry.version && (
                        <Typography variant="caption" color="text.secondary">
                          v{entry.version}
                        </Typography>
                      )}
                    </Box>
                  ))}
                </Box>
              )}
            </Box>
            <Divider />

            {/* 其他信息 */}
            <Box>
              <Typography variant="subtitle2" gutterBottom>其他信息</Typography>
              <InfoRow label="appVersion" value={String(data.appVersion || '')} />
              <InfoRow label="platform" value={String(data.platform || '')} />
              <InfoRow label="arch" value={String(data.arch || '')} />
              <InfoRow label="nodeVersion" value={String(data.nodeVersion || '')} />
              <InfoRow label="electronVersion" value={String(data.electronVersion || '')} />
            </Box>
          </Box>
        )}

        {/* 底部操作按钮 */}
        <Box sx={{ display: 'flex', gap: 1, mt: 2, flexWrap: 'wrap' }}>
          <Button variant="outlined" size="small" onClick={handleOpenLogDir} disabled={!data}>
            打开日志目录
          </Button>
          <Button variant="outlined" size="small" onClick={handleExportLog} disabled={!data}>
            导出日志…
          </Button>
          <Button variant="contained" size="small" onClick={onClose}>
            关闭
          </Button>
        </Box>
        {exportMsg && (
          <Typography variant="caption" sx={{ display: 'block', mt: 1, color: 'text.secondary' }}>
            {exportMsg}
          </Typography>
        )}
      </DialogContent>
    </Dialog>
  );
}
