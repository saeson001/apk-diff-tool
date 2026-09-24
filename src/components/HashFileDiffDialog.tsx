import React, { useEffect, useState } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions,
  Box, Typography, Chip, Button, CircularProgress, Alert
} from '@mui/material';
import { SmartToy as AIIcon, Build as BuildIcon } from '@mui/icons-material';
import DiffTextView from './DiffTextView';
import type { HashDiffEntry, HashFileDiffResult } from '../../shared/types';

interface Props {
  open: boolean;
  entry: HashDiffEntry | null;
  reportId: string;
  onClose: () => void;
  /** 由此文件发起 AI 提问（填入对话输入框并打开面板） */
  onAskAI: (path: string) => void;
  /** 从 dex 等受限场景发起完整反编译对比 */
  onStartFullDiff: () => void;
  /** 对比内容加载完成后回调（供 AI 对话注入上下文），关闭时回调 null */
  onContextChange: (payload: { path: string; diffText: string; note: string } | null) => void;
}

const STATUS_LABEL: Record<HashDiffEntry['status'], string> = {
  modified: '修改',
  added: '新增',
  removed: '删除',
  unchanged: '未变'
};

function formatSize(bytes?: number): string {
  if (bytes === undefined) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export default function HashFileDiffDialog({ open, entry, reportId, onClose, onAskAI, onStartFullDiff, onContextChange }: Props) {
  const [result, setResult] = useState<HashFileDiffResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !entry) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setResult(null);
    window.apkDiff.getHashFileDiff(reportId, entry.path)
      .then(r => { if (!cancelled) setResult(r); })
      .catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, entry, reportId]);

  // 加载完成后向 App 上报上下文（AI 对话使用），关闭时清空
  useEffect(() => {
    if (open && result && result.kind === 'text-diff' && result.diff) {
      onContextChange({ path: result.path, diffText: result.diff, note: result.transformNote || '' });
    } else if (open && result && result.kind !== 'text-diff') {
      onContextChange({ path: result.path, diffText: '', note: result.note || '' });
    }
    if (!open) onContextChange(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, result]);

  const isChanged = entry && entry.status !== 'unchanged';

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="lg" PaperProps={{ sx: { height: '85vh' } }}>
      <DialogTitle sx={{ py: 1.5, display: 'flex', alignItems: 'center', gap: 1 }}>
        <Typography variant="subtitle1" sx={{ fontFamily: 'monospace', fontWeight: 600, flex: 1, wordBreak: 'break-all' }}>
          {entry?.path || ''}
        </Typography>
        {entry && <Chip size="small" color={entry.status === 'modified' ? 'warning' : entry.status === 'added' ? 'success' : 'error'} label={STATUS_LABEL[entry.status]} />}
        {entry && (
          <Typography variant="caption" color="text.secondary">
            {formatSize(entry.originalSize)} → {formatSize(entry.modifiedSize)}
          </Typography>
        )}
      </DialogTitle>
      <DialogContent sx={{ p: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
        {loading && (
          <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', py: 8, gap: 2 }}>
            <CircularProgress size={32} />
            <Typography variant="body2" color="text.secondary">正在从两个 APK 中提取该文件并对比…</Typography>
          </Box>
        )}
        {error && <Alert severity="error" sx={{ m: 2 }}>{error}</Alert>}
        {!loading && !error && result && result.kind === 'text-diff' && (
          <>
            {result.transformNote && (
              <Alert severity="info" sx={{ mx: 2, mt: 1, py: 0.5 }}>{result.transformNote}</Alert>
            )}
            <Box sx={{ px: 2, pt: 1, display: 'flex', gap: 1 }}>
              <Chip size="small" color="success" label={`+${result.additions ?? 0}`} />
              <Chip size="small" color="error" label={`-${result.deletions ?? 0}`} />
            </Box>
            <Box sx={{ flex: 1, overflow: 'hidden', mx: 2, mb: 1, border: '1px solid #e2e8f0', borderRadius: 1 }}>
              <DiffTextView diffText={result.diff || ''} />
            </Box>
          </>
        )}
        {!loading && !error && result && (result.kind === 'binary' || result.kind === 'unsupported') && (
          <Alert severity="warning" sx={{ m: 2 }}>{result.note}</Alert>
        )}
        {!loading && !error && result && result.kind === 'error' && (
          <Alert severity="error" sx={{ m: 2 }}>{result.note}</Alert>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 2, py: 1 }}>
        {result?.kind === 'unsupported' && (
          <Button size="small" startIcon={<BuildIcon />} onClick={onStartFullDiff}>
            开始完整反编译对比
          </Button>
        )}
        {isChanged && (
          <Button size="small" startIcon={<AIIcon />} onClick={() => entry && onAskAI(entry.path)}>
            询问 AI 此文件改了什么
          </Button>
        )}
        <Button size="small" onClick={onClose}>关闭</Button>
      </DialogActions>
    </Dialog>
  );
}
