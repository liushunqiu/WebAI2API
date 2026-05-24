/**
 * @fileoverview DSML 工具调用格式：渲染器 + 流式解析器
 * @description 参考 deepseek-bridge/bridge/dsml.py
 *
 * DeepSeek 网页端不支持 OpenAI tools 字段，所以把工具定义渲染成说明文本
 * 塞进 prompt，模型在文本里输出 DSML XML 格式的工具调用。
 */

import crypto from 'node:crypto';



// ──────────────────────────────────────────────────────────────
// DSML 渲染：tool_calls(JSON 数组) -> DSML 文本
// ──────────────────────────────────────────────────────────────

export function toolCallsToDsml(toolCalls) {
  if (!toolCalls || !Array.isArray(toolCalls) || toolCalls.length === 0) return '';
  const blocks = toolCalls.map(formatSingleToolCall).filter(Boolean);
  if (blocks.length === 0) return '';
  return '<|DSML|tool_calls>\n' + blocks.join('\n') + '\n</|DSML|tool_calls>';
}

function formatSingleToolCall(call) {
  if (!call || typeof call !== 'object') return '';
  const func = call.function || {};
  const name = (func.name || call.name || '').trim();
  const argsRaw = func.arguments || call.arguments || call.input || null;
  if (!name) return '';
  const params = formatParametersForPrompt(argsRaw);
  const attr = escapeXmlAttr(name);
  if (!params) {
    return `  <|DSML|invoke name="${attr}"></|DSML|invoke>`;
  }
  return `  <|DSML|invoke name="${attr}">\n${params}\n  </|DSML|invoke>`;
}

function formatParametersForPrompt(argsRaw) {
  if (argsRaw == null) return '';
  if (typeof argsRaw === 'string') {
    const text = argsRaw.trim();
    if (!text) return '';
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return renderObjectParams(parsed, '    ');
      }
    } catch {}
    return `    <|DSML|parameter name="content">${renderCdata(text)}</|DSML|parameter>`;
  }
  if (typeof argsRaw === 'object' && !Array.isArray(argsRaw)) {
    if (Object.keys(argsRaw).length === 0) return '';
    return renderObjectParams(argsRaw, '    ');
  }
  if (Array.isArray(argsRaw)) {
    return renderArrayParams(argsRaw, '    ');
  }
  return `    <|DSML|parameter name="value">${renderCdata(String(argsRaw))}</|DSML|parameter>`;
}

function renderObjectParams(obj, indent) {
  const lines = [];
  for (const [k, v] of Object.entries(obj)) {
    const rendered = renderParameterNode(k, v, indent);
    if (rendered) lines.push(rendered);
  }
  return lines.join('\n');
}

function renderArrayParams(arr, indent) {
  const lines = [];
  for (const item of arr) {
    const rendered = renderParameterNode('item', item, indent);
    if (rendered) lines.push(rendered);
  }
  return lines.join('\n');
}

function renderParameterNode(name, value, indent) {
  if (!name || !name.trim()) return '';
  name = name.trim();
  const attr = escapeXmlAttr(name);

  if (value == null) {
    return `${indent}<|DSML|parameter name="${attr}"></|DSML|parameter>`;
  }

  if (typeof value === 'object' && !Array.isArray(value)) {
    if (Object.keys(value).length === 0) {
      return `${indent}<|DSML|parameter name="${attr}"></|DSML|parameter>`;
    }
    const inner = renderObjectParams(value, indent + '  ');
    if (!inner.trim()) {
      return `${indent}<|DSML|parameter name="${attr}"></|DSML|parameter>`;
    }
    return `${indent}<|DSML|parameter name="${attr}">\n${inner}\n${indent}</|DSML|parameter>`;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return `${indent}<|DSML|parameter name="${attr}"></|DSML|parameter>`;
    }
    const itemLines = [];
    for (const item of value) {
      const r = renderParameterNode('item', item, indent + '  ');
      if (r) itemLines.push(r);
    }
    if (itemLines.length === 0) {
      return `${indent}<|DSML|parameter name="${attr}"></|DSML|parameter>`;
    }
    return `${indent}<|DSML|parameter name="${attr}">\n${itemLines.join('\n')}\n${indent}</|DSML|parameter>`;
  }

  let text;
  if (typeof value === 'string') {
    text = renderCdata(value);
  } else if (typeof value === 'boolean') {
    text = value ? 'true' : 'false';
  } else {
    text = escapeXmlText(String(value));
  }
  return `${indent}<|DSML|parameter name="${attr}">${text}</|DSML|parameter>`;
}

