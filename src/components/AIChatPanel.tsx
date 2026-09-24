import React, { useEffect, useRef, useState } from 'react';
import {
  Drawer, Box, Typography, TextField, IconButton, Button, Chip,
  CircularProgress, Alert, Divider, Tooltip
} from '@mui/material';
import { Send as SendIcon, Close as CloseIcon, DeleteOutline as ClearIcon } from '@mui/icons-material';
import type { ChatMessage } from '../../shared/types';

interface FocusedFile {
  path: string;
  diffText: string;
  note: string;
}

export interface ChatAction {
  type: 'view_file' | 'full_diff';
  path?: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** 当前对比上下文（主进程会注入系统提示词） */
  context: string;
  aiConfigured: boolean;
  onOpenAISettings: () => void;
  /** 正在查看的单文件差异（AI 回答可引用） */
  focusedFile: FocusedFile | null;
  /** 预填输入框（例如从文件对话框"询问 AI"进入） */
  prefill: string | null;
  onPrefillConsumed: () => void;
  /** AI 返回的操作请求 */
  onAction: (action: ChatAction) => void;
}

interface UiMessage extends ChatMessage {
  actions: ChatAction[];
  error?: string;
  elapsedMs?: number;
}

const QUICK_PROMPTS = [
  '总结这次 APK 对比的主要变化',
  '哪些改动最值得警惕（隐私 / 安全 / 广告）？',
  '列出所有新增的权限或组件',
  '我该继续做什么来深入分析？'
];

/** 从 AI 回复中提取 ACTION 行并从正文剥离 */
function parseActions(content: string): { text: string; actions: ChatAction[] } {
  const actions: ChatAction[] = [];
  const lines = content.split('\n').filter(line => {
    const m = line.match(/^\s*ACTION:\s*(\w+)(?::(.*))?$/);
    if (!m) return true;
    if (m[1] === 'view_file' && m[2]) actions.push({ type: 'view_file', path: m[2].trim() });
    else if (m[1] === 'full_diff') actions.push({ type: 'full_diff' });
    return false;
  });
  return { text: lines.join('\n').trim(), actions };
}

