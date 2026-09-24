/**
 * ai-chat.ts — AI 对话（OpenAI 兼容 Chat Completions）
 *
 * 与 ai-worker.ts（一次性方案推荐）不同，本模块承载多轮对话：
 * 渲染层传入消息历史 + 当前对比上下文，主进程统一注入系统提示词。
 */

import { logger } from './logger';
import type { AISettings, ChatMessage } from '../shared/types';

const SYSTEM_PROMPT = `你是一个 APK 差异分析助手，集成在 APK Diff Tool 桌面应用内。用户正在对比两个 Android APK 安装包，需要你帮忙解读差异内容。

回答要求：
- 始终使用中文，简洁、直接、面向结论
- 基于提供的对比上下文回答，不要编造上下文中不存在的文件或数据
- 用户可能问：哪些文件改动最可疑、某文件改了什么、隐私/安全风险评估、下一步该做什么
- Android APK 常识：AndroidManifest.xml 是清单（权限/组件），res/ 是资源，assets/ 是随包文件，lib/ 是原生库，classes*.dex 是代码；smali 是反编译的字节码文本

可用操作（可选，仅当你认为对用户有帮助时使用，每条独占一行放在回答末尾）：
- ACTION: view_file:<文件路径> —— 让用户一键查看该文件的内容差异（路径必须来自上下文中的变更文件列表）
- ACTION: full_diff —— 建议用户开始完整 apktool 反编译对比（适用于需要 smali 级代码差异时）`;

/** 与 ai-worker 保持一致的端点规范化 */
function normalizeEndpoint(baseUrl: string): string {
  let url = baseUrl.replace(/\/$/, '');
  if (!url.endsWith('/chat/completions') && !url.endsWith('/chat/completions/')) {
    url = `${url}/chat/completions`;
  }
  return url;
}

export async function chatWithAI(
  settings: AISettings,
  messages: ChatMessage[],
  context: string
): Promise<{ content: string; elapsedMs: number }> {
  if (!settings.baseUrl || !settings.apiKey || !settings.model) {
    throw new Error('AI API 未配置（请点击工具栏 AI 图标填写 Base URL / API Key / 模型名）');
  }

  const url = normalizeEndpoint(settings.baseUrl);
  const startTime = Date.now();

  // 只保留 user/assistant 历史，system 由主进程统一注入
  const history = messages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .slice(-12)
    .map(m => ({ role: m.role, content: m.content }));

  const payloadMessages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...(context.trim() ? [{ role: 'system' as const, content: '当前对比上下文：\n' + context }] : []),
    ...history
  ];

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${settings.apiKey}`
    },
    body: JSON.stringify({
      model: settings.model,
      messages: payloadMessages,
      temperature: 0.4,
      max_tokens: 2000
    }),
    signal: AbortSignal.timeout(120_000)
  });

  const elapsedMs = Date.now() - startTime;
  logger.info(`AI chat: status=${response.status}, elapsed=${elapsedMs}ms`);

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    logger.error(`AI chat error ${response.status}: ${errText.slice(0, 500)}`);
    throw new Error(`AI API 返回 ${response.status}: ${errText.slice(0, 200)}`);
  }

  const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content || '';
  if (!content.trim()) {
    throw new Error('AI 返回了空响应，请稍后重试');
  }
  return { content, elapsedMs };
}