function renderCdata(text) {
  if (!text) return '';
  if (text.includes(']]>')) {
    return '<![CDATA[' + text.replace(/]]>/g, ']]]]><![CDATA[>') + ']]>';
  }
  return `<![CDATA[${text}]]>`;
}

function escapeXmlAttr(text) {
  return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeXmlText(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ──────────────────────────────────────────────────────────────
// 工具说明文本：渲染 tools 数组成可塞进 prompt 的提示块
// ──────────────────────────────────────────────────────────────

const TOOL_CALL_INSTRUCTIONS = `TOOL CALL FORMAT — FOLLOW EXACTLY:

<|DSML|tool_calls>
  <|DSML|invoke name="TOOL_NAME_HERE">
    <|DSML|parameter name="PARAMETER_NAME"><![CDATA[PARAMETER_VALUE]]></|DSML|parameter>
  </|DSML|invoke>
</|DSML|tool_calls>

RULES:
1) Use the <|DSML|tool_calls> wrapper format.
2) Put one or more <|DSML|invoke> entries under a single <|DSML|tool_calls> root.
3) Put the tool name in the invoke name attribute: <|DSML|invoke name="TOOL_NAME">.
4) All string values must use <![CDATA[...]]>, even short ones.
5) Every top-level argument must be a <|DSML|parameter name="ARG_NAME">...</|DSML|parameter> node.
6) Objects use nested XML elements inside the parameter body. Arrays may repeat <item> children.
7) Numbers, booleans, and null stay plain text.
8) Use only the parameter names in the tool schema. Do not invent fields.
9) Do NOT wrap XML in markdown fences. Do NOT output explanations, role markers, or internal monologue.
10) If you call a tool, the first non-whitespace characters of that tool block must be exactly <|DSML|tool_calls>.
11) Never omit the opening <|DSML|tool_calls> tag.
12) CRITICAL for file writing tools: The parameter value must contain ONLY the raw file content. Do NOT wrap content in shell commands like heredoc, cat, echo, or any other shell syntax.`;

const TOOL_USAGE_NOTES = {
  update_plan:
    'IMPORTANT: After calling update_plan, the plan is already shown to the user in the UI. ' +
    'You MUST immediately proceed to execute step 1 via another tool call in the SAME response. ' +
    'Do NOT restate, summarize, or describe the plan in natural language. ' +
    'Do NOT ask the user to confirm before proceeding.',
};

/**
 * 把工具数组渲染成一段说明文本，塞到系统提示后面
 * @param {object[]} tools - OpenAI tools 格式
 * @returns {string}
 */
export function formatToolsSection(tools) {
  if (!tools || !Array.isArray(tools) || tools.length === 0) return '';
  const names = [];
  const schemas = [];

  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') continue;
    const name = extractToolName(tool);
    if (!name) continue;
    const desc = extractToolDesc(tool);
    const params = extractToolSchema(tool);
    const paramsStr = params ? JSON.stringify(params) : '{}';
    names.push(name);
    const note = TOOL_USAGE_NOTES[name];
    let block = `Tool: ${name}\nDescription: ${desc}\nParameters: ${paramsStr}\n`;
    if (note) block += `Usage Note: ${note}\n`;
    schemas.push(block);
  }

  if (names.length === 0) return '';

  return (
    '\n\nYou have access to these tools:\n\n' +
    'CRITICAL: You MUST use EXACTLY the tool names listed below. ' +
    'Do NOT invent, rename, or substitute tool names.\n' +
    `Available tool names: ${names.join(', ')}\n\n` +
    schemas.join('\n') +
    '\n' +
    TOOL_CALL_INSTRUCTIONS +
    '\n'
  );
}

function extractToolName(tool) {
  const n = (tool.name || '').trim();
  if (n) return n;
  const func = tool.function || {};
  return (func.name || '').trim();
}

function extractToolDesc(tool) {
  const d = (tool.description || '').trim();
  if (d) return d;
  const func = tool.function || {};
  return (func.description || '').trim() || 'No description available';
}

function extractToolSchema(tool) {
  for (const k of ['parameters', 'input_schema', 'inputSchema', 'schema']) {
    const v = tool[k];
    if (v != null) return v;
  }
  const func = tool.function || {};
  for (const k of ['parameters', 'input_schema', 'inputSchema', 'schema']) {
    const v = func[k];
    if (v != null) return v;
  }
  return null;
}

// ──────────────────────────────────────────────────────────────
// DSML 解析：从文本中提取工具调用
// ──────────────────────────────────────────────────────────────

const DSML_TOOL_CALLS_RE = /<\|?DSML\|?tool_calls\s*>([\s\S]*?)<\/\|?DSML\|?tool_calls\s*>/gi;
const DSML_INVOKE_RE = /<\|?DSML\|?invoke\s+name="([^"]*?)"\s*>([\s\S]*?)<\/\|?DSML\|?invoke\s*>/gi;
const DSML_PARAM_RE = /<\|?DSML\|?parameter\s+name="([^"]*?)"[^>]*>([\s\S]*?)<\/\|?DSML\|?parameter\s*>/gi;
const CDATA_STRIP_RE = /<!\[CDATA\[([\s\S]*?)\]\]>/g;

