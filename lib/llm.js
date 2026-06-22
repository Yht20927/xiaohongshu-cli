// lib/llm.js — OpenAI-compatible LLM 调用封装
// 支持批量分析评论、生成回复建议。内置重试、防注入、三层 JSON 提取容错。
//
// API Key 优先级：环境变量 OPENAI_API_KEY > config.json llm.api_key
// 建议使用环境变量存储密钥，避免提交到版本控制。

let config = {};
try { config = require('../config.json').llm || {}; } catch {}

// 分批大小：防止评论过多导致 token 超限
const BATCH_SIZE = 50;

/**
 * 清洗用户评论内容，防止 prompt 注入
 * - 截断过长文本
 * - 移除可能的指令注入模式
 */
function sanitizeComment(text, maxLen = 200) {
  if (!text) return '';
  let s = String(text).slice(0, maxLen);
  s = s.replace(/\b(ignore|forget|disregard)\s+(all\s+)?(previous|above|prior)\s+(instructions?|prompts?|rules?)\b/gi, '[filtered]');
  s = s.replace(/\b(system|assistant|user)\s*:/gi, '[filtered]:');
  s = s.replace(/(忽略|忘记|无视)\s*(以上|之前|上述|前面)\s*(所有)?\s*(指令|规则|提示)/g, '[filtered]');
  return s;
}

class LLMClient {
  constructor(opts = {}) {
    this.apiKey = opts.api_key || opts.apiKey || process.env.OPENAI_API_KEY || config.api_key || '';
    this.baseUrl = (opts.base_url || opts.baseUrl || process.env.OPENAI_BASE_URL || config.base_url || 'https://api.openai.com/v1').replace(/\/+$/, '');
    this.model = opts.model || process.env.OPENAI_MODEL || config.model || 'gpt-4o-mini';
    this.maxRetries = opts.max_retries ?? opts.maxRetries ?? config.max_retries ?? 3;
    this.timeoutMs = opts.timeout_ms ?? opts.timeoutMs ?? config.timeout_ms ?? 60000;
    this.maxTokens = opts.max_tokens ?? opts.maxTokens ?? config.max_tokens ?? 4096;
  }

