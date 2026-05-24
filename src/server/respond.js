/**
 * @fileoverview 统一响应写出模块
 * @description 封装 JSON、SSE 响应和错误响应的统一处理函数
 */

import { getErrorDetails } from './errors.js';

/**
 * 发送 JSON 响应
 * @param {import('http').ServerResponse} res - HTTP 响应对象
 * @param {number} status - HTTP 状态码
 * @param {object} payload - 响应数据
 */
export function sendJson(res, status, payload) {
    if (res.writableEnded) return;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
}

/**
 * 发送 SSE 事件
 * @param {import('http').ServerResponse} res - HTTP 响应对象
 * @param {object} payload - 事件数据
 */
export function sendSse(res, payload) {
    if (res.writableEnded) return;
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

/**
 * 发送 SSE 结束标记
 * @param {import('http').ServerResponse} res - HTTP 响应对象
 */
export function sendSseDone(res) {
    if (res.writableEnded) return;
    res.write(`data: [DONE]\n\n`);
    res.end();
}

/**
 * 发送 SSE 心跳包
 * @param {import('http').ServerResponse} res - HTTP 响应对象
 * @param {string} mode - 心跳模式 ('comment' | 'content')
 * @param {string} [modelName] - 模型名称（content 模式需要）
 */
export function sendHeartbeat(res, mode, modelName) {
    if (res.writableEnded) return;

    if (mode === 'comment') {
        res.write(`:keepalive\n\n`);
    } else {
        // content 模式：发送空 delta
        const chunk = {
            id: 'chatcmpl-' + Date.now(),
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: modelName || 'default-model',
            choices: [{
                index: 0,
                delta: { content: '' },
                finish_reason: null
            }]
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    }
}

/**
 * 发送统一 API 错误响应 (OpenAI 标准格式)
 * @param {import('http').ServerResponse} res - HTTP 响应对象
 * @param {object} options - 错误选项
 * @param {string} [options.code] - 错误码（使用 ERROR_CODES 枚举）
 * @param {string} [options.message] - 自定义错误消息（如提供则覆盖 code 对应的消息）
 * @param {number} [options.status] - 自定义 HTTP 状态码
 * @param {boolean} [options.isStreaming=false] - 是否为流式响应
 */
export function sendApiError(res, options) {
    const { code, message, status, isStreaming = false } = options;

    // 获取错误详情
    const details = code ? getErrorDetails(code) : null;
    const errorMessage = message || (details ? details.message : '未知错误');
    const errorType = details?.type || 'server_error';
    const httpStatus = status || (details ? details.status : 500);

    // 构造 OpenAI 标准错误响应体
    const payload = {
        error: {
            message: errorMessage,
            type: errorType,
            code: code || 'INTERNAL_ERROR'
        }
    };

    if (isStreaming) {
        // 流式响应：发送错误事件然后结束
        sendSse(res, payload);
        sendSseDone(res);
    } else {
        // 非流式响应
        sendJson(res, httpStatus, payload);
    }
}

/**
 * 构造 OpenAI 格式的聊天完成响应（非流式）
 * @param {string} content - 响应内容
 * @param {string} [modelName] - 模型名称
 * @param {string} [reasoningContent] - 思考/推理过程内容 (OpenAI o1 格式)
 * @param {string} [sessionId] - 会话 ID
 * @returns {object} OpenAI 格式的响应对象
 */
export function buildChatCompletion(content, modelName, reasoningContent, sessionId) {
    const message = {
        role: 'assistant',
        content: content
    };
    if (reasoningContent) {
        message.reasoning_content = reasoningContent;
    }

    return {
        id: 'chatcmpl-' + Date.now(),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: modelName || 'default-model',
        choices: [{
            index: 0,
            message,
            finish_reason: 'stop'
        }],
        ...(sessionId ? { session_id: sessionId } : {})
    };
}

/**
 * 构造 OpenAI 格式的流式聊天完成响应块
 * @param {string} content - 响应内容
 * @param {string} [modelName] - 模型名称
 * @param {string|null} [finishReason='stop'] - 完成原因
 * @param {string} [reasoningContent] - 思考/推理过程内容 (OpenAI o1 格式)
 * @param {string} [sessionId] - 会话 ID
 * @returns {object} OpenAI 格式的流式响应块
 */
export function buildChatCompletionChunk(content, modelName, finishReason = 'stop', reasoningContent, sessionId) {
    const delta = { content };
    if (reasoningContent) {
        delta.reasoning_content = reasoningContent;
    }

    return {
        id: 'chatcmpl-' + Date.now(),
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: modelName || 'default-model',
        choices: [{
            index: 0,
            delta,
            finish_reason: finishReason
        }],
        ...(sessionId ? { session_id: sessionId } : {})
    };
}

// ──────────────────────────────────────────────────────────────
// OpenAI Responses API (Codex) SSE 格式支持
// ──────────────────────────────────────────────────────────────

/**
 * 发送 SSE 命名事件 (event: xxx\ndata: ...\n\n)
 * @param {import('http').ServerResponse} res
 * @param {string} event - 事件名称
 * @param {object} data - 事件数据
 */
export function sendSseEvent(res, event, data) {
    if (res.writableEnded) return;
    const eventName = event || (data && data.type) || '';
    res.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * 发送 SSE 结束事件（非 [DONE] 行，而是 event: done）
 */
export function sendSseEnd(res) {
    if (res.writableEnded) return;
    res.write(`event: done\ndata: [DONE]\n\n`);
    res.end();
}

/**
 * 构建 response.created 事件
 */
export function buildResponseCreated(modelName, sessionId) {
    const responseId = 'resp_' + Date.now();
    return {
        type: 'response.created',
        response: {
            id: responseId,
            object: 'response',
            created: Math.floor(Date.now() / 1000),
            model: modelName || 'deepseek-chat',
            status: 'in_progress',
            ...(sessionId ? { session_id: sessionId } : {})
        }
    };
}

/**
 * 构建 response.in_progress 事件
 */
export function buildResponseInProgress(responseId) {
    return {
        type: 'response.in_progress',
        response_id: responseId
    };
}

/**
 * 构建 response.completed 事件
 */
export function buildResponseCompleted(responseId, modelName) {
    return {
        type: 'response.completed',
        response: {
            id: responseId,
            object: 'response',
            created: Math.floor(Date.now() / 1000),
            model: modelName || 'deepseek-chat',
            status: 'completed',
            output: []
        }
    };
}

/**
 * 构建 response.output_item.added 事件
 */
export function buildOutputItemAdded(responseId, itemId, outputIndex, item) {
    return {
        type: 'response.output_item.added',
        item_id: itemId,
        response_id: responseId,
        output_index: outputIndex,
        item
    };
}

/**
 * 构建 response.content_part.added 事件
 */
export function buildContentPartAdded(responseId, itemId, outputIndex, contentIndex) {
    return {
        type: 'response.content_part.added',
        item_id: itemId,
        response_id: responseId,
        output_index: outputIndex,
        content_index: contentIndex,
        part: { type: 'output_text', text: '' }
    };
}

/**
 * 构建 response.output_text.delta 事件
 */
export function buildOutputTextDelta(responseId, itemId, outputIndex, contentIndex, delta) {
    return {
        type: 'response.output_text.delta',
        item_id: itemId,
        response_id: responseId,
        output_index: outputIndex,
        content_index: contentIndex,
        delta
    };
}

/**
 * 构建 response.output_text.done 事件
 */
export function buildOutputTextDone(responseId, itemId, outputIndex, contentIndex, text) {
    return {
        type: 'response.output_text.done',
        item_id: itemId,
        response_id: responseId,
        output_index: outputIndex,
        content_index: contentIndex,
        text
    };
}

/**
 * 构建 response.function_call_arguments.delta 事件
 * queue.js 调用: (responseId, itemId, delta) — outputIndex/callIndex 默认 0
 */
export function buildFunctionCallDelta(responseId, itemId, delta, outputIndex = 0, callIndex = 0) {
    return {
        type: 'response.function_call_arguments.delta',
        item_id: itemId,
        response_id: responseId,
        output_index: outputIndex,
        call_index: callIndex,
        delta
    };
}

/**
 * 构建 response.function_call_arguments.done 事件
 * queue.js 调用: (responseId, itemId, callId, name, args)
 */
export function buildFunctionCallDone(responseId, itemId, callId, name, args, outputIndex = 0, callIndex = 0) {
    return {
        type: 'response.function_call_arguments.done',
        item_id: itemId,
        response_id: responseId,
        output_index: outputIndex,
        call_index: callIndex,
        name,
        arguments: args
    };
}

/**
 * 构建 response.code_calling_function.delta 事件
 */
export function buildCodeCallDelta(responseId, itemId, delta, outputIndex = 0, callIndex = 0) {
    return {
        type: 'response.code_calling_function.delta',
        item_id: itemId,
        response_id: responseId,
        output_index: outputIndex,
        call_index: callIndex,
        delta
    };
}

/**
 * 构建 response.code_calling_function.done 事件
 */
export function buildCodeCallDone(responseId, itemId, callId, name, args, outputIndex = 0, callIndex = 0) {
    return {
        type: 'response.code_calling_function.done',
        item_id: itemId,
        response_id: responseId,
        output_index: outputIndex,
        call_index: callIndex,
        name,
        arguments: args
    };
}

/**
 * 构建 response.error 事件
 */
export function buildResponseError(responseId, code, message) {
    return {
        type: 'response.error',
        response_id: responseId,
        error: {
            code: code || 'INTERNAL_ERROR',
            message: message || 'Unknown error'
        }
    };
}

// ──────────────────────────────────────────────────────────────
// queue.js sendCodexResponse 所需的额外 builder 函数
// ──────────────────────────────────────────────────────────────

/**
 * 构建 reasoning text delta 事件
 */
export function buildReasoningDelta(responseId, itemId, outputIndex, delta) {
    return {
        type: 'response.reasoning_summary_text.delta',
        item_id: itemId,
        response_id: responseId,
        output_index: outputIndex,
        summary_index: 0,
        delta
    };
}

/**
 * 构建 reasoning text done 事件
 */
export function buildReasoningDone(responseId, itemId, outputIndex, text) {
    return {
        type: 'response.reasoning_summary_text.done',
        item_id: itemId,
        response_id: responseId,
        output_index: outputIndex,
        summary_index: 0,
        text
    };
}

/**
 * 构建 reasoning item done 事件
 */
export function buildReasoningItemDone(responseId, itemId, outputIndex, text) {
    return {
        type: 'response.output_item.done',
        item_id: itemId,
        response_id: responseId,
        output_index: outputIndex,
        item: { type: 'reasoning', text }
    };
}

/**
 * 构建 content part done 事件
 */
export function buildContentPartDone(responseId, itemId, outputIndex, contentIndex, part) {
    return {
        type: 'response.content_part.done',
        item_id: itemId,
        response_id: responseId,
        output_index: outputIndex,
        content_index: contentIndex,
        part
    };
}

/**
 * 构建 message item done 事件
 */
export function buildMessageItemDone(responseId, itemId, outputIndex, text) {
    return {
        type: 'response.output_item.done',
        item_id: itemId,
        response_id: responseId,
        output_index: outputIndex,
        item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }
    };
}

/**
 * 构建 function call item done 事件
 */
export function buildFunctionCallItemDone(responseId, itemId, callIndex, name, args) {
    return {
        type: 'response.output_item.done',
        item_id: itemId,
        response_id: responseId,
        output_index: callIndex,
        item: {
            type: 'function_call',
            id: itemId,
            call_id: itemId,
            name,
            arguments: args
        }
    };
}

/**
 * 构建 response.failed 事件
 */
export function buildResponseFailed(responseId, error) {
    return {
        type: 'response.failed',
        response_id: responseId,
        error: {
            code: 'GENERATION_FAILED',
            message: typeof error === 'string' ? error : (error?.message || 'Unknown error')
        }
    };
}
