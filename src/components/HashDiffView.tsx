import React, { useState, useMemo, useEffect } from 'react';
import {
  Box, Typography, Table, TableBody, TableCell, TableContainer,
  TableHead, TableRow, Paper, Chip, IconButton,
  Accordion, AccordionSummary, AccordionDetails, Divider, Alert, Badge, Button
} from '@mui/material';
import {
  ExpandMore as ExpandMoreIcon, Add as AddIcon, Remove as RemoveIcon,
  ChangeHistory as ChangeIcon, CheckCircle as CheckIcon,
  SmartToy as AIIcon, Build as BuildIcon, Visibility as ViewIcon
} from '@mui/icons-material';
import HashFileDiffDialog from './HashFileDiffDialog';
import type { HashDiffReport, HashDiffEntry, HashFileCategory } from '../../shared/types';

export interface FocusedFilePayload {
  path: string;
  diffText: string;
  note: string;
}

interface Props {
  report: HashDiffReport;
  onStartFullDiff: () => void;
  /** 从某文件发起 AI 提问 */
  onAskAI: (path: string) => void;
  /** 当前查看的文件差异变化（供 AI 对话注入上下文） */
  onFocusedFileChange: (payload: FocusedFilePayload | null) => void;
  /** 外部（AI 对话操作）请求打开某文件的内容差异 */
  openPathRequest?: string | null;
  onOpenPathRequestDone?: () => void;
}

