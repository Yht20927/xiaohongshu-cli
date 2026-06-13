// lib/client/bridge-client.js — HTTP 客户端封装（CLI / Agent SDK 共用）

const http = require('http');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 19424;
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1000;

class BridgeClient {
  /**
   * @param {object} options
   * @param {string} [options.host='127.0.0.1']
   * @param {number} [options.port=19424]
   * @param {string} [options.token=''] - 访问令牌（也可从 XHS_BRIDGE_TOKEN 环境变量读取）
   */
  constructor(options = {}) {
    this.host = options.host || DEFAULT_HOST;
    this.port = options.port || DEFAULT_PORT;
    this.token = options.token || process.env.XHS_BRIDGE_TOKEN || '';
  }

  async call({ site, expression, awaitPromise = true, connIndex = 0, timeout }) {
    let lastErr;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await this._post('/api/call', {
          site, expression, awaitPromise, connIndex, timeout,
        });
      } catch (e) {
        lastErr = e;
        if (attempt < MAX_RETRIES && !e.message.includes('Bridge Server 未启动')) {
          await new Promise(r => setTimeout(r, RETRY_DELAY_MS * (attempt + 1)));
        }
      }
    }
    throw lastErr;
  }

  async status() {
    return this._get('/api/status');
  }

  async health() {
    return this._get('/api/health');
  }

  _post(path, body) {
    return this._request('POST', path, body);
  }

  _get(path) {
    return this._request('GET', path);
  }

  _request(method, path, body) {
    return new Promise((resolve, reject) => {
      const payload = body ? JSON.stringify(body) : null;

      const options = {
        hostname: this.host,
        port: this.port,
        path,
        method,
        headers: {
          'Content-Type': 'application/json',
        },
        timeout: 35000,
      };

      if (this.token) {
        options.headers['Authorization'] = `Bearer ${this.token}`;
      }

      if (payload) {
        options.headers['Content-Length'] = Buffer.byteLength(payload);
      }

      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`Invalid JSON response: ${data.slice(0, 200)}`));
          }
        });
      });

      req.on('error', (e) => {
        reject(new Error(`Bridge Server 未启动 (${this.host}:${this.port}) — 请先运行 node server.js`));
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });

      if (payload) {
        req.write(payload);
      }
      req.end();
    });
  }
}

module.exports = { BridgeClient };