  async _call(messages, temperature = 0.3) {
    let lastError;
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        const resp = await fetch(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            model: this.model,
            messages,
            temperature,
            max_tokens: this.maxTokens,
          }),
          signal: controller.signal,
        });
        clearTimeout(timer);

        if (!resp.ok) {
          const err = await resp.text();
          throw new Error(`LLM API 请求失败 (HTTP ${resp.status}) — ${err.substring(0, 100)}`);
        }

        const data = await resp.json();
        const content = data.choices?.[0]?.message?.content || '';
        return content;
      } catch (e) {
        lastError = e;
        if (attempt < this.maxRetries) {
          console.error(`[llm] 重试 ${attempt}/${this.maxRetries}: ${e.message}`);
          await new Promise(r => setTimeout(r, 1000 * attempt));
        }
      }
    }
    throw lastError;
  }

  /**
   * 从 LLM 响应中提取 JSON（三级容错）
   * 1. 直接解析
   * 2. 提取 ```json``` 代码块
   * 3. 提取首个 [] 或 {} 边界
   */
  _extractJSON(text) {
    try { return JSON.parse(text); } catch {}

    const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (m) { try { return JSON.parse(m[1]); } catch {} }

    const ai = text.indexOf('[');
    const oi = text.indexOf('{');
    if (ai >= 0 && (oi < 0 || ai < oi)) {
      const li = text.lastIndexOf(']');
      if (li > ai) { try { return JSON.parse(text.substring(ai, li + 1)); } catch {} }
    }
    if (oi >= 0) {
      const ci = text.lastIndexOf('}');
      if (ci > oi) { try { return JSON.parse(text.substring(oi, ci + 1)); } catch {} }
    }

    throw new Error(`无法从 LLM 响应中提取 JSON: ${text.substring(0, 200)}`);
  }

  /**
   * 分批分析评论（每批最多 BATCH_SIZE 条）
   *
   * @param {Array} comments - 评论列表 [{ cid, text }]
   * @param {object|string} [strategy] - 策略文本或对象（{ style }）
   * @returns {Promise<Array>} [{ cid, sentiment, category, priority, summary }]
   */
  async analyzeComments(comments, strategy = {}) {
    const styleText = typeof strategy === 'string' ? strategy : (strategy.style || '自然亲切');
    const batches = [];
    for (let i = 0; i < comments.length; i += BATCH_SIZE) {
      batches.push(comments.slice(i, i + BATCH_SIZE));
    }

    if (batches.length > 1) {
      console.error(`[llm] 评论 ${comments.length} 条，分 ${batches.length} 批处理`);
    }

    const allResults = [];
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      if (batches.length > 1) {
        console.error(`[llm] 处理第 ${i + 1}/${batches.length} 批 (${batch.length} 条)...`);
      }

      const sanitized = batch.map(c => ({
        cid: c.cid,
        text: sanitizeComment(c.content || c.text || c.comment_text || ''),
      }));

      const prompt = `你是小红书评论分析师。根据策略风格分析每条评论。

策略风格：${styleText}

返回 JSON 数组。对每条评论：
- cid: 评论ID（原样）
- sentiment: "positive"|"negative"|"neutral"
- category: "question"|"praise"|"complaint"|"spam"|"other"
- priority: 1-5（5=必须回复）
- summary: 一句话中文摘要

评论列表：${JSON.stringify(sanitized)}

严格返回 JSON 数组，不要其他文字。`;

      const response = await this._call([
        { role: 'system', content: '你是一个专业的小红书评论分析师，只输出 JSON。' },
        { role: 'user', content: prompt },
      ]);

      const batchResults = this._extractJSON(response);
      if (Array.isArray(batchResults)) allResults.push(...batchResults);
    }

    return allResults;
  }

  /**
   * 分批生成回复建议
   *
   * @param {Array} comments - 需回复的评论 [{ cid, text|summary|comment_text, userTags? }]
   * @param {string|object} strategy - 策略文本或对象
   * @param {string} [noteDesc] - 笔记描述
   * @param {object} [context] - 历史反馈上下文
   * @param {Array<{srcText, replyText}>} [context.corpus] - 最近成功语料 few-shot
   * @param {Array<{signature, hitCount, exampleText, mitigation}>} [context.failures] - 避雷清单
   * @param {Array<string>} [context.avoid] - 不得复用的回复文本
   * @returns {Promise<Array>} [{ cid, reply }]
   */
  async suggestReplies(comments, strategy, noteDesc, context = {}) {
    const strategyText = typeof strategy === 'string' ? strategy : (strategy?.style || '自然亲切，15-50 字');

    const batches = [];
    for (let i = 0; i < comments.length; i += BATCH_SIZE) {
      batches.push(comments.slice(i, i + BATCH_SIZE));
    }

    if (batches.length > 1) {
      console.error(`[llm] 评论 ${comments.length} 条，分 ${batches.length} 批生成回复`);
    }

    // ── 历史上下文片段 ──
    const corpus = Array.isArray(context.corpus) ? context.corpus.slice(0, 20) : [];
    const failurePatterns = Array.isArray(context.failures) ? context.failures.slice(0, 10) : [];
    const avoidList = Array.isArray(context.avoid) ? context.avoid.slice(0, 30) : [];

    const corpusBlock = corpus.length === 0 ? '' :
      `\n## 历史成功回复（few-shot，参考语气和切入角度，不要原句复制）：\n` +
      corpus.map((c, i) => {
        const src = sanitizeComment(c.srcText || '', 80);
        const rep = sanitizeComment(c.replyText || '', 80);
        return `${i + 1}. 用户:「${src}」 → 我们回:「${rep}」`;
      }).join('\n') + '\n';

    const failureBlock = failurePatterns.length === 0 ? '' :
      `\n## 历史失败模式（避免触发，hit_count=触发次数）：\n` +
      failurePatterns.map((f, i) => {
        const ex = sanitizeComment(f.exampleText || '', 60);
        const mit = f.mitigation ? `（缓解: ${f.mitigation}）` : '';
        return `${i + 1}. ${f.signature} × ${f.hitCount}${mit}${ex ? ` 例: 「${ex}」` : ''}`;
      }).join('\n') + '\n';

    const avoidBlock = avoidList.length === 0 ? '' :
      `\n## 严禁复用（这些原文已发过，必须重新组织措辞）：\n` +
      avoidList.map((t, i) => `${i + 1}. ${sanitizeComment(t, 80)}`).join('\n') + '\n';

    const allResults = [];
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      if (batches.length > 1) {
        console.error(`[llm] 处理第 ${i + 1}/${batches.length} 批 (${batch.length} 条)...`);
      }

      const sanitized = batch.map(c => ({
        cid: c.cid,
        text: sanitizeComment(c.summary || c.comment_text || c.text || ''),
        ...(Array.isArray(c.userTags) && c.userTags.length ? { user_tags: c.userTags.slice(0, 5) } : {}),
      }));

      const prompt = `你是小红书账号运营助手，为以下评论生成回复建议。

策略风格：${strategyText}
笔记描述：${noteDesc || '暂无'}
${corpusBlock}${failureBlock}${avoidBlock}
返回 JSON 数组：
- cid: 评论ID
- reply: 建议回复（符合策略风格，不要原句复制历史回复，不要触发失败模式，不要复读"严禁复用"清单）
- 不需要回复的评论不要包含

需回复的评论（user_tags 表示该用户的画像标签，可酌情个性化）：${JSON.stringify(sanitized)}

严格返回 JSON 数组。`;

      const response = await this._call([
        { role: 'system', content: '你是小红书运营助手，只输出 JSON 回复建议。' },
        { role: 'user', content: prompt },
      ]);

      const batchResults = this._extractJSON(response);
      if (Array.isArray(batchResults)) allResults.push(...batchResults);
    }

    return allResults;
  }

  /**
   * 单条回复重写（用于 dedup 命中后再生成一次）。
   */
  async rewriteReply(srcText, originalReply, strategy, noteDesc) {
    const strategyText = typeof strategy === 'string' ? strategy : (strategy?.style || '自然亲切，15-50 字');
    const prompt = `你之前给评论「${sanitizeComment(srcText || '', 80)}」生成的回复是「${sanitizeComment(originalReply || '', 80)}」，但这句话我们已经发过了。请用完全不同的角度/措辞重写一遍。

策略风格：${strategyText}
笔记描述：${noteDesc || '暂无'}

仅返回新的回复文本，不要任何前缀、引号或解释。`;
    const response = await this._call([
      { role: 'system', content: '你是小红书运营助手，只输出新的一句话回复。' },
      { role: 'user', content: prompt },
    ], 0.7);
    return String(response || '').trim().replace(/^["「'']|["」'']$/g, '');
  }
}

module.exports = { LLMClient, sanitizeComment };
