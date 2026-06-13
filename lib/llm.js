// lib/llm.js — OpenAI-compatible LLM 封装

const https = require('https');

const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

class LLMClient {
  constructor(config = {}) {
    this.apiKey = config.api_key || process.env.OPENAI_API_KEY || '';
    this.baseUrl = config.base_url || DEFAULT_BASE_URL;
    this.model = config.model || DEFAULT_MODEL;
    this.maxTokens = config.max_tokens || 4096;
    this.timeoutMs = config.timeout_ms || 60000;
    this.maxRetries = config.max_retries ?? 3;
  }

  _request(url, body) {
    return new Promise((resolve, reject) => {
      const isHttps = url.startsWith('https');
      const mod = isHttps ? https : require('http');
      const parsed = new URL(url);

      const req = mod.request({
        ...new URL(url),
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Length': Buffer.byteLength(JSON.stringify(body)),
        },
        timeout: this.timeoutMs,
        rejectUnauthorized: false,
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error(`LLM request timeout after ${this.timeoutMs}ms`)); });

      let data = '';
      req.on('data', chunk => { data += chunk; });
      req.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`LLM invalid response: ${data.slice(0, 200)}`)); }
      });
      req.write(JSON.stringify(body));
      req.end();
    });
  }

  async _chat(messages, retries = 0) {
    const url = `${this.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    try {
      return await this._request(url, {
        model: this.model,
        messages,
        max_tokens: this.maxTokens,
      });
    } catch (e) {
      const msg = (e && e.message) || String(e) || (e && e.code) || 'LLM request failed';
      if (retries < this.maxRetries && /timeout|ECONNRESET|ECONNREFUSED/i.test(msg)) {
        return this._chat(messages, retries + 1);
      }
      throw new Error('LLM request failed: ' + msg);
    }
  }

  async _parseChoice(resp) {
    const choice = resp?.choices?.[0];
    if (!choice?.message?.content) {
      throw new Error('LLM response has no content');
    }
    return choice.message.content.trim();
  }

  async analyzeComments(comments) {
    const prompt = this._buildAnalyzePrompt(comments);
    const text = await this._chat([
      { role: 'system', content: '你是一个社交媒体运营助手，负责分析评论情感、分类和回复优先级。请只返回 JSON 数组，不要返回其他内容。' },
      { role: 'user', content: prompt },
    ]);
    return this._parseJson(text);
  }

  async suggestReplies(analysis, strategy) {
    const prompt = this._buildSuggestPrompt(analysis, strategy);
    const text = await this._chat([
      { role: 'system', content: '你是一个社交媒体运营助手，根据策略为评论生成自然回复。请只返回 JSON 数组，不要返回其他内容。' },
      { role: 'user', content: prompt },
    ]);
    return this._parseJson(text);
  }

  _buildAnalyzePrompt(comments) {
    const samples = comments.slice(0, 50).map((c, i) =>
      `${i + 1}. [${c.user?.nickname || 'anon'}] ${c.content || c.text || c.comment_text || JSON.stringify(c)}`
    ).join('\n');
    return `分析以下小红书笔记的评论，返回 JSON 数组：
[
  {"cid": "评论ID", "sentiment": "positive|neutral|negative", "category": "提问|夸赞|批评|建议|无关|其他", "priority": 1-5, "summary": "一句话总结"}
]

评论列表：
${samples}
返回至少包含所有 ${comments.length} 条评论的分析结果。`;
  }

  _buildSuggestPrompt(analysis, strategy) {
    const toReply = analysis.filter(a => a.priority >= 1 && a.sentiment !== 'negative').slice(0, 30);
    const items = toReply.map(a =>
      `- [${a.sentiment}] priority=${a.priority} "${a.summary || a.comment_text || ''}"`
    ).join('\n');

    return `根据以下策略，为需要回复的评论生成回复建议：

策略：
${strategy || '(无特定策略，使用自然友好的语气)'}

需回复的评论：
${items || '(无)'}

返回 JSON 数组：
[
  {"cid": "评论ID", "priority": N, "sentiment": "...", "reply": "建议回复内容"},
  ...
]
每条回复不超过 50 字，语气自然友好。`;
  }

  _parseJson(text) {
    // 尝试从可能包含 markdown 的代码块中提取 JSON
    const match = text.match(/\[[\s\S]*\]/);
    const jsonStr = match ? match[0] : text;
    try {
      return JSON.parse(jsonStr);
    } catch {
      // 尝试修复常见的 JSON 问题
      try {
        const fixed = jsonStr
          .replace(/,\s*}/g, '}')
          .replace(/,\s*]/g, ']')
          .replace(/[^[\]{}.,:\d\t\n\r ]+"(\s+)[^"[\]{}.,:\d\t\n ]*"/g, '"');
        return JSON.parse(fixed);
      } catch {
        console.error('[LLM] JSON parse failed, returning empty array');
        return [];
      }
    }
  }
}

module.exports = { LLMClient };