function stripCdataWrappers(text) {
  if (!text) return '';
  if (!text.includes('<![CDATA[')) return text;
  return text.replace(CDATA_STRIP_RE, '$1');
}

/**
 * 从完整文本中解析 DSML 工具调用
 * @param {string} text - 包含 DSML 的文本
 * @returns {{ toolCalls: object[], textParts: string[] }}
 */
export function parseDsmlFromText(text) {
  const toolCalls = [];
  const textParts = [];
  let lastIndex = 0;

  let match;
  DSML_TOOL_CALLS_RE.lastIndex = 0;

  while ((match = DSML_TOOL_CALLS_RE.exec(text)) !== null) {
    // 收集 tool_calls 块之前的文本
    if (match.index > lastIndex) {
      textParts.push(text.slice(lastIndex, match.index));
    }

    const toolCallsBlock = match[1];
    const calls = parseInvokeBlocks(toolCallsBlock);
    toolCalls.push(...calls);

    lastIndex = DSML_TOOL_CALLS_RE.lastIndex;
  }

  // 剩余文本
  if (lastIndex < text.length) {
    textParts.push(text.slice(lastIndex));
  }

  return { toolCalls, textParts };
}

function parseInvokeBlocks(xml) {
  const calls = [];
  let m;
  DSML_INVOKE_RE.lastIndex = 0;
  while ((m = DSML_INVOKE_RE.exec(xml)) !== null) {
    const name = m[1];
    const body = m[2];
    const args = parseInvokeBodyToJson(body);
    const callId = 'call_' + crypto.randomUUID().replace(/-/g, '').slice(0, 8);
    calls.push({
      id: callId,
      type: 'function',
      function: {
        name,
        arguments: args,
      },
    });
  }
  return calls;
}

function parseInvokeBodyToJson(body) {
  const params = {};
  let m;
  DSML_PARAM_RE.lastIndex = 0;
  while ((m = DSML_PARAM_RE.exec(body)) !== null) {
    const paramName = m[1];
    // 兼容：CDATA 包裹 / 无 CDATA / 同一参数多段 CDATA 混合
    const paramValue = stripCdataWrappers(m[2]).trim();
    params[paramName] = unwrapValue(paramValue);
  }
  unwrapSameNameDoubleWrap(params);
  if (Object.keys(params).length === 0) return '{}';
  return JSON.stringify(params);
}

// 兼容模型把整套 arguments JSON 当作单个同名参数的值传过来：
// <parameter name="plan">{"plan":[...]}</parameter> 解析后会得到
// {plan:{plan:[...]}}，但 schema 期望 {plan:[...]}。仅当 inner object
// 只有一个 key 且与参数同名时去掉一层，避免误伤合法的嵌套结构。
function unwrapSameNameDoubleWrap(params) {
  for (const key of Object.keys(params)) {
    const value = params[key];
    if (
      value
      && typeof value === 'object'
      && !Array.isArray(value)
      && Object.keys(value).length === 1
      && Object.prototype.hasOwnProperty.call(value, key)
    ) {
      params[key] = value[key];
    }
  }
}

