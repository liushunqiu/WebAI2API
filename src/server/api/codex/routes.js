/**
 * @fileoverview Codex Responses API 路由
 * @description 参考 deepseek-bridge/server.py + bridge/adapters/responses.py
 *
 * 处理 /v1/responses 和 /responses 路径的请求
 */

import crypto from 'crypto';
import { logger } from '../../../utils/logger.js';
import { ERROR_CODES } from '../../errors.js';
import { sendJson, sendApiError, sendSseEvent, sendSseEnd, buildResponseFailed } from '../../respond.js';
import { parseCodexRequest } from './parse.js';
import { flattenToPrompt, buildToolNameCaseMap, buildToolParamNameMap } from '../../../backend/dsml.js';

// 会话映射: previous_response_id -> { sessionId, lastUsed }
const convMap = new Map();
// 会话复用 TTL：拉长到 4 小时，减少新建会话的频率
// （DeepSeek 风控对「频繁新建会话」的评分高于「同一会话多轮」）
const CONV_TTL = 4 * 60 * 60 * 1000;

// 缓存完整的 response 用于 GET /v1/responses/{id}
const responseCache = new Map();

/**
 * 构建缓存的 response 对象
 */
function buildCachedResponse(responseId, result, model) {
  const output = [];
  if (result.reasoning) {
    output.push({
      type: 'reasoning',
      id: 'reasoning_0',
      status: 'completed',
      summary: [{ type: 'summary_text', text: result.reasoning }],
    });
  }
  if (result.text) {
    output.push({
      type: 'message',
      id: 'msg_0',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: result.text }],
    });
  }
  for (const tc of result.toolCalls || []) {
    const fn = tc.function || {};
    output.push({
      type: 'function_call',
      id: tc.id,
      call_id: tc.id,
      name: fn.name || 'unknown',
      arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments || {}),
      status: 'completed',
    });
  }
  return {
    id: responseId,
    object: 'response',
    status: 'completed',
    created_at: Math.floor(Date.now() / 1000),
    model,
    output,
  };
}

/**
 * 定期清理过期会话映射
 */
function evictStaleConv() {
  const now = Date.now();
  for (const [key, entry] of convMap) {
    if (now - entry.lastUsed > CONV_TTL) {
      convMap.delete(key);
    }
  }
}

/**
 * 提取 Codex 会话 ID
 * @param {import('http').IncomingMessage} req
 * @returns {string|null}
 */
function extractCodexSessionId(req) {
  const sid = req.headers['session-id'] || req.headers['x-codex-session-id'];
  if (sid) return Array.isArray(sid) ? sid[0] : sid;

  const meta = req.headers['x-codex-turn-metadata'];
  if (meta) {
    const metaStr = Array.isArray(meta) ? meta[0] : meta;
    try {
      const parsed = JSON.parse(metaStr);
      if (parsed) {
        return parsed.session_id || parsed.thread_id || null;
      }
    } catch {}
  }

  return req.headers['Session_id'] || req.headers['session_id'] || null;
}

/**
 * 创建 Codex API 路由处理器
 * @param {object} context - 路由上下文
 * @returns {Function} 路由处理函数
 */
