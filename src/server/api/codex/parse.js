/**
 * @fileoverview Codex 请求解析模块
 * @description 参考 deepseek-bridge/bridge/adapters/responses.py normalize_request
 *
 * Codex 使用 OpenAI Responses API，请求体中有 input 字段代替 messages，
 * input 数组的元素类型包括：message / function_call / function_call_output / reasoning
 */

import { toolCallsToDsml } from '../../../backend/dsml.js';
import { ERROR_CODES, getErrorMessage } from '../../errors.js';

/**
 * 解析 Codex 请求
 * @param {object} data - 请求体
 * @param {object} options - 解析选项
 * @returns {Promise<{success: boolean, data?: object, error?: object}>}
 */
export async function parseCodexRequest(data, options) {
  const { tempDir, imageLimit, getSupportedModels, getImagePolicy, requestId, logger } = options;

  const model = data.model || 'deepseek-v4-flash';
  const stream = data.stream !== false;
  const toolChoice = data.tool_choice || 'auto';
  const previousResponseId = data.previous_response_id || data.conversation_id || null;

  // 验证 model
  if (model) {
    const supportedModels = getSupportedModels();
    const isSupported = supportedModels.data.some((m) => m.id === model);
    if (!isSupported) {
      return {
        success: false,
        error: {
          code: ERROR_CODES.INVALID_MODEL,
          error: `模型无效: ${model}`,
        },
      };
    }
  }

  // 解析 input
  const messages = extractInputMessages(data.input || []);
  if (messages.length === 0) {
    return {
      success: false,
      error: {
        code: ERROR_CODES.NO_MESSAGES,
        error: 'input 中没有有效的消息',
      },
    };
  }

  // 验证图片策略
  const imagePaths = [];
  let imageCount = 0;
  for (const msg of messages) {
    if (msg.images && Array.isArray(msg.images)) {
      for (const img of msg.images) {
        imageCount++;
        if (imageLimit > 0 && imageCount > imageLimit) {
          continue;
        }
        if (img.startsWith('data:image')) {
          const imagePath = await saveBase64Image(img, tempDir);
          if (imagePath) imagePaths.push(imagePath);
        }
      }
    }
  }

  // 解析 tools
  let tools = data.tools;
  if (tools != null && !Array.isArray(tools)) {
    tools = null;
  }

  logger.info('服务器', `Codex 请求: model=${model} msgs=${messages.length} tools=${tools ? tools.length : 0} conv=${previousResponseId}`, { id: requestId });

  return {
    success: true,
    data: {
      model,
      modelName: model,
      messages,
      tools: tools || [],
      toolChoice: typeof toolChoice === 'string' ? toolChoice : 'auto',
      stream,
      conversationId: previousResponseId,
      imagePaths,
    },
  };
}

/**
 * 从 Codex input 数组中提取内部消息
 * @param {Array} input
 * @returns {object[]} 标准化消息数组 [{ role, content, name?, tool_call_id?, images? }]
 */
function extractInputMessages(input) {
  const messages = [];
  const callIdToName = {};

  if (!Array.isArray(input)) {
    if (typeof input === 'string') {
      return [{ role: 'user', content: input }];
    }
    return messages;
  }

  for (const node of input) {
    if (!node || typeof node !== 'object') continue;

    const role = node.role || '';
    const type = node.type || '';

    // function_call / tool_call
    if (type === 'function_call' || type === 'tool_call') {
      const name = (node.name || '').trim();
      let args = node.arguments;
      if (args == null) args = node.input;
      if (args == null) args = '{}';
      else if (typeof args === 'object') args = JSON.stringify(args);

      const callId = node.call_id || node.id || '';
      if (name && callId) {
        callIdToName[callId] = name;
      }

      const tc = [
        {
          id: callId,
          type: 'function',
          function: { name, arguments: args },
        },
      ];
      messages.push({ role: 'assistant', content: toolCallsToDsml(tc) });
      continue;
    }

    // function_call_output / tool_result
    if (type === 'function_call_output' || type === 'tool_result') {
      let output = node.output;
      if (output == null) output = node.content || '';
      if (Array.isArray(output)) {
        output = output
          .map((part) => (part && typeof part === 'object' ? part.text || part.content || '' : String(part)))
          .filter(Boolean)
          .join('\n');
      } else if (typeof output !== 'string') {
        output = JSON.stringify(output);
      }
      const callId = node.call_id || node.tool_call_id || node.id || '';
      const toolName = callId ? callIdToName[callId] : null;
      messages.push({
        role: 'tool',
        content: output,
        name: toolName || undefined,
        tool_call_id: callId || undefined,
      });
      continue;
    }

    // reasoning — 不回灌给模型
    if (type === 'reasoning') continue;

    // message / 空 type
    const msgRole = role || 'user';
    const contentNode = node.content;
    const images = [];

    if (typeof contentNode === 'string') {
      messages.push({ role: msgRole, content: contentNode });
    } else if (Array.isArray(contentNode)) {
      const parts = [];
      for (const part of contentNode) {
        if (!part || typeof part !== 'object') continue;
        const pt = part.type || '';
        if (pt === 'input_text' || pt === 'output_text' || pt === 'text') {
          if (part.text) parts.push(part.text);
        } else if (pt === 'image_url' && part.image_url?.url) {
          images.push(part.image_url.url);
        }
      }
      if (parts.length > 0 || images.length > 0) {
        messages.push({ role: msgRole, content: parts.join('\n'), images: images.length > 0 ? images : undefined });
      }
    }
  }

  return messages;
}

/**
 * 保存 Base64 图片到临时文件
 * @param {string} dataUrl
 * @param {string} tempDir
 * @returns {Promise<string|null>}
 */
async function saveBase64Image(dataUrl, tempDir) {
  const matches = dataUrl.match(/^data:([A-Za-z-+/]+);base64,(.+)$/);
  if (!matches || matches.length !== 3) return null;

  try {
    const fs = await import('fs/promises');
    const path = await import('path');
    const buffer = Buffer.from(matches[2], 'base64');
    const filename = `codex_img_${Date.now()}_${Math.random().toString(36).substring(7)}.jpg`;
    const filePath = path.join(tempDir, filename);
    await fs.writeFile(filePath, buffer);
    return filePath;
  } catch {
    return null;
  }
}
