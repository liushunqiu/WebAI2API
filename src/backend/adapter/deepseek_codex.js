/**
 * @fileoverview DeepSeek Codex 适配器
 * @description 基于 deepseek_text.js，增加对 Codex 工具调用的支持。
 * 参考 deepseek-bridge/bridge/runtime.py + bridge/prompt_compat.py
 *
 * 职责：
 * 1. 接收 prompt + tools 定义，注入 DSML 格式到 textarea
 * 2. 监听 DeepSeek SSE 响应，解析 DSML 工具调用
 * 3. 返回 { text, reasoning, toolCalls, sessionId }
 */

import { sleep, humanType, safeClick, random, humanPause, startMouseJitter, postResponseReading, sendMessage } from '../engine/utils.js';
import { normalizePageError, waitForInput, gotoWithCheck } from '../utils/index.js';
import { logger } from '../../utils/logger.js';
import { parseDsmlFromText } from '../dsml.js';

const TARGET_URL = 'https://chat.deepseek.com/';
const INPUT_SELECTOR = 'textarea';
const HOST_PREFIX = 'https://chat.deepseek.com';

async function enterSessionLikeHuman(page, sessionId, meta = {}) {
  const targetPath = `/a/chat/s/${sessionId}`;
  const currentUrl = page.url();
  if (currentUrl.includes(targetPath)) {
    logger.debug('适配器', `已在目标会话 ${sessionId}，无需切换`, meta);
    return;
  }
  const onSameApp = currentUrl.startsWith(HOST_PREFIX);

  if (onSameApp) {
    const sidebarItem = page.locator(`a[href$="${targetPath}"]`).first();
    if (await sidebarItem.count().catch(() => 0)) {
      try {
        logger.info('适配器', `点击侧边栏会话 ${sessionId}`, meta);
        await safeClick(page, sidebarItem, { bias: 'random' });
        await sleep(600, 1200);
        if (page.url().includes(targetPath)) return;
      } catch (e) {
        logger.debug('适配器', `点击侧边栏失败，回退到 SPA pushState: ${e.message}`, meta);
      }
    }
    try {
      await page.evaluate((path) => {
        window.history.pushState({}, '', path);
        window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
      }, targetPath);
      await sleep(500, 1000);
      if (page.url().includes(targetPath)) return;
    } catch (e) {
      logger.debug('适配器', `pushState 失败，回退到 goto: ${e.message}`, meta);
    }
  }

  logger.info('适配器', `首次/跨域加载会话 ${sessionId}`, meta);
  await gotoWithCheck(page, `${TARGET_URL}a/chat/s/${sessionId}`);
}

