import React, { useEffect, useMemo, useState } from 'react';
import {
  Box,
  Paper,
  Typography,
  Chip,
  CircularProgress,
  Divider,
  TextField,
  MenuItem,
  Alert
} from '@mui/material';
import type { ResourceFileDiff } from '../../shared/types';

type DiffLineKind = 'add' | 'del' | 'ctx' | 'hunk' | 'header';

interface Props {
  resources: ResourceFileDiff[];
  reportId: string;
}

interface ParsedLine {
  kind: DiffLineKind;
  text: string;
  origLine: number | null;
  modLine: number | null;
}

function parseDiffWithLineNumbers(diffText: string): ParsedLine[] {
  const out: ParsedLine[] = [];
  let origLine = 1;
  let modLine = 1;
  for (const raw of diffText.split('\n')) {
    if (raw.startsWith('@@')) {
      const m = raw.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) {
        origLine = parseInt(m[1], 10);
        modLine = parseInt(m[2], 10);
      }
      out.push({ kind: 'hunk', text: raw, origLine: null, modLine: null });
    } else if (raw.startsWith('+++') || raw.startsWith('---')) {
      out.push({ kind: 'header', text: raw, origLine: null, modLine: null });
    } else if (raw.startsWith('+')) {
      out.push({ kind: 'add', text: raw.slice(1), origLine: null, modLine });
      modLine++;
    } else if (raw.startsWith('-')) {
      out.push({ kind: 'del', text: raw.slice(1), origLine, modLine: null });
      origLine++;
    } else {
      out.push({ kind: 'ctx', text: raw.replace(/^\s/, ''), origLine, modLine });
      origLine++;
      modLine++;
    }
  }
  return out;
}

function LineNum({ n }: { n: number | null }) {
  if (n == null) return <Box sx={{ width: 44, textAlign: 'right', color: 'transparent', userSelect: 'none' }}>&nbsp;</Box>;
  return <Box sx={{ width: 44, textAlign: 'right', color: '#94a3b8', userSelect: 'none', flexShrink: 0 }}>{n}</Box>;
}

function parseDiffLine(line: string): DiffLineKind {
  if (!line) return 'ctx';
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+++') || line.startsWith('---')) return 'header';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  return 'ctx';
}

