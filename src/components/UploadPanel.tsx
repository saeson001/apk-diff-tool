import React, { useState, useRef, useCallback } from 'react';
import {
  Box,
  Button,
  Card,
  CardContent,
  Typography,
  LinearProgress,
  IconButton,
  Chip,
  Alert
} from '@mui/material';
import {
  UploadFile as UploadFileIcon,
  OpenInNew as OpenInNewIcon,
  Delete as DeleteIcon,
  PlayArrow as PlayIcon,
  FolderOpen as FolderIcon
} from '@mui/icons-material';

interface Props {
  onStart: (original: string, modified: string) => void;
  disabled: boolean;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

interface Slot {
  path: string;
  name: string;
  size: number;
}

export default function UploadPanel({ onStart, disabled }: Props) {
  const [original, setOriginal] = useState<Slot | null>(null);
  const [modified, setModified] = useState<Slot | null>(null);
  const [dragOver, setDragOver] = useState<'original' | 'modified' | null>(null);
  const originalInputRef = useRef<HTMLInputElement>(null);
  const modifiedInputRef = useRef<HTMLInputElement>(null);

  const handleFilePick = useCallback(
    (kind: 'original' | 'modified') => async () => {
      if (!window.apkDiff) return;
      try {
        const p = await window.apkDiff.openApkPicker();
        if (!p) return;
        const slot: Slot = {
          path: p,
          name: p.split(/[\\/]/).pop() || p,
          size: 0
        };
        if (kind === 'original') setOriginal(slot);
        else setModified(slot);
      } catch (err) {
        console.warn('openApkPicker failed', err);
      }
    },
    []
  );

  const handleDrop = useCallback(
    (kind: 'original' | 'modified') => (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(null);
      const file = e.dataTransfer.files?.[0];
      if (!file) return;
      // Electron 无法从 dropped file 拿到绝对路径；转成路径需通过 webUtils.getPathForFile
      // 这里简单处理：从 file.name 提示用户
      const slot: Slot = {
        path: (file as unknown as { path?: string }).path || (file as unknown as { webkitRelativePath?: string }).webkitRelativePath || file.name,
        name: file.name,
        size: file.size
      };
      if (kind === 'original') setOriginal(slot);
      else setModified(slot);
    },
    []
  );

  const handleStart = () => {
    if (!original || !modified) return;
    onStart(original.path, modified.path);
  };

  const renderSlot = (kind: 'original' | 'modified', slot: Slot | null) => {
    const label = kind === 'original' ? '原版 APK' : '修改版 APK';
    const isOver = dragOver === kind;
    return (
      <Card
        className={`drop-zone ${isOver ? 'drag-over' : ''}`}
        sx={{ flex: 1, borderColor: slot ? '#2e7d32' : undefined }}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(kind);
        }}
        onDragLeave={() => setDragOver(null)}
        onDrop={handleDrop(kind)}
      >
        <CardContent>
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <FolderIcon color={slot ? 'success' : 'disabled'} />
              <Typography variant="subtitle1" fontWeight={600}>{label}</Typography>
            </Box>
            {slot && (
              <Chip label="已选择" size="small" color="success" icon={<OpenInNewIcon />} />
            )}
          </Box>

          {slot ? (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 1 }}>
              <Box sx={{ flex: 1, overflow: 'hidden' }}>
                <Typography variant="body2" noWrap>{slot.name}</Typography>
                <Typography variant="caption" color="text.secondary" noWrap>
                  {slot.path}{slot.size ? ` · ${formatSize(slot.size)}` : ''}
                </Typography>
              </Box>
              <IconButton size="small" onClick={() => (kind === 'original' ? setOriginal(null) : setModified(null))} disabled={disabled}>
                <DeleteIcon fontSize="small" />
              </IconButton>
            </Box>
          ) : (
            <Typography variant="body2" color="text.secondary" sx={{ py: 1 }}>
              拖拽 APK 到此处，或点击下方按钮选择
            </Typography>
          )}

          <Box sx={{ display: 'flex', gap: 1, mt: 1 }}>
            <Button
              variant="outlined"
              size="small"
              startIcon={<UploadFileIcon />}
              disabled={disabled}
              onClick={handleFilePick(kind)}
            >
              选择文件
            </Button>
          </Box>
        </CardContent>
      </Card>
    );
  };

  return (
    <Box sx={{ p: 2 }}>
      <Box sx={{ display: 'flex', gap: 2, mb: 2 }}>
        {renderSlot('original', original)}
        {renderSlot('modified', modified)}
      </Box>
      <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 2 }}>
        <Button
          variant="contained"
          color="primary"
          disabled={disabled || !original || !modified}
          onClick={handleStart}
          startIcon={<PlayIcon />}
          size="large"
        >
          {disabled ? '对比中…' : '开始对比'}
        </Button>
      </Box>
    </Box>
  );
}
