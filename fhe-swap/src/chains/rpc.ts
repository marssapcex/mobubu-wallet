/**
 * Minimal JSON-RPC client for node-backed adapters.
 * Keep credentials out of source; load from environment/secret store.
 */
export interface JsonRpcConfig {
  url: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export class JsonRpcClient {
  private id = 0;

  constructor(private readonly cfg: JsonRpcConfig) {}

  async call<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.cfg.timeoutMs ?? 15_000,
    );
    try {
      const res = await fetch(this.cfg.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.cfg.headers ?? {}),
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: ++this.id,
          method,
          params,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`RPC HTTP ${res.status} for ${method}`);
      }
      const json = (await res.json()) as {
        result?: T;
        error?: { code: number; message: string };
      };
      if (json.error) {
        throw new Error(`RPC ${method}: ${json.error.message}`);
      }
      return json.result as T;
    } finally {
      clearTimeout(timeout);
    }
  }
}