function formatSize(bytes?: number): string {
  if (bytes == null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export default function ResourcesView({ resources, reportId }: Props) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [diffText, setDiffText] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<'all' | 'added' | 'removed' | 'modified'>('modified');
  const [kindFilter, setKindFilter] = useState<'all' | 'text' | 'binary'>('all');

  const filtered = useMemo(() => {
    let out = resources;
    if (filter !== 'all') out = out.filter((r) => r.status === filter);
    if (kindFilter !== 'all') out = out.filter((r) => r.kind === kindFilter);
    return out;
  }, [resources, filter, kindFilter]);

  useEffect(() => {
    if (!selectedPath && filtered.length > 0) {
      const first = filtered.find((r) => r.status !== 'unchanged');
      if (first) setSelectedPath(first.path);
    }
  }, [filtered, selectedPath]);

  useEffect(() => {
    if (!selectedPath || !window.apkDiff) return;
    setLoading(true);
    window.apkDiff
      .getResourceDiff(reportId, selectedPath)
      .then(setDiffText)
      .catch((err) => setDiffText(`加载失败: ${err}`))
      .finally(() => setLoading(false));
  }, [selectedPath, reportId]);

  const selected = useMemo(
    () => resources.find((r) => r.path === selectedPath) || null,
    [resources, selectedPath]
  );

  const renderDiff = () => {
    if (loading) {
      return (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
          <CircularProgress size="small" />
        </Box>
      );
    }
    if (!diffText) {
      return <Typography variant="body2" color="text.secondary" sx={{ p: 4 }}>无差异内容</Typography>;
    }
    return (
      <Box sx={{ flex: 1, overflow: 'auto', height: 0 }}>
        {parseDiffWithLineNumbers(diffText).map((p, i) => (
          <Box
            key={i}
            className={`diff-line ${p.kind}`}
            sx={{ display: 'flex', fontFamily: 'monospace', fontSize: 13, lineHeight: 1.5, alignItems: 'baseline' }}
          >
            <LineNum n={p.origLine} />
            <LineNum n={p.modLine} />
            <Box sx={{ flex: 1, whiteSpace: 'pre-wrap', wordBreak: 'break-all', pl: 1, pr: 1 }}>
              {p.text || '\u00a0'}
            </Box>
          </Box>
        ))}
      </Box>
    );
  };

  const renderBinaryInfo = () => {
    if (!selected || selected.kind !== 'binary') return null;
    return (
      <Alert
        severity="info"
        sx={{ m: 1 }}
        action={<Chip size="small" label="二进制对比" />}
      >
        <Box sx={{ fontFamily: 'monospace', fontSize: 13 }}>
          <div>原版大小: {formatSize(selected.originalSize)}</div>
          <div>修改版大小: {formatSize(selected.modifiedSize)}</div>
          <div>原版哈希: {selected.originalHash || '—'}</div>
          <div>修改版哈希: {selected.modifiedHash || '—'}</div>
        </Box>
      </Alert>
    );
  };

  return (
    <Box sx={{ display: 'flex', height: '100%', gap: 1, p: 1 }}>
      <Paper sx={{ width: 380, p: 1, display: 'flex', flexDirection: 'column' }} variant="outlined">
        <Box sx={{ mb: 1, display: 'flex', gap: 1 }}>
          <TextField
            size="small"
            select
            value={filter}
            onChange={(e) => setFilter(e.target.value as typeof filter)}
            sx={{ flex: 1 }}
          >
            <MenuItem value="all">全部 ({resources.length})</MenuItem>
            <MenuItem value="added">新增 ({resources.filter((r) => r.status === 'added').length})</MenuItem>
            <MenuItem value="removed">删除 ({resources.filter((r) => r.status === 'removed').length})</MenuItem>
            <MenuItem value="modified">修改 ({resources.filter((r) => r.status === 'modified').length})</MenuItem>
          </TextField>
          <TextField
            size="small"
            select
            value={kindFilter}
            onChange={(e) => setKindFilter(e.target.value as typeof kindFilter)}
            sx={{ flex: 1 }}
          >
            <MenuItem value="all">全部类型</MenuItem>
            <MenuItem value="text">文本</MenuItem>
            <MenuItem value="binary">二进制</MenuItem>
          </TextField>
        </Box>
        <Box sx={{ flex: 1, overflow: 'auto' }}>
          {filtered.length === 0 ? (
            <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
              无匹配文件
            </Typography>
          ) : (
            filtered.map((r) => (
              <Box
                key={r.path}
                onClick={() => setSelectedPath(r.path)}
                sx={{
                  p: 1,
                  cursor: 'pointer',
                  mb: 0.5,
                  borderRadius: 1,
                  bgcolor: selectedPath === r.path ? '#e3f2fd' : 'transparent',
                  '&:hover': { bgcolor: selectedPath === r.path ? '#bbdefb' : '#f1f5f9' }
                }}
              >
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <Chip
                    size="small"
                    label={r.status === 'added' ? '新增' : r.status === 'removed' ? '删除' : r.status === 'modified' ? '修改' : '不变'}
                    color={r.status === 'added' ? 'success' : r.status === 'removed' ? 'error' : r.status === 'modified' ? 'warning' : 'default'}
                    variant="outlined"
                  />
                  <Chip size="small" label={r.kind === 'binary' ? 'bin' : 'txt'} color="default" variant="outlined" />
                  <Box sx={{ flex: 1, fontFamily: 'monospace', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {r.path}
                  </Box>
                </Box>
              </Box>
            ))
          )}
        </Box>
      </Paper>

      <Paper sx={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }} variant="outlined">
        {selected ? (
          <>
            <Box sx={{ p: 1, display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
              <Chip
                size="small"
                label={selected.status === 'added' ? '新增' : selected.status === 'removed' ? '删除' : '修改'}
                color={selected.status === 'added' ? 'success' : selected.status === 'removed' ? 'error' : 'warning'}
              />
              <Typography variant="body2" fontFamily="monospace" sx={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {selected.path}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {formatSize(selected.originalSize)} → {formatSize(selected.modifiedSize)}
              </Typography>
            </Box>
            <Divider />
          </>
        ) : (
          <Box sx={{ p: 1 }}>
            <Typography variant="body2" color="text.secondary">选择左侧文件查看差异</Typography>
          </Box>
        )}
        <Box sx={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          {selected && selected.kind === 'binary' && renderBinaryInfo()}
          {selected && selected.kind !== 'binary' && renderDiff()}
        </Box>
      </Paper>
    </Box>
  );
}
