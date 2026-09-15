import React, { useEffect, useMemo, useState } from 'react';
import {
  Box,
  Paper,
  Typography,
  Chip,
  CircularProgress,
  Divider,
  TextField,
  MenuItem
} from '@mui/material';
import type { ClassDiffEntry } from '../../shared/types';

type DiffLineKind = 'add' | 'del' | 'ctx' | 'hunk' | 'header';

interface ParsedLine {
  kind: DiffLineKind;
  text: string;
  /** 原版行号（仅 del / ctx 有效） */
  origLine: number | null;
  /** 修改版行号（仅 add / ctx 有效） */
  modLine: number | null;
}

function parseDiffWithLineNumbers(diffText: string): ParsedLine[] {
  const out: ParsedLine[] = [];
  let origLine = 1;
  let modLine = 1;
  for (const raw of diffText.split('\n')) {
    if (raw.startsWith('@@')) {
      // @@ -L1,N1 +L2,N2 @@
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

interface Props {
  classes: ClassDiffEntry[];
  reportId: string;
}

export default function SmaliDiffView({ classes, reportId }: Props) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [diffText, setDiffText] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<'all' | 'added' | 'removed' | 'modified'>('modified');

  const filtered = useMemo(() => {
    if (filter === 'all') return classes;
    return classes.filter((c) => c.status === filter);
  }, [classes, filter]);

  const changes = useMemo(
    () => classes.filter((c) => c.status !== 'unchanged'),
    [classes]
  );

  // 首次进入自动选中第一个有变更的类
  useEffect(() => {
    if (!selectedPath && changes.length > 0) {
      setSelectedPath(changes[0].path);
    }
  }, [changes, selectedPath]);

  // 拉取 diff
  useEffect(() => {
    if (!selectedPath || !window.apkDiff) return;
    setLoading(true);
    window.apkDiff
      .getClassDiff(reportId, selectedPath)
      .then(setDiffText)
      .catch((err) => setDiffText(`加载失败: ${err}`))
      .finally(() => setLoading(false));
  }, [selectedPath, reportId]);

  const selected = useMemo(
    () => classes.find((c) => c.path === selectedPath) || null,
    [classes, selectedPath]
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
      <Box sx={{ overflow: 'auto', maxHeight: 'calc(100vh - 360px)' }}>
        {parseDiffWithLineNumbers(diffText).map((p, i) => (
          <Box
            key={i}
            className={`diff-line ${p.kind}`}
            sx={{ display: 'flex', fontFamily: 'monospace', fontSize: 13, lineHeight: 1.5 }}
          >
            <LineNum n={p.origLine} />
            <LineNum n={p.modLine} />
            <Box sx={{ flex: 1, whiteSpace: 'pre-wrap', wordBreak: 'break-all', pl: 1 }}>
              {p.text || '\u00a0'}
            </Box>
          </Box>
        ))}
      </Box>
    );
  };

  return (
    <Box sx={{ display: 'flex', height: '100%', gap: 1, p: 1 }}>
      <Paper sx={{ width: 380, p: 1, display: 'flex', flexDirection: 'column' }} variant="outlined">
        <Box sx={{ mb: 1 }}>
          <TextField
            size="small"
            fullWidth
            select
            value={filter}
            onChange={(e) => setFilter(e.target.value as typeof filter)}
          >
            <MenuItem value="all">全部 ({classes.length})</MenuItem>
            <MenuItem value="added">新增 ({classes.filter((c) => c.status === 'added').length})</MenuItem>
            <MenuItem value="removed">删除 ({classes.filter((c) => c.status === 'removed').length})</MenuItem>
            <MenuItem value="modified">修改 ({classes.filter((c) => c.status === 'modified').length})</MenuItem>
          </TextField>
        </Box>
        <Box sx={{ flex: 1, overflow: 'auto' }}>
          {filtered.length === 0 ? (
            <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
              无匹配类
            </Typography>
          ) : (
            filtered.map((c) => (
              <Box
                key={c.path}
                onClick={() => setSelectedPath(c.path)}
                sx={{
                  p: 1,
                  cursor: 'pointer',
                  mb: 0.5,
                  borderRadius: 1,
                  bgcolor: selectedPath === c.path ? '#e3f2fd' : 'transparent',
                  '&:hover': { bgcolor: selectedPath === c.path ? '#bbdefb' : '#f1f5f9' }
                }}
              >
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <Chip
                    size="small"
                    label={c.status === 'added' ? '新增' : c.status === 'removed' ? '删除' : c.status === 'modified' ? '修改' : '不变'}
                    color={c.status === 'added' ? 'success' : c.status === 'removed' ? 'error' : c.status === 'modified' ? 'warning' : 'default'}
                    variant="outlined"
                  />
                  <Box sx={{ flex: 1, fontFamily: 'monospace', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {c.className}
                  </Box>
                </Box>
                {(c.additions || c.deletions) && (
                  <Typography variant="caption" color="text.secondary" sx={{ pl: 2, fontSize: 11 }}>
                    +{c.additions || 0} / -{c.deletions || 0}
                  </Typography>
                )}
              </Box>
            ))
          )}
        </Box>
      </Paper>

      <Paper sx={{ flex: 1, display: 'flex', flexDirection: 'column' }} variant="outlined">
        {selected ? (
          <>
            <Box sx={{ p: 1, display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
              <Chip
                size="small"
                label={selected.status === 'added' ? '新增' : selected.status === 'removed' ? '删除' : '修改'}
                color={selected.status === 'added' ? 'success' : selected.status === 'removed' ? 'error' : 'warning'}
              />
              <Typography variant="body2" fontFamily="monospace" sx={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {selected.className}
              </Typography>
              <Chip size="small" variant="outlined" label={`+${selected.additions || 0}`} color="success" />
              <Chip size="small" variant="outlined" label={`-${selected.deletions || 0}`} color="error" />
            </Box>
            <Divider />
          </>
        ) : (
          <Box sx={{ p: 1 }}>
            <Typography variant="body2" color="text.secondary">选择左侧类查看 diff</Typography>
          </Box>
        )}
        <Box sx={{ flex: 1, overflow: 'hidden' }}>
          {selected && renderDiff()}
        </Box>
      </Paper>
    </Box>
  );
}
