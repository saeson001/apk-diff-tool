import React from 'react';
import { Box } from '@mui/material';

type DiffLineKind = 'add' | 'del' | 'ctx' | 'hunk' | 'header';

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

const LINE_BG: Record<DiffLineKind, string> = {
  add: '#e8f5ec',
  del: '#fbe9e7',
  ctx: 'transparent',
  hunk: '#e3f2fd',
  header: '#f5f5f5'
};

const LINE_FG: Record<DiffLineKind, string> = {
  add: '#1b5e20',
  del: '#b71c1c',
  ctx: '#374151',
  hunk: '#1565c0',
  header: '#9ca3af'
};

function LineNum({ n }: { n: number | null }) {
  if (n == null) return <Box component="span" sx={{ width: 44, textAlign: 'right', color: 'transparent', userSelect: 'none', flexShrink: 0 }}>&nbsp;</Box>;
  return <Box component="span" sx={{ width: 44, textAlign: 'right', color: '#94a3b8', userSelect: 'none', flexShrink: 0 }}>{n}</Box>;
}

interface Props {
  diffText: string;
  maxHeight?: number | string;
}

/** unified diff 文本渲染器（行号 + 增删行着色），SmaliDiffView 与 hash 单文件对比共用 */
export default function DiffTextView({ diffText, maxHeight = '100%' }: Props) {
  const lines = React.useMemo(() => parseDiffWithLineNumbers(diffText), [diffText]);
  return (
    <Box sx={{ overflow: 'auto', maxHeight, fontFamily: 'Consolas, "Courier New", monospace', fontSize: 12, lineHeight: '18px', backgroundColor: '#fff' }}>
      {lines.map((l, i) => (
        <Box
          key={i}
          sx={{ display: 'flex', whiteSpace: 'pre-wrap', wordBreak: 'break-all', backgroundColor: LINE_BG[l.kind], color: LINE_FG[l.kind], px: 1 }}
        >
          <LineNum n={l.origLine} />
          <LineNum n={l.modLine} />
          <Box component="span" sx={{ flex: 1 }}>{l.text || ' '}</Box>
        </Box>
      ))}
    </Box>
  );
}