export function createCodexRouter(context) {
  const { backendName, getModels, getImagePolicy, getModelType, tempDir, imageLimit, queueManager } = context;

  // 注册 Codex 响应缓存回调
  if (queueManager && typeof queueManager.registerCodexCache === 'function') {
    queueManager.registerCodexCache(responseCache, buildCachedResponse);
  }

  // 注册 Codex 会话跟踪: 任务完成后将 result.sessionId 写回 convMap
  // 使得同一 codex-session-id 的后续请求能复用同一 DeepSeek 线程
  if (queueManager && typeof queueManager.registerCodexSessionTracker === 'function') {
    queueManager.registerCodexSessionTracker((convId, sessionId) => {
      convMap.set(convId, { sessionId, lastUsed: Date.now() });
      logger.info('服务器', `Codex 会话已绑定: conv=${convId} -> sessionId=${sessionId}`);
    });
  }

  /**
   * 处理 POST /v1/responses
   */
  async function handleCreateResponse(req, res, requestId) {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }

    try {
      const body = Buffer.concat(chunks).toString();
      const data = JSON.parse(body);

      // 设置 SSE 响应头
      const isStreaming = data.stream !== false;
      if (isStreaming) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });
      }

      // 解析 Codex 请求
      const parseResult = await parseCodexRequest(data, {
        tempDir,
        imageLimit,
        backendName,
        getSupportedModels: getModels,
        getImagePolicy,
        getModelType,
        requestId,
        logger,
      });

      if (!parseResult.success) {
        sendApiError(res, {
          code: parseResult.error.code,
          message: parseResult.error.error,
          isStreaming,
        });
        return;
      }

      const { messages, tools, toolChoice, model, modelName, conversationId, imagePaths } = parseResult.data;

      // 提取 Codex session-id header 作为额外的 conversation 标识
      const codexSession = extractCodexSessionId(req);
      const effectiveConvId = codexSession || conversationId;

      // 查找会话映射 -> sessionId (DeepSeek thread)
      let sessionId = null;
      if (effectiveConvId) {
        evictStaleConv();
        const entry = convMap.get(effectiveConvId);
        if (entry) {
          sessionId = entry.sessionId;
          entry.lastUsed = Date.now();
          logger.info('服务器', `Codex 复用会话: ${effectiveConvId} -> sessionId=${sessionId}`, { id: requestId });
        }
      }

      // 构建工具名/参数纠错映射
      const nameMap = buildToolNameCaseMap(tools);
      const paramMap = buildToolParamNameMap(tools);

      // 没有已知的 DeepSeek 线程 ID 即为首次对话
      const firstTurn = !sessionId;

      // 展平 prompt
      const prompt = flattenToPrompt({ messages, tools, toolChoice, firstTurn, conversationId: effectiveConvId });

      logger.info('服务器', `[Codex] 请求入队: model=${model} msgs=${messages.length} tools=${tools.length} conv=${effectiveConvId} firstTurn=${firstTurn}`, {
        id: requestId,
        promptLen: prompt.length,
      });

      // 构建完整的 response ID，用于缓存
      const responseId = 'resp_' + crypto.randomUUID().replace(/-/g, '').slice(0, 10);

      // 加入队列
      queueManager.addTask({
        req,
        res,
        prompt,
        imagePaths,
        modelId: model,
        modelName,
        id: requestId,
        responseId,
        isStreaming,
        taskType: 'responses',
        reasoning: true,
        sessionId,
        nameMap,
        paramMap,
        tools,
        toolChoice,
        conversationId: effectiveConvId,
      });

      // 缓存生成的完整 response 用于 GET, 但实际内容在任务完成后才填充
      // 任务完成后会通过 queue 回调更新缓存
      responseCache.set(requestId, null);

    } catch (err) {
      logger.error('服务器', 'Codex 请求处理失败', { id: requestId, error: err.message });
      sendApiError(res, {
        code: ERROR_CODES.INTERNAL_ERROR,
        message: err.message,
      });
    }
  }

  /**
   * 处理 GET /v1/responses/{responseId}
   */
  function handleGetResponse(res, responseId) {
    const cached = responseCache.get(responseId);
    if (cached) {
      sendJson(res, 200, cached);
    } else {
      sendJson(res, 404, {
        error: { message: `response '${responseId}' not found`, code: 'NOT_FOUND' },
      });
    }
  }

  /**
   * 主路由处理函数
   */
  return async function handleCodexRequest(req, res, pathname, parsedUrl) {
    const requestId = crypto.randomUUID().slice(0, 8);

    // POST /responses (pathname 可能是 /responses 或 /v1/responses)
    if (req.method === 'POST' && pathname.endsWith('/responses')) {
      await handleCreateResponse(req, res, requestId);
    }
    // GET /responses/{id}
    else if (req.method === 'GET') {
      const match = pathname.match(/\/responses\/(.+)$/);
      if (match) {
        handleGetResponse(res, match[1]);
      } else {
        res.writeHead(404);
        res.end();
      }
    } else {
      res.writeHead(404);
      res.end();
    }
  };
}
