import { readFileSync, statSync } from 'node:fs';

export class RpcError extends Error {
  constructor(method, code) {
    super(`${method}: RPC error ${code}`); // Do not surface RPC response contents or auth.
    this.name = 'RpcError';
    this.code = code;
  }
}

/** Operator-supplied endpoint only. No URL, method, credentials or cookie path from an order. */
export function connectRpc(endpoint, { cookieFile, timeout = 20_000 } = {}) {
  const url = new URL(endpoint);
  const loopback = ['127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:'))) {
    throw new Error('configure HTTPS or an explicit loopback RPC, without URL credentials');
  }
  if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 120_000) throw new RangeError('invalid RPC timeout');
  let id = 0;
  return async (method, params = []) => {
    const headers = { 'content-type': 'application/json' };
    if (cookieFile) {
      const info = statSync(cookieFile);
      if (!info.isFile() || info.size > 512 || (info.mode & 0o077)) throw new Error('RPC cookie must be a protected file');
      headers.authorization = `Basic ${Buffer.from(readFileSync(cookieFile, 'utf8').trim()).toString('base64')}`;
    }
    const requestId = ++id;
    const response = await fetch(url, { method: 'POST', redirect: 'error', headers, signal: AbortSignal.timeout(timeout),
      body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) });
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel();
      throw new Error('operator RPC authentication failed');
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('missing RPC response');
    const chunks = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if ((size += value.length) > 8 * 1024 * 1024) throw new Error('RPC response exceeded limit');
        chunks.push(value);
      }
    } finally { await reader.cancel(); }
    let json;
    try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new Error(`${method}: invalid JSON-RPC response`); }
    if (json?.id !== requestId) throw new Error('RPC response ID mismatch');
    if (Number.isSafeInteger(json.error?.code)) throw new RpcError(method, json.error.code);
    if (!response.ok || !Object.hasOwn(json, 'result')) throw new Error(`${method}: invalid RPC result`);
    return json.result;
  };
}