async function startNewChatLikeHuman(page, meta = {}) {
  const onSameApp = page.url().startsWith(HOST_PREFIX);
  if (onSameApp) {
    const candidates = [
      page.getByRole('button', { name: /new chat|new conversation|开启新对话|新对话/i }),
      page.locator('a[href="/"]').first(),
      page.locator('[class*="new-chat" i]').first(),
    ];
    for (const loc of candidates) {
      try {
        if (await loc.count().catch(() => 0)) {
          logger.info('适配器', '点击 New Chat 按钮开启新会话', meta);
          await safeClick(page, loc, { bias: 'button' });
          await sleep(600, 1200);
          if (!/\/a\/chat\/s\//.test(page.url())) return;
        }
      } catch (e) {
        logger.debug('适配器', `New Chat 候选点击失败: ${e.message}`, meta);
      }
    }
    try {
      await page.evaluate(() => {
        window.history.pushState({}, '', '/');
        window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
      });
      await sleep(500, 1000);
      if (!/\/a\/chat\/s\//.test(page.url())) return;
    } catch (e) {
      logger.debug('适配器', `pushState 回首页失败: ${e.message}`, meta);
    }
  }

  logger.info('适配器', '回退到完整加载首页', meta);
  await gotoWithCheck(page, TARGET_URL);
}

/**
 * 切换功能按钮状态
 */
async function toggleButton(page, buttonName, targetState, meta = {}) {
  try {
    const btn = page.getByRole('button', { name: buttonName });
    const btnCount = await btn.count();
    if (btnCount === 0) {
      logger.debug('适配器', `未找到 ${buttonName} 按钮`, meta);
      return false;
    }
    const isSelected = await btn.evaluate((el) => el.classList.contains('ds-toggle-button--selected'));
    if (isSelected !== targetState) {
      logger.info('适配器', `切换 ${buttonName}: ${isSelected} -> ${targetState}`, meta);
      await safeClick(page, btn, { bias: 'button' });
      await humanPause(500, 1400);
      return true;
    }
    return true;
  } catch (e) {
    logger.warn('适配器', `切换 ${buttonName} 失败: ${e.message}`, meta);
    return false;
  }
}

/**
 * 根据模型配置切换按钮
 */
async function configureModel(page, modelConfig, meta = {}) {
  const thinking = modelConfig?.thinking || false;
  const search = modelConfig?.search || false;
  // 50% 概率打乱切换顺序，避免「永远 DeepThink→Search」的固定指纹
  const reversed = Math.random() < 0.5;
  if (reversed) {
    await toggleButton(page, 'Search', search, meta);
    await sleep(450, 1200);
    await toggleButton(page, 'DeepThink', thinking, meta);
    await sleep(450, 1200);
  } else {
    await toggleButton(page, 'DeepThink', thinking, meta);
    await sleep(450, 1200);
    await toggleButton(page, 'Search', search, meta);
    await sleep(450, 1200);
  }
}

/**
 * 执行文本+工具调用生成任务
 * @param {object} context - 浏览器上下文 { page, config }
 * @param {string} prompt - 展平后的提示词（含 DSML 工具定义）
 * @param {string[]} imgPaths - 图片路径数组
 * @param {string} [modelId] - 模型 ID
 * @param {object} [meta={}] - 日志元数据（含 tools, toolChoice, conversationId 等）
 * @returns {Promise<{text?: string, reasoning?: string, toolCalls?: object[], sessionId?: string, error?: string}>}
 */
async function generate(context, prompt, imgPaths, modelId, meta = {}) {
  const { page, config } = context;
  const waitTimeout = config?.backend?.pool?.waitTimeout ?? 120000;

  let stopJitter = null;
  try {
    const requestedSessionId = meta?.sessionId || null;

    if (requestedSessionId) {
      logger.info('适配器', `进入指定会话: ${requestedSessionId}`, meta);
      await enterSessionLikeHuman(page, requestedSessionId, meta);
      await waitForInput(page, INPUT_SELECTOR, { click: false });
      // 同会话多轮往返：消除「秒回」签名。Codex 场景下用户看着工具结果继续，
      // 间隔通常比闲聊短，3-8s 基础 + 10% 概率 12-25s 尾部覆盖偶尔走神。
      logger.debug('适配器', '同会话续轮：模拟读取与思考时间...', meta);
      await humanPause(3000, 8000, { lingerProb: 0.1, lingerMin: 12000, lingerMax: 25000 });
    } else {
      logger.info('适配器', '开启新会话...', meta);
      await startNewChatLikeHuman(page, meta);
      await waitForInput(page, INPUT_SELECTOR, { click: false });
      await humanPause(800, 2200, { lingerProb: 0.1, lingerMin: 2500, lingerMax: 5500 });

      // 切换模型模式
      try {
        const isExpert = modelId ? modelId.endsWith('-expert') || modelId.includes('-pro') || modelId.endsWith('-codex') : false;
        const targetType = isExpert ? 'expert' : 'default';
        const modeBtn = page.locator(`div[data-model-type="${targetType}"]`).first();
        if ((await modeBtn.count()) > 0) {
          logger.info('适配器', `切换 ${isExpert ? 'Expert' : 'Instant'} 模式...`, meta);
          await safeClick(page, modeBtn, { bias: 'button' });
          await humanPause(600, 1500);
        }
      } catch (e) {
        logger.debug('适配器', `模式切换异常: ${e.message}`, meta);
      }

      // 配置 thinking/search
      const modelConfig = manifest.models.find((m) => m.id === modelId);
      if (modelConfig) {
        await configureModel(page, modelConfig, meta);
      }
    }

    // 输入提示词
    logger.info('适配器', '输入提示词...', meta);
    await safeClick(page, INPUT_SELECTOR, { bias: 'input' });
    // 输入框拿到焦点后启动鼠标微移：覆盖打字→等响应→收尾整个长尾窗口
    stopJitter = startMouseJitter(page);
    await humanType(page, INPUT_SELECTOR, prompt);
    // 模拟"读一遍刚打的字" —— 拉宽区间，避免每次相近时长形成节奏指纹
    await sleep(1500, 4500);
    // 犹豫行为：30% 概率触发，从三种行为里随机选一种
    const hesitateRoll = Math.random();
    if (hesitateRoll < 0.30) {
      const branch = Math.floor(Math.random() * 3);
      if (branch === 0) {
        // 单空格 → 删除
        await page.keyboard.type(' ', { delay: random(80, 180) });
        await sleep(200, 600);
        await page.keyboard.press('Backspace');
        await sleep(300, 900);
      } else if (branch === 1) {
        // 多打 2-3 个字符再删
        const burst = 2 + Math.floor(Math.random() * 2);
        for (let i = 0; i < burst; i++) {
          await page.keyboard.type(' ', { delay: random(70, 160) });
        }
        await sleep(400, 1200);
        for (let i = 0; i < burst; i++) {
          await page.keyboard.press('Backspace', { delay: random(50, 130) });
        }
        await sleep(300, 900);
      } else {
        // 纯停顿，不操作（模拟看一眼别的地方）
        await sleep(1200, 3200);
      }
    }
    // 12% 概率额外加一次更长的「分心」停顿
    if (Math.random() < 0.12) {
      await sleep(3000, 8000);
    }

    // 启动 API 监听（同 deepseek_text.js）
    logger.debug('适配器', '启动 API 监听...', meta);

    let textContent = '';
    let thinkingContent = '';
    let isComplete = false;
    let isCollecting = false;
    let isCollectingThinking = false;

    const responsePromise = page.waitForResponse(
      async (response) => {
        const url = response.url();
        if (!url.includes('/api/v0/chat/completion')) return false;
        if (response.request().method() !== 'POST') return false;
        if (response.status() !== 200) return false;

        try {
          const body = await response.text();
          const lines = body.split('\n');

          for (const line of lines) {
            if (line.startsWith('event:') || !line.startsWith('data:')) continue;

            const dataStr = line.slice(5).trim();
            if (!dataStr || dataStr === '{}') continue;

            try {
              const data = JSON.parse(dataStr);

              // 处理 fragments 列表
              if (data.v?.response?.fragments && Array.isArray(data.v.response.fragments)) {
                for (const fragment of data.v.response.fragments) {
                  if (fragment.type === 'RESPONSE') {
                    isCollecting = true;
                    isCollectingThinking = false;
                    if (fragment.content) textContent += fragment.content;
                  } else if (fragment.type === 'THINK') {
                    isCollectingThinking = true;
                    isCollecting = false;
                    if (fragment.content) thinkingContent += fragment.content;
                  } else {
                    isCollecting = false;
                    isCollectingThinking = false;
                  }
                }
              }

              // APPEND 新增 fragment
              if (data.p === 'response/fragments' && data.o === 'APPEND' && Array.isArray(data.v)) {
                for (const fragment of data.v) {
                  if (fragment.type === 'RESPONSE') {
                    isCollecting = true;
                    isCollectingThinking = false;
                    if (fragment.content) textContent += fragment.content;
                  } else if (fragment.type === 'THINK') {
                    isCollectingThinking = true;
                    isCollecting = false;
                    if (fragment.content) thinkingContent += fragment.content;
                  } else {
                    isCollecting = false;
                    isCollectingThinking = false;
                  }
                }
              }

              // BATCH 操作
              if (data.o === 'BATCH' && data.p === 'response' && Array.isArray(data.v)) {
                for (const item of data.v) {
                  if (item.p === 'fragments' && item.o === 'APPEND' && Array.isArray(item.v)) {
                    for (const fragment of item.v) {
                      if (fragment.type === 'RESPONSE') {
                        isCollecting = true;
                        isCollectingThinking = false;
                        if (fragment.content) textContent += fragment.content;
                      } else if (fragment.type === 'THINK') {
                        isCollectingThinking = true;
                        isCollecting = false;
                        if (fragment.content) thinkingContent += fragment.content;
                      } else {
                        isCollecting = false;
                        isCollectingThinking = false;
                      }
                    }
                  }
                  if ((item.p === 'status' || item.p === 'quasi_status') && item.v === 'FINISHED') {
                    isComplete = true;
                  }
                }
              }

              // content 追加
              if (data.p && typeof data.v === 'string') {
                const match = data.p.match(/response\/fragments\/(-?\d+)\/content/);
                if (match) {
                  if (isCollecting) textContent += data.v;
                  else if (isCollectingThinking) thinkingContent += data.v;
                }
              }

              if (data.v && typeof data.v === 'string' && !data.p && !data.o) {
                if (isCollecting) textContent += data.v;
                else if (isCollectingThinking) thinkingContent += data.v;
              }

              if (data.p === 'response/status' && data.o === 'SET' && data.v === 'FINISHED') {
                isComplete = true;
              }
            } catch {}
          }

          return isComplete;
        } catch {
          return false;
        }
      },
      { timeout: waitTimeout }
    );

    // 发送提示词
    logger.debug('适配器', '发送提示词...', meta);
    // 按下 Enter 前留出一段「最后决定」时间，并有小概率二次犹豫
    await sleep(200, 700);
    if (Math.random() < 0.08) {
      await sleep(1500, 3500);
    }
    // 35% 概率点 Send 按钮，否则 Enter——分散单一发送行为指纹
    const sendVia = await sendMessage(page);
    logger.debug('适配器', `发送方式: ${sendVia}`, meta);
    logger.info('适配器', '等待生成结果...', meta);

    try {
      await responsePromise;
    } catch (e) {
      const pageError = normalizePageError(e, meta);
      if (pageError) return pageError;
      throw e;
    }

    // 收到回复后做一次「读」行为：滚动 / 停留，避免「响应即退出」的瞬时签名
    await postResponseReading(page);

    if (!textContent || textContent.trim() === '') {
      logger.warn('适配器', '回复内容为空', meta);
      return { error: '回复内容为空' };
    }

    logger.info('适配器', `已获取文本内容 (${textContent.length} 字符)`, meta);

    const trimmedText = textContent.trim();
    const trimmedThinking = thinkingContent.trim();

    // 解析 DSML 工具调用
    const { toolCalls, textParts } = parseDsmlFromText(trimmedText);
    const cleanText = textParts.join('').trim();

    logger.info('适配器', `解析到 ${toolCalls.length} 个工具调用`, meta);

    const result = {};
    if (cleanText) result.text = cleanText;
    if (trimmedThinking) result.reasoning = trimmedThinking;
    if (toolCalls.length > 0) result.toolCalls = toolCalls;

    // 只有在有实际文本或工具调用时才报告 sessionId
    await humanPause(1000, 2800, { lingerProb: 0.15, lingerMin: 2500, lingerMax: 5000 });
    const finalUrl = page.url();
    const sessionMatch = finalUrl.match(/\/a\/chat\/s\/([a-f0-9-]+)/);
    if (sessionMatch) {
      result.sessionId = sessionMatch[1];
      logger.info('适配器', `会话 ID: ${result.sessionId}`, meta);
    }

    logger.info('适配器', '生成完成', meta);
    return result;
  } catch (err) {
    const pageError = normalizePageError(err, meta);
    if (pageError) return pageError;
    logger.error('适配器', '生成任务失败', { ...meta, error: err.message });
    return { error: `生成任务失败: ${err.message}` };
  } finally {
    if (stopJitter) {
      try { await stopJitter(); } catch { /* ignore */ }
    }
  }
}

/**
 * 适配器 manifest
 */
export const manifest = {
  id: 'deepseek_codex',
  displayName: 'DeepSeek (Codex 工具调用)',
  description:
    '使用 DeepSeek 官网支持 Codex 工具调用，支持 DSML 格式的工具定义注入和解析。需要已登录的 DeepSeek 账户。',

  getTargetUrl(config, workerConfig) {
    return TARGET_URL;
  },

  models: [
    // Codex 模型 -> DeepSeek Pro (Expert 模式)
    { id: 'deepseek-codex', imagePolicy: 'forbidden', type: 'text' },
    { id: 'deepseek-codex-thinking', imagePolicy: 'forbidden', type: 'text', thinking: true },
    { id: 'deepseek-codex-search', imagePolicy: 'forbidden', type: 'text', search: true },
    { id: 'deepseek-codex-thinking-search', imagePolicy: 'forbidden', type: 'text', thinking: true, search: true },
    // DeepSeek 原生 Pro (Codex 使用)
    { id: 'deepseek-v4-pro', imagePolicy: 'forbidden', type: 'text' },
    { id: 'deepseek-v4-pro-search', imagePolicy: 'forbidden', type: 'text', search: true },
    // GPT 别名（Codex 客户端可能发送这些）
    { id: 'gpt-5-codex', imagePolicy: 'forbidden', type: 'text' },
    { id: 'gpt-5.1-codex', imagePolicy: 'forbidden', type: 'text' },
    { id: 'gpt-5.2-codex', imagePolicy: 'forbidden', type: 'text' },
    { id: 'gpt-5.3-codex', imagePolicy: 'forbidden', type: 'text', thinking: true },
    { id: 'gpt-5.4-codex', imagePolicy: 'forbidden', type: 'text'},
    { id: 'gpt-5.5-codex', imagePolicy: 'forbidden', type: 'text' },
    { id: 'gpt-5.1-codex-mini', imagePolicy: 'forbidden', type: 'text' },
    { id: 'gpt-5.1-codex-max', imagePolicy: 'forbidden', type: 'text' },
    { id: 'codex-mini-latest', imagePolicy: 'forbidden', type: 'text' },
    { id: 'claude-sonnet-4-6', imagePolicy: 'forbidden', type: 'text' },
    { id: 'claude-sonnet-4-5', imagePolicy: 'forbidden', type: 'text' },
    { id: 'claude-opus-4-6', imagePolicy: 'forbidden', type: 'text' },
    { id: 'claude-haiku-4-5', imagePolicy: 'forbidden', type: 'text' },
    { id: 'o3-mini', imagePolicy: 'forbidden', type: 'text' },
    { id: 'o4-mini', imagePolicy: 'forbidden', type: 'text' },
    { id: 'gpt-5', imagePolicy: 'forbidden', type: 'text' },
    { id: 'gpt-5.5', imagePolicy: 'forbidden', type: 'text' },
    { id: 'gpt-5.4', imagePolicy: 'forbidden', type: 'text' },
  ],

  navigationHandlers: [],

  generate,
};