export default function AIChatPanel({ open, onClose, context, aiConfigured, onOpenAISettings, focusedFile, prefill, onPrefillConsumed, onAction }: Props) {
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  // 报告/文件切换时清空会话由父组件通过 key 控制；这里仅滚动到底部
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages, sending]);

  useEffect(() => {
    if (open && prefill) {
      setInput(prefill);
      onPrefillConsumed();
    }
  }, [open, prefill, onPrefillConsumed]);

  const send = async () => {
    const text = input.trim();
    if (!text || sending) return;

    const userMsg: UiMessage = { role: 'user', content: text, actions: [] };
    const next = [...messages, userMsg];
    setMessages(next);
    setInput('');
    setSending(true);
    try {
      // 附带当前聚焦文件差异，让 AI 能就"这个文件改了什么"直接回答
      let ctx = context;
      if (focusedFile) {
        const fileCtx = focusedFile.diffText
          ? `用户当前正在查看文件: ${focusedFile.path}\n${focusedFile.note}\n该文件的内容差异（unified diff，可能截断）:\n${focusedFile.diffText.slice(0, 6000)}`
          : `用户当前正在查看文件: ${focusedFile.path}（${focusedFile.note || '无内容差异可用'}）`;
        ctx = ctx ? ctx + '\n\n' + fileCtx : fileCtx;
      }
      const res = await window.apkDiff.sendAIChat(
        next.filter(m => !m.error).map(m => ({ role: m.role, content: m.content })),
        ctx
      );
      const parsed = parseActions(res.content);
      setMessages(prev => [...prev, { role: 'assistant', content: parsed.text, actions: parsed.actions, elapsedMs: res.elapsedMs }]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setMessages(prev => [...prev, { role: 'assistant', content: '', actions: [], error: msg }]);
    } finally {
      setSending(false);
    }
  };

  const renderActions = (actions: ChatAction[]) => (
    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mt: 1 }}>
      {actions.map((a, i) => a.type === 'view_file' ? (
        <Chip
          key={i}
          size="small"
          color="primary"
          variant="outlined"
          label={`查看 ${a.path?.split('/').pop()} 的差异`}
          onClick={() => onAction(a)}
          sx={{ fontFamily: 'monospace' }}
        />
      ) : (
        <Chip
          key={i}
          size="small"
          color="secondary"
          variant="outlined"
          label="开始完整反编译对比"
          onClick={() => onAction(a)}
        />
      ))}
    </Box>
  );

  return (
    <Drawer
      anchor="right"
      open={open}
      onClose={onClose}
      PaperProps={{ sx: { width: 440, display: 'flex', flexDirection: 'column' } }}
    >
      <Box sx={{ px: 2, py: 1.5, display: 'flex', alignItems: 'center', gap: 1, borderBottom: '1px solid #e2e8f0' }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 600, flex: 1 }}>AI 对话</Typography>
        <Tooltip title="清空会话">
          <span>
            <IconButton size="small" disabled={messages.length === 0 || sending} onClick={() => setMessages([])}>
              <ClearIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
        <IconButton size="small" onClick={onClose}>
          <CloseIcon fontSize="small" />
        </IconButton>
      </Box>

      {!aiConfigured && (
        <Alert
          severity="warning"
          sx={{ m: 2, mb: 0 }}
          action={
            <Button size="small" onClick={onOpenAISettings}>去配置</Button>
          }
        >
          AI API 未配置，请先填写 OpenAI 兼容的 Base URL、API Key 和模型名。
        </Alert>
      )}

      <Box ref={listRef} sx={{ flex: 1, overflow: 'auto', px: 2, py: 2, display: 'flex', flexDirection: 'column', gap: 1.5, backgroundColor: '#f8fafc' }}>
        {messages.length === 0 && (
          <Box>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
              针对当前对比结果提问，例如：
            </Typography>
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, alignItems: 'flex-start' }}>
              {QUICK_PROMPTS.map(q => (
                <Chip key={q} size="small" label={q} onClick={() => setInput(q)} sx={{ maxWidth: '100%' }} />
              ))}
            </Box>
          </Box>
        )}
        {messages.map((m, i) => (
          <Box key={i} sx={{ alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start', maxWidth: '88%' }}>
            <Box sx={{
              px: 1.5, py: 1, borderRadius: 2,
              backgroundColor: m.error ? '#fdecea' : m.role === 'user' ? '#1976d2' : '#ffffff',
              color: m.error ? '#b71c1c' : m.role === 'user' ? '#ffffff' : '#1f2937',
              border: m.role === 'user' ? 'none' : '1px solid #e2e8f0',
              boxShadow: '0 1px 2px rgba(0,0,0,0.04)'
            }}>
              <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {m.error ? `发送失败：${m.error}` : m.content}
              </Typography>
            </Box>
            {m.actions.length > 0 && renderActions(m.actions)}
            {m.elapsedMs !== undefined && (
              <Typography variant="caption" color="text.secondary" sx={{ mt: 0.25, display: 'block' }}>
                {m.elapsedMs}ms
              </Typography>
            )}
          </Box>
        ))}
        {sending && (
          <Box sx={{ alignSelf: 'flex-start', display: 'flex', alignItems: 'center', gap: 1 }}>
            <CircularProgress size={16} />
            <Typography variant="body2" color="text.secondary">AI 思考中…</Typography>
          </Box>
        )}
      </Box>

      <Divider />
      <Box sx={{ p: 1.5, display: 'flex', gap: 1, alignItems: 'flex-end' }}>
        <TextField
          fullWidth
          multiline
          minRows={1}
          maxRows={4}
          size="small"
          placeholder={aiConfigured ? '输入问题，Enter 发送（Shift+Enter 换行）' : '请先配置 AI API'}
          value={input}
          disabled={!aiConfigured || sending}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <IconButton color="primary" onClick={send} disabled={!aiConfigured || sending || !input.trim()}>
          <SendIcon />
        </IconButton>
      </Box>
    </Drawer>
  );
}