function unwrapValue(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return value;

  // JSON object/array
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {}
  }

  // boolean
  const low = trimmed.toLowerCase();
  if (low === 'true') return true;
  if (low === 'false') return false;
  if (low === 'null') return null;

  // number
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return trimmed.includes('.') ? parseFloat(trimmed) : parseInt(trimmed, 10);
  }

  return value;
}

// ──────────────────────────────────────────────────────────────
// 工具名/参数名纠错（参考 deepseek-bridge/bridge/adapters/responses.py）
// ──────────────────────────────────────────────────────────────

/**
 * 构建工具名大小写映射：小写名 -> 原始名
 * DeepSeek 可能输出 'bash' 而 Codex 定义 'Bash'
 */
export function buildToolNameCaseMap(tools) {
  const nameMap = {};
  if (!tools || !Array.isArray(tools)) return nameMap;

  const originalNames = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') continue;
    const name = extractToolName(tool);
    if (name) {
      nameMap[name.toLowerCase()] = name;
      originalNames.push(name);
    }
  }

  let execTool = null;
  for (const name of originalNames) {
    const low = name.toLowerCase();
    if (/exec|command|bash|shell|run/i.test(low)) {
      execTool = name;
      break;
    }
  }

  const aliasMap = {
    'exec|command|bash|shell|run': ['bash', 'shell', 'terminal', 'run', 'execute', 'cmd'],
    'read|file|view|open|cat': ['read_file', 'readfile', 'open_file', 'cat', 'read'],
    'list|dir|ls|glob|find': ['list_files', 'listfiles', 'ls', 'find', 'glob', 'list'],
    'write|save|create': ['write_file', 'writefile', 'save_file', 'create_file', 'write', 'write_stdin'],
    'edit|patch|modify|update': ['edit_file', 'apply_patch', 'patch', 'edit'],
    'search|grep|find_text': ['search', 'grep', 'search_files'],
  };

  for (const name of originalNames) {
    const low = name.toLowerCase();
    for (const [pattern, aliases] of Object.entries(aliasMap)) {
      const keys = pattern.split('|');
      if (keys.some((k) => low.includes(k))) {
        for (const alias of aliases) {
          if (!(alias in nameMap)) nameMap[alias] = name;
        }
      }
    }
  }

  if (execTool) nameMap['__default__'] = execTool;
  return nameMap;
}

/**
 * 构建工具参数名映射：tool_name -> { 别名 -> 实际名 }
 */
export function buildToolParamNameMap(tools) {
  const result = {};
  if (!tools || !Array.isArray(tools)) return result;

  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') continue;
    const name = extractToolName(tool);
    if (!name) continue;
    const props = extractToolProps(tool);
    if (!props) continue;

    const actual = Object.keys(props);
    const pmap = {};
    for (const p of actual) {
      const low = p.toLowerCase();
      pmap[low] = p;
      if (low === 'cmd') pmap['command'] = p;
      else if (low === 'command') pmap['cmd'] = p;
      if (low === 'file_path' || low === 'filepath') { pmap['path'] = p; pmap['file'] = p; }
      else if (low === 'path') { pmap['file_path'] = p; pmap['filepath'] = p; }
      if (low === 'content') { pmap['text'] = p; pmap['data'] = p; pmap['body'] = p; }
      else if (low === 'text') { pmap['content'] = p; pmap['data'] = p; }
      if (low === 'description') pmap['desc'] = p;
      else if (low === 'desc') pmap['description'] = p;
    }
    if (Object.keys(pmap).length > 0) {
      result[name] = pmap;
      result[name.toLowerCase()] = pmap;
    }
  }
  return result;
}

