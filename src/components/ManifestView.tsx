import React, { useState } from 'react';
import {
  Accordion,
  AccordionSummary,
  AccordionDetails,
  Box,
  Chip,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Paper,
  Typography,
  Divider
} from '@mui/material';
import {
  ExpandMore as ExpandIcon,
  Android as AndroidIcon
} from '@mui/icons-material';
import type { ManifestDiffResult, ComponentDiffResult } from '../../shared/types';

interface Props {
  result: ManifestDiffResult;
}

function MetaTable({ rows }: { rows: ManifestDiffResult['meta'] }) {
  return (
    <TableContainer component={Paper} sx={{ mb: 2 }}>
      <Table size="small">
        <TableHead>
          <TableRow sx={{ bgcolor: '#f1f5f9' }}>
            <TableCell width={280}>字段</TableCell>
            <TableCell>原版</TableCell>
            <TableCell>修改版</TableCell>
            <TableCell width={70}>状态</TableCell>
            <TableCell width={80} align="right">原版行号</TableCell>
            <TableCell width={80} align="right">修改版行号</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.map((r) => {
            const color = r.status === 'added' ? 'success' : r.status === 'removed' ? 'error' : r.status === 'modified' ? 'warning' : 'default';
            const label = r.status === 'added' ? '新增' : r.status === 'removed' ? '删除' : r.status === 'modified' ? '修改' : '不变';
            return (
              <TableRow
                key={r.field}
                hover
                sx={{
                  '& td': { borderBottom: '1px solid #e2e8f0' },
                  bgcolor: r.status === 'modified' ? '#fff7ed' : undefined
                }}
              >
                <TableCell sx={{ fontFamily: 'monospace', fontSize: 12 }}>{r.field}</TableCell>
                <TableCell>{String(r.original ?? '—')}</TableCell>
                <TableCell>{String(r.modified ?? '—')}</TableCell>
                <TableCell>
                  <Chip size="small" label={label} color={color} variant="outlined" />
                </TableCell>
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
  );
}

function ComponentSection({ data }: { data: ComponentDiffResult }) {
  const [expanded, setExpanded] = useState(false);
  const total = data.added.length + data.removed.length + data.changed.length + data.unchangedCount;
  const hasChange = data.added.length + data.removed.length + data.changed.length > 0;

  return (
    <Accordion
      elevation={0}
      disableGutters
      expanded={expanded}
      onChange={() => setExpanded(!expanded)}
      sx={{ mb: 1, borderColor: '#e2e8f0', bgcolor: '#fff' }}
    >
      <AccordionSummary expandIcon={<ExpandIcon />}>
        <AndroidIcon sx={{ mr: 1 }} />
        <Typography fontWeight={600} sx={{ mr: 1 }}>
          {data.type}
        </Typography>
        <Chip size="small" label={`共 ${total}`} color="default" />
        {data.added.length > 0 && <Chip size="small" label={`+${data.added.length}`} color="success" />}
        {data.removed.length > 0 && <Chip size="small" label={`-${data.removed.length}`} color="error" />}
        {data.changed.length > 0 && <Chip size="small" label={`~${data.changed.length}`} color="warning" />}
        <Chip size="small" label={`= ${data.unchangedCount}`} color="default" variant="outlined" />
      </AccordionSummary>
      <AccordionDetails sx={{ pt: 0 }}>
        {!hasChange ? (
          <Typography variant="body2" color="text.secondary">
            全部 {data.unchangedCount} 个组件保持不变
          </Typography>
        ) : (
          <Box>
            {data.added.length > 0 && (
              <Box sx={{ mb: 2 }}>
                <Typography variant="subtitle2" color="success" sx={{ mb: 1 }}>新增</Typography>
                {data.added.map((e) => (
                  <Box key={`add-${e.name}`} sx={{ fontFamily: 'monospace', fontSize: 12, pl: 2, pr: 1, bgcolor: '#e6f4ea', py: 0.5, px: 1, borderRadius: 1, mb: 0.5, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <Box component="span" sx={{ wordBreak: 'break-all' }}>+ {e.name}</Box>
                    <Chip size="small" label={e.line ? `L${e.line}` : '—'} variant="outlined" sx={{ ml: 1, fontFamily: 'monospace' }} />
                  </Box>
                ))}
              </Box>
            )}
            {data.removed.length > 0 && (
              <Box sx={{ mb: 2 }}>
                <Typography variant="subtitle2" color="error" sx={{ mb: 1 }}>删除</Typography>
                {data.removed.map((e) => (
                  <Box key={`del-${e.name}`} sx={{ fontFamily: 'monospace', fontSize: 12, pl: 2, pr: 1, bgcolor: '#fdecea', py: 0.5, px: 1, borderRadius: 1, mb: 0.5, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <Box component="span" sx={{ wordBreak: 'break-all' }}>- {e.name}</Box>
                    <Chip size="small" label={e.line ? `L${e.line}` : '—'} variant="outlined" sx={{ ml: 1, fontFamily: 'monospace' }} />
                  </Box>
                ))}
              </Box>
            )}
            {data.changed.length > 0 && (
              <Box>
                <Typography variant="subtitle2" color="warning" sx={{ mb: 1 }}>修改</Typography>
                {data.changed.map((c) => (
                  <Box key={`chg-${c.name}`} sx={{ mb: 1 }}>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
                      <Typography variant="body2" sx={{ fontFamily: 'monospace', fontWeight: 600, wordBreak: 'break-all' }}>
                        ~ {c.name}
                      </Typography>
                      <Chip size="small" variant="outlined" label={`原 ${c.originalLine ? 'L'+c.originalLine : '—'} → 新 ${c.modifiedLine ? 'L'+c.modifiedLine : '—'}`} sx={{ fontFamily: 'monospace' }} />
                    </Box>
                    {c.changes.map((ch, i) => (
                      <Typography variant="body2" sx={{ pl: 2, fontSize: 12 }}>
                        <Chip size="small" label={ch.field} sx={{ mr: 1 }} />
                        <Box component="span" sx={{ color: '#c62828' }}>({ch.from})</Box>
                        <Box component="span" sx={{ mx: 1 }}>→</Box>
                        <Box component="span" sx={{ color: '#2e7d32' }}>({ch.to})</Box>
                      </Typography>
                    ))}
                  </Box>
                ))}
              </Box>
            )}
          </Box>
        )}
      </AccordionDetails>
    </Accordion>
  );
}

export default function ManifestView({ result }: Props) {
  return (
    <Box sx={{ p: 1 }}>
      <Typography variant="subtitle1" fontWeight={600} sx={{ mb: 1 }}>元信息</Typography>
      <MetaTable rows={result.meta} />
      <Divider sx={{ my: 2 }} />
      <Typography variant="subtitle1" fontWeight={600} sx={{ mb: 1 }}>组件</Typography>
      {result.components.map((c) => (
        <ComponentSection key={c.type} data={c} />
      ))}
    </Box>
  );
}
