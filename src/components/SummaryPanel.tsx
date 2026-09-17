import React from 'react';
import {
  Box,
  Card,
  CardContent,
  Typography,
  Grid,
  Chip
} from '@mui/material';
import {
  Android as AndroidIcon,
  Description as DescriptionIcon,
  CompareArrows as CompareIcon,
  Folder as FolderIcon
} from '@mui/icons-material';
import type { DiffReport } from '../../shared/types';

type TabKey = 'permissions' | 'manifest' | 'smali' | 'resources';

interface Props {
  report: DiffReport;
  onTabClick: (tab: TabKey) => void;
}

interface StatCardProps {
  title: string;
  icon: React.ReactNode;
  added: number;
  removed: number;
  modified: number;
  total: number;
  onClick: () => void;
}

function StatCard({ title, icon, added, removed, modified, total, onClick }: StatCardProps) {
  const color = added > 0 ? 'success' : removed > 0 ? 'error' : modified > 0 ? 'warning' : 'default';
  return (
    <Card
      sx={{
        cursor: 'pointer',
        '&:hover': { boxShadow: 3, borderColor: '#1976d2' }
      }}
      onClick={onClick}
      variant="outlined"
    >
      <CardContent sx={{ p: 2 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
          <Chip icon={icon} label={title} color="primary" size="small" />
        </Box>
        <Box sx={{ display: 'flex', gap: 2, fontSize: 14, mt: 1 }}>
          <Box>
            <Typography variant="caption" color="text.secondary">新增</Typography>
            <Typography variant="h6" color="success">{added}</Typography>
          </Box>
          <Box>
            <Typography variant="caption" color="text.secondary">删除</Typography>
            <Typography variant="h6" color="error">{removed}</Typography>
          </Box>
          <Box>
            <Typography variant="caption" color="text.secondary">修改</Typography>
            <Typography variant="h6" color="warning">{modified}</Typography>
          </Box>
          <Box>
            <Typography variant="caption" color="text.secondary">合计</Typography>
            <Typography variant="h6">{total}</Typography>
          </Box>
        </Box>
      </CardContent>
    </Card>
  );
}

export default function SummaryPanel({ report, onTabClick }: Props) {
  const s = report.summary;
  const smaliChanged = report.classes.filter((c) => c.status !== 'unchanged');
  const resChanged = report.resources.filter((r) => r.status !== 'unchanged');

  return (
    <Box sx={{ px: 2, pt: 2 }}>
      <Grid container spacing={2}>
        <Grid item xs={6} md={3}>
          <StatCard
            title="权限"
            icon={<AndroidIcon />}
            added={s.permissionsAdded}
            removed={s.permissionsRemoved}
            modified={s.permissionsModified}
            total={s.totalPermissions}
            onClick={() => onTabClick('permissions')}
          />
        </Grid>
        <Grid item xs={6} md={3}>
          <StatCard
            title="Manifest"
            icon={<DescriptionIcon />}
            added={report.manifest.meta.filter((m) => m.status === 'added').length}
            removed={report.manifest.meta.filter((m) => m.status === 'removed').length}
            modified={report.manifest.meta.filter((m) => m.status === 'modified').length}
            total={report.manifest.meta.length}
            onClick={() => onTabClick('manifest')}
          />
        </Grid>
        <Grid item xs={6} md={3}>
          <StatCard
            title="smali"
            icon={<CompareIcon />}
            added={s.addedClasses}
            removed={s.removedClasses}
            modified={s.modifiedClasses}
            total={report.classes.length}
            onClick={() => onTabClick('smali')}
          />
        </Grid>
        <Grid item xs={6} md={3}>
          <StatCard
            title="资源"
            icon={<FolderIcon />}
            added={s.addedFiles}
            removed={s.removedFiles}
            modified={s.modifiedFiles}
            total={report.resources.length}
            onClick={() => onTabClick('resources')}
          />
        </Grid>
      </Grid>

      {report.usedFallbackExtractor && (
        <Typography variant="caption" color="warning" sx={{ display: 'block', mt: 1, px: 1 }}>
          ⚠️ zip 降级模式：{report.fallbackReason || 'apktool/Java 不可用'} — smali 对比不可用，XML 文件（含 AndroidManifest.xml）无法显示 diff 内容
        </Typography>
      )}
    </Box>
  );
}