function extractToolProps(tool) {
  for (const k of ['parameters', 'input_schema', 'inputSchema', 'schema']) {
    const schema = tool[k];
    if (schema && typeof schema === 'object') {
      const props = schema.properties;
      if (props && typeof props === 'object') return props;
    }
  }
  const func = tool.function || {};
  for (const k of ['parameters', 'input_schema', 'inputSchema', 'schema']) {
    const schema = func[k];
    if (schema && typeof schema === 'object') {
      const props = schema.properties;
      if (props && typeof props === 'object') return props;
    }
  }
  return null;
}

/**
 * 修复参数名：将 DeepSeek 输出的别名参数名映射回 schema 定义名
 */
export function fixParamNames(toolName, argsJson, paramMap) {
  if (!toolName || !argsJson) return argsJson;
  const pmap = paramMap[toolName] || paramMap[toolName && toolName.toLowerCase()];
  if (!pmap) return argsJson;

  let parsed;
  try {
    parsed = JSON.parse(argsJson);
  } catch {
    return argsJson;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return argsJson;

  const fixed = {};
  let changed = false;
  for (const [k, v] of Object.entries(parsed)) {
    const mapped = pmap[k.toLowerCase()];
    if (mapped && mapped !== k) {
      fixed[mapped] = v;
      changed = true;
    } else {
      fixed[k] = v;
    }
  }
  return changed ? JSON.stringify(fixed) : argsJson;
}

// ──────────────────────────────────────────────────────────────
// 流式解析器：ToolCallStreamParser
// ──────────────────────────────────────────────────────────────

const CODE_FENCE_RE = /```/;
const TOOL_CALLS_START_RE = /<\|?DSML\|?tool_calls\s*>/i;
const TOOL_CALLS_END_RE = /<\/\|?DSML\|?tool_calls\s*>/i;
const INVOKE_START_RE = /<\|?DSML\|?invoke\s+name="([^"]+)"\s*>/i;
const INVOKE_END_RE = /<\/\|?DSML\|?invoke\s*>/i;
const PARAM_START_RE = /<\|?DSML\|?parameter\s+name="([^"]+)"[^>]*>/i;
const PARAM_END_RE = /<\/\|?DSML\|?parameter\s*>/i;

const MAX_CAPTURE_LEN = 8192;
const PARTIAL_TAG_PREFIXES = [
  '<|dsml|', '<|dsm', '<|ds', '<|d', '<|',
  '<![cdata[', '</', '<!', '<',
];

const State = { IDLE: 'IDLE', IN_CODE_BLOCK: 'IN_CODE_BLOCK', CAPTURING: 'CAPTURING' };

/**
 * DSML 流式解析器事件
 */
export class ToolCallStreamParser {
  constructor() {
    this.state = State.IDLE;
    this.buffer = '';
    this.hadToolCall = false;
  }

  /**
   * 喂入文本块，返回解析事件数组
   * @param {string} chunk
   * @returns {object[]} 事件数组 [{ type: 'text', chunk } | { type: 'tool_call_start', ... } | ...]
   */
  feed(chunk) {
    if (!chunk) return [];
    this.buffer += chunk;
    return this._drain();
  }

  /**
   * 流结束时调用，返回残余事件
   * @returns {object[]}
   */
  flush() {
    const events = [];
    if (this.buffer) {
      events.push({ type: 'text', chunk: this.buffer });
    }
    this.reset();
    return events;
  }

  reset() {
    this.state = State.IDLE;
    this.buffer = '';
  }

  _drain() {
    const events = [];
    let progress = true;
    while (progress && this.buffer) {
      progress = false;
      if (this.state === State.IDLE) {
        progress = this._processIdle(events);
      } else if (this.state === State.IN_CODE_BLOCK) {
        progress = this._processCodeBlock(events);
      } else if (this.state === State.CAPTURING) {
        progress = this._processCapturing(events);
      }
    }
    return events;
  }

  _processIdle(events) {
    const text = this.buffer;
    const fenceM = text.match(CODE_FENCE_RE);
    const tcM = text.match(TOOL_CALLS_START_RE);

    const fenceIdx = fenceM ? fenceM.index : Infinity;
    const tcIdx = tcM ? tcM.index : Infinity;

    if (fenceIdx < tcIdx && fenceM) {
      if (fenceIdx > 0) events.push({ type: 'text', chunk: text.slice(0, fenceIdx) });
      this.buffer = text.slice(fenceM.index + fenceM[0].length);
      this.state = State.IN_CODE_BLOCK;
      return true;
    }

    if (tcM) {
      if (tcIdx > 0) events.push({ type: 'text', chunk: text.slice(0, tcIdx) });
      this.buffer = text.slice(tcM.index + tcM[0].length);
      this.state = State.CAPTURING;
      return true;
    }

    const safeEnd = this._findSafeEnd(text);
    if (safeEnd > 0) {
      events.push({ type: 'text', chunk: text.slice(0, safeEnd) });
      this.buffer = text.slice(safeEnd);
      return true;
    }
    return false;
  }

  _processCodeBlock(events) {
    const m = this.buffer.match(CODE_FENCE_RE);
    if (!m) return false;
    if (m.index > 0) events.push({ type: 'text', chunk: this.buffer.slice(0, m.index) });
    this.buffer = this.buffer.slice(m.index + m[0].length);
    this.state = State.IDLE;
    return true;
  }

  _processCapturing(events) {
    const text = this.buffer;
    const m = text.match(TOOL_CALLS_END_RE);
    if (m) {
      const captured = text.slice(0, m.index);
      this._parseAndEmitToolCalls(captured, events);
      this.buffer = text.slice(m.index + m[0].length);
      this.state = State.IDLE;
      return true;
    }
    if (text.length > MAX_CAPTURE_LEN) {
      events.push({ type: 'text', chunk: text });
      this.buffer = '';
      this.state = State.IDLE;
      return true;
    }
    return false;
  }

  _parseAndEmitToolCalls(captured, events) {
    let pos = 0;
    let toolIndex = 0;
    let m;
    INVOKE_START_RE.lastIndex = 0;
    while ((m = INVOKE_START_RE.exec(captured)) !== null) {
      if (m.index < pos) continue;
      const toolName = m[1];
      const callId = 'call_' + crypto.randomUUID().replace(/-/g, '').slice(0, 8);
      this.hadToolCall = true;
      events.push({ type: 'tool_call_start', callId, name: toolName, toolIndex });

      const invokeStart = m.index + m[0].length;
      const endM = captured.slice(invokeStart).match(INVOKE_END_RE);
      let body;
      if (endM) {
        body = captured.slice(invokeStart, invokeStart + endM.index);
        pos = invokeStart + endM.index + endM[0].length;
      } else {
        body = captured.slice(invokeStart);
        pos = captured.length;
      }

      const argsJson = parseInvokeBodyToJson(body);
      if (argsJson && argsJson !== '{}') {
        events.push({ type: 'tool_call_delta', callId, toolIndex, argumentsDelta: argsJson });
      }

      events.push({ type: 'tool_call_end', callId, toolIndex });
      toolIndex++;
    }
  }

  _findSafeEnd(text) {
    const lastLt = text.lastIndexOf('<');
    if (lastLt < 0) return text.length;
    const suffix = text.slice(lastLt);
    if (!suffix) return lastLt;
    const lower = suffix.toLowerCase();
    if (PARTIAL_TAG_PREFIXES.some((p) => lower.startsWith(p))) {
      return lastLt;
    }
    return text.length;
  }
}

// ──────────────────────────────────────────────────────────────
// Prompt 构建辅助：将 messages + tools 拍平成 textarea 字符串
// 参考 deepseek-bridge/bridge/prompt_compat.py
// ──────────────────────────────────────────────────────────────

/**
 * 展平 Codex input 为 DeepSeek textarea 的纯文本 prompt
 * @param {object} params - { messages, tools, toolChoice, firstTurn, conversationId }
 * @param {object[]} params.messages - 消息数组
 * @param {object[]} [params.tools] - 工具定义
 * @param {string} [params.toolChoice] - 工具选择模式
 * @param {boolean} params.firstTurn - 是否首次请求
 * @returns {string}
 */
export function flattenToPrompt({ messages, tools, toolChoice, firstTurn }) {
  if (firstTurn) {
    return flattenFirstTurn(messages, tools, toolChoice);
  }
  return flattenContinuation(messages);
}

function flattenFirstTurn(messages, tools, toolChoice) {
  const systemParts = [];
  const historyParts = [];
  let latestUser = null;

  const msgs = [...messages];
  const lastUserIdx = lastIndex(msgs, (m) => m.role === 'user');

  for (let i = 0; i < msgs.length; i++) {
    const msg = msgs[i];
    if (msg.role === 'system') {
      if (msg.content) systemParts.push(msg.content);
      continue;
    }
    if (i === lastUserIdx && msg.role === 'user') {
      latestUser = msg.content || '';
      continue;
    }
    // Codex 会把环境/配置信息（当前目录、时间、可用工具等）作为 role:'user' 消息发过来
    // 应保留为 [USER] 历史而非塞入 [SYSTEM]，让模型区分指令与上下文
    if (msg.role === 'assistant' || msg.role === 'tool') {
      historyParts.push(formatHistoryMessage(msg));
    } else if (msg.role === 'user') {
      // 非最新 user 的环境上下文消息保留为 [USER] 历史
      historyParts.push(formatHistoryMessage(msg));
    }
  }

  const blocks = [];
  let systemText = systemParts.filter(Boolean).join('\n\n').trim();
  const toolsBlock = formatToolsSection(tools || []).trim();

  if (systemText || toolsBlock) {
    const merged = [systemText, toolsBlock].filter(Boolean).join('\n\n');
    blocks.push('[SYSTEM]\n' + merged + '\n[/SYSTEM]');
  }

  if (historyParts.length > 0) {
    blocks.push('[HISTORY]\n' + historyParts.join('\n\n') + '\n[/HISTORY]');
  }

  if (latestUser != null) {
    blocks.push(latestUser);
  } else if (historyParts.length === 0) {
    blocks.push('');
  }

  return blocks.join('\n\n').trim();
}

function flattenContinuation(messages) {
  // 取末尾 tool / user 消息
  const tail = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') break;
    tail.unshift(messages[i]);
  }

  if (tail.length === 0) {
    const lastUser = messages
      .slice()
      .reverse()
      .find((m) => m.role === 'user');
    return lastUser && lastUser.content ? lastUser.content : '';
  }

  const blocks = [];
  const toolOutputs = tail.filter((m) => m.role === 'tool');
  const userFollowups = tail.filter((m) => m.role === 'user');

  if (toolOutputs.length > 0) {
    blocks.push('[TOOL RESULTS]\n' + toolOutputs.map(formatToolOutput).join('\n\n') + '\n[/TOOL RESULTS]');
    if (userFollowups.length === 0) {
      blocks.push(
        '工具已执行完成，结果见上方 [TOOL RESULTS]。请直接基于结果继续推进任务：\n' +
        '- 如果还有未完成的步骤，立刻发起下一个 <|DSML|tool_calls> 调用执行下一步。\n' +
        '- 不要复述工具结果，不要询问用户是否继续。\n' +
        '- 仅当整个任务已完成或必须由用户补充信息时，才用自然语言回复。'
      );
    }
  }

  for (const m of userFollowups) {
    if (m.content) blocks.push(m.content);
  }

  return blocks.join('\n\n').trim();
}

function formatHistoryMessage(msg) {
  switch (msg.role) {
    case 'assistant':
      return `[ASSISTANT]\n${msg.content}\n[/ASSISTANT]`;
    case 'tool':
      return formatToolOutput(msg);
    case 'user':
      return `[USER]\n${msg.content}\n[/USER]`;
    default:
      return `[${msg.role.toUpperCase()}]\n${msg.content}\n[/${msg.role.toUpperCase()}]`;
  }
}

function formatToolOutput(msg) {
  const attrs = [];
  if (msg.name) attrs.push(`name="${msg.name.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`);
  if (msg.tool_call_id) attrs.push(`call_id="${msg.tool_call_id.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`);
  const attrStr = attrs.length > 0 ? ' ' + attrs.join(' ') : '';
  const body = (msg.content && msg.content.trim()) || '(tool executed successfully, no output)';
  return `[TOOL OUTPUT${attrStr}]\n${body}\n[/TOOL OUTPUT]`;
}

function lastIndex(arr, predicate) {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (predicate(arr[i])) return i;
  }
  return -1;
}