function formatSize(bytes?: number): string {
  if (bytes === undefined) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

const STATUS_CONFIG: Record<HashDiffEntry['status'], { label: string; color: string; icon: React.ReactNode }> = {
  modified: { label: '修改', color: 'warning', icon: <ChangeIcon fontSize="small" /> },
  added: { label: '新增', color: 'success', icon: <AddIcon fontSize="small" /> },
  removed: { label: '删除', color: 'error', icon: <RemoveIcon fontSize="small" /> },
  unchanged: { label: '未变', color: 'default', icon: <CheckIcon fontSize="small" /> }
};

const CATEGORY_LABELS: Record<HashFileCategory, string> = {
  dex: 'DEX (代码)',
  xml: 'XML',
  image: '图片',
  resource: '资源',
  asset: '资源文件',
  native: '原生库',
  other: '其他'
};

export default function HashDiffView({ report, onStartFullDiff, onAskAI, onFocusedFileChange, openPathRequest, onOpenPathRequestDone }: Props) {
  const [viewingEntry, setViewingEntry] = useState<HashDiffEntry | null>(null);
  const [showUnchanged, setShowUnchanged] = useState(false);

  // AI 对话操作请求打开某文件
  useEffect(() => {
    if (!openPathRequest) return;
    const entry = report.entries.find(e => e.path === openPathRequest && e.status !== 'unchanged');
    if (entry) setViewingEntry(entry);
    onOpenPathRequestDone?.();
  }, [openPathRequest, report.entries, onOpenPathRequestDone]);

  // Group entries by category
  const grouped = useMemo(() => {
    const map = new Map<HashFileCategory, HashDiffEntry[]>();
    for (const entry of report.entries) {
      if (!map.has(entry.category)) map.set(entry.category, []);
      map.get(entry.category)!.push(entry);
    }
    return map;
  }, [report.entries]);

  // Filter entries
  const filteredEntries = useMemo(() => {
    if (showUnchanged) return report.entries;
    return report.entries.filter(e => e.status !== 'unchanged');
  }, [report.entries, showUnchanged]);

  return (
    <Box sx={{ height: '100%', overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 1 }}>
      {/* Summary */}
      <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center', py: 1 }}>
        <Chip label={`新增 ${report.summary.added}`} color="success" icon={<AddIcon />} size="small" />
        <Chip label={`删除 ${report.summary.removed}`} color="error" icon={<RemoveIcon />} size="small" />
        <Chip label={`修改 ${report.summary.modified}`} color="warning" icon={<ChangeIcon />} size="small" />
        <Chip label={`未变 ${report.summary.unchanged}`} size="small" />
        <Typography variant="body2" color="text.secondary" sx={{ ml: 'auto' }}>
          耗时 {report.elapsedMs}ms
        </Typography>
      </Box>

      {/* AI Recommendation with next-step actions */}
      {report.aiRecommendation && (
        <Alert
          severity="info"
          icon={<AIIcon />}
          sx={{ py: 0.5 }}
          action={
            <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', ml: 1 }}>
              <Typography variant="body2" color="text.secondary" sx={{ whiteSpace: 'nowrap' }}>
                置信度 {(report.aiRecommendation.confidence * 100).toFixed(0)}%
              </Typography>
              {report.aiRecommendation.approach === 'hash_only' && (
                <Button size="small" variant="outlined" startIcon={<BuildIcon />} onClick={onStartFullDiff}>
                  完整反编译对比
                </Button>
              )}
              <Button size="small" variant="contained" startIcon={<AIIcon />} onClick={() => onAskAI('')}>
                AI 分析
              </Button>
            </Box>
          }
        >
          <strong>AI 推荐方案:</strong> {report.aiRecommendation.approach === 'hash_only' ? '快速哈希比对' : '完整 apktool 反编译'}
          {' — '}
          {report.aiRecommendation.reasoning}
        </Alert>
      )}

      {/* File info */}
      <Box sx={{ display: 'flex', gap: 2, py: 0.5 }}>
        <Typography variant="body2" color="text.secondary">
          原版: {report.original.name} ({formatSize(report.original.size)})
        </Typography>
        <Typography variant="body2" color="text.secondary">
          修改版: {report.modified.name} ({formatSize(report.modified.size)})
        </Typography>
      </Box>

      <Divider />

      {/* Toggle unchanged */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Chip
          label={showUnchanged ? '显示全部文件' : '隐藏未变更'}
          size="small"
          onClick={() => setShowUnchanged(!showUnchanged)}
          icon={<ExpandMoreIcon />}
        />
        <Typography variant="caption" color="text.secondary">
          点击变更文件行可查看内容差异
        </Typography>
      </Box>

      {/* Grouped by category */}
      {[...grouped.entries()].map(([category, entries]) => {
        const changes = entries.filter(e => e.status !== 'unchanged');
        if (changes.length === 0 && !showUnchanged) return null;
        const visibleEntries = showUnchanged ? entries : changes;
        return (
          <Accordion key={category} disableGutters sx={{ mb: 0.5, background: '#fafafa' }}>
            <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ minHeight: 36 }}>
              <Typography variant="subtitle2" sx={{ fontWeight: 600, mr: 1 }}>
                {CATEGORY_LABELS[category]}
              </Typography>
              <Badge badgeContent={changes.length} color={changes.length > 0 ? 'error' : 'default'} sx={{ mr: 1 }}>
                <Box sx={{ width: 1, height: 1 }} />
              </Badge>
              <Typography variant="body2" color="text.secondary">
                {entries.length} 个文件
              </Typography>
            </AccordionSummary>
            <AccordionDetails sx={{ p: 0 }}>
              <TableContainer component={Paper} sx={{ borderRadius: 0, boxShadow: 'none' }}>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell sx={{ width: 60 }}>状态</TableCell>
                      <TableCell>路径</TableCell>
                      <TableCell align="right" sx={{ width: 80 }}>原版大小</TableCell>
                      <TableCell align="right" sx={{ width: 80 }}>修改版大小</TableCell>
                      <TableCell align="center" sx={{ width: 60 }}>内容</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {visibleEntries.slice(0, 200).map((entry) => {
                      const cfg = STATUS_CONFIG[entry.status];
                      const canView = entry.status !== 'unchanged';
                      return (
                        <TableRow
                          key={entry.path}
                          hover={canView}
                          sx={{ cursor: canView ? 'pointer' : 'default' }}
                          onClick={() => canView && setViewingEntry(entry)}
                        >
                          <TableCell>
                            <Chip label={cfg.label} color={cfg.color as never} size="small" icon={cfg.icon} />
                          </TableCell>
                          <TableCell sx={{ fontFamily: 'monospace', fontSize: 12 }}>
                            {entry.path}
                          </TableCell>
                          <TableCell align="right">{formatSize(entry.originalSize)}</TableCell>
                          <TableCell align="right">{formatSize(entry.modifiedSize)}</TableCell>
                          <TableCell align="center">
                            {canView && (
                              <IconButton
                                size="small"
                                onClick={(e) => { e.stopPropagation(); setViewingEntry(entry); }}
                                aria-label="查看内容差异"
                              >
                                <ViewIcon fontSize="small" />
                              </IconButton>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                    {visibleEntries.length > 200 && (
                      <TableRow>
                        <TableCell colSpan={5} align="center">
                          <Typography variant="body2" color="text.secondary">
                            仅显示前 200 个（共 {visibleEntries.length} 个）
                          </Typography>
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </TableContainer>
            </AccordionDetails>
          </Accordion>
        );
      })}

      <HashFileDiffDialog
        open={viewingEntry !== null}
        entry={viewingEntry}
        reportId={report.sessionId}
        onClose={() => setViewingEntry(null)}
        onAskAI={(p) => { setViewingEntry(null); onAskAI(p); }}
        onStartFullDiff={() => { setViewingEntry(null); onStartFullDiff(); }}
        onContextChange={onFocusedFileChange}
      />
    </Box>
  );
}
