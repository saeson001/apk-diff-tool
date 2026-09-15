import React, { useMemo, useState } from 'react';
import {
  Box,
  TextField,
  Chip,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Paper,
  ToggleButtonGroup,
  ToggleButton,
  Typography
} from '@mui/material';
import type { PermissionRow } from '../../shared/types';

type Filter = 'all' | 'added' | 'removed' | 'modified';

interface Props {
  rows: PermissionRow[];
}

function renderMaxSdk(v: number | string | null | undefined): React.ReactNode {
  if (v === null || v === undefined) {
    return <span style={{ color: '#cbd5e1' }}>N/A</span>;
  }
  return String(v);
}

export default function PermissionsView({ rows }: Props) {
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    let out = rows;
    if (filter === 'added') out = out.filter((r) => r.status === 'added');
    else if (filter === 'removed') out = out.filter((r) => r.status === 'removed');
    else if (filter === 'modified') out = out.filter((r) => r.status === 'kept' && r.originalMaxSdk !== r.modifiedMaxSdk);
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      out = out.filter((r) => r.permission.toLowerCase().includes(q));
    }
    return out;
  }, [rows, filter, query]);

  const changedCount = rows.filter((r) => r.status !== 'kept' || r.originalMaxSdk !== r.modifiedMaxSdk).length;

  return (
    <Box sx={{ p: 1 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 2 }}>
        <ToggleButtonGroup
          size="small"
          exclusive
          value={filter}
          onChange={(_e, v) => v && setFilter(v)}
        >
          <ToggleButton value="all">全部 ({rows.length})</ToggleButton>
          <ToggleButton value="added" color="success">
            新增 ({rows.filter((r) => r.status === 'added').length})
          </ToggleButton>
          <ToggleButton value="removed" color="error">
            删除 ({rows.filter((r) => r.status === 'removed').length})
          </ToggleButton>
          <ToggleButton value="modified" color="warning">
            修改 ({rows.filter((r) => r.status === 'kept' && r.originalMaxSdk !== r.modifiedMaxSdk).length})
          </ToggleButton>
        </ToggleButtonGroup>
        <TextField
          size="small"
          placeholder="搜索权限…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          sx={{ ml: 'auto', width: 260 }}
        />
      </Box>

      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
        共 {rows.length} 条权限，其中 {changedCount} 条发生变化
      </Typography>

      {filtered.length === 0 ? (
        <Box sx={{ textAlign: 'center', py: 6, color: '#94a3b8' }}>
          <Typography variant="body1">无匹配的权限</Typography>
        </Box>
      ) : (
        <TableContainer component={Paper} sx={{ maxHeight: 'calc(100vh - 340px)', overflow: 'auto' }}>
          <Table size="small" stickyHeader>
            <TableHead>
              <TableRow sx={{ bgcolor: '#f1f5f9' }}>
                <TableCell width={80}>状态</TableCell>
                <TableCell>权限名称</TableCell>
                <TableCell width={120}>原版 maxSdk</TableCell>
                <TableCell width={120}>修改版 maxSdk</TableCell>
                <TableCell width={80} align="right">原版行号</TableCell>
                <TableCell width={80} align="right">修改版行号</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {filtered.map((r) => {
                const isModified = r.status === 'kept' && r.originalMaxSdk !== r.modifiedMaxSdk;
                return (
                  <TableRow key={r.permission} hover sx={{ '& td': { borderBottom: '1px solid #e2e8f0' } }}>
                    <TableCell>
                      <Chip
                        size="small"
                        label={r.status === 'added' ? '新增' : r.status === 'removed' ? '删除' : isModified ? '修改' : '保留'}
                        color={r.status === 'added' ? 'success' : r.status === 'removed' ? 'error' : isModified ? 'warning' : 'default'}
                        variant={r.status === 'kept' && !isModified ? 'outlined' : 'filled'}
                      />
                    </TableCell>
                    <TableCell sx={{ fontFamily: 'monospace' }}>{r.permission}</TableCell>
                    <TableCell>{renderMaxSdk(r.originalMaxSdk)}</TableCell>
                    <TableCell>{renderMaxSdk(r.modifiedMaxSdk)}</TableCell>
                    <TableCell align="right" sx={{ color: '#64748b', fontFamily: 'monospace', fontSize: 12 }}>
                      {r.originalLine ? `L${r.originalLine}` : <span style={{ color: '#cbd5e1' }}>—</span>}
                    </TableCell>
                    <TableCell align="right" sx={{ color: '#64748b', fontFamily: 'monospace', fontSize: 12 }}>
                      {r.modifiedLine ? `L${r.modifiedLine}` : <span style={{ color: '#cbd5e1' }}>—</span>}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
      )}
    </Box>
  );
}
