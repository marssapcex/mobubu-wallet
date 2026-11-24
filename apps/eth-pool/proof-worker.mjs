import { proveInWasm } from '/hcmtrail-native/pool/wasm.mjs';

self.onmessage = async ({ data: { plan, useCache } }) => {
  try {
    const load = async (path) => {
      const r = await fetch(path);
      if (!r.ok) throw new Error('Thiếu chương trình prover bản local.');
      return new Uint8Array(await r.arrayBuffer());
    };
    const [wasm, cache] = await Promise.all([load('./prover.wasm'), useCache ? load('./periodic.top') : undefined]);
    self.postMessage({ working: true });
    const result = await proveInWasm(wasm, plan, { cache, report: (phase, fraction) => self.postMessage({ phase, fraction }) });
    self.postMessage({ result });
  } catch {
    // Prover errors may contain witness fragments. Do not log or serialize them.
    self.postMessage({ error: 'Không tạo được proof trên thiết bị này. Giữ note và thử lại; chưa gửi giao dịch.' });
  } finally { self.close(); }
};
