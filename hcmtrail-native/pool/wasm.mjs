const proverJSON = (x) => JSON.stringify(x, (_, v) => typeof v === 'bigint' ? JSON.rawJSON(`${v}`) : v);

// No WASI, I/O, filesystem, or network imports. Only progress leaves the instance.
export async function proveInWasm(wasm, plan, { cache = new Uint8Array(), report = () => {} } = {}) {
  const { instance } = await WebAssembly.instantiate(wasm, { hcmtrail: { progress: report } });
  const { memory, alloc, prove } = instance.exports;
  const encoder = new TextEncoder();
  const request = encoder.encode(proverJSON(plan.request));
  const seed = encoder.encode(proverJSON(plan.seed));
  const entropy = crypto.getRandomValues(new Uint8Array(512));
  const length = request.length + seed.length + entropy.length + cache.length;
  const at = alloc(length) >>> 0;
  if (at === 0) throw new Error('Thiết bị không đủ bộ nhớ để tạo proof.');
  const bytes = new Uint8Array(memory.buffer, at, length);
  bytes.set(request);
  bytes.set(seed, request.length);
  bytes.set(entropy, request.length + seed.length);
  bytes.set(cache, request.length + seed.length + entropy.length);
  const result = prove(at, request.length, seed.length, cache.length);
  // Memory may have grown; do not reuse the old ArrayBuffer. The caller discards
  // the entire instance/worker to release private memory and working buffers.
  const answer = new TextDecoder().decode(new Uint8Array(memory.buffer,
    Number(BigInt.asUintN(32, result)), Number(result >> 32n)));
  const sep = answer.indexOf('\n');
  if (sep <= 0 || !answer.startsWith('0x')) throw new Error('Prover từ chối witness hoặc hết tài nguyên. Không gửi giao dịch.');
  return { proof: answer.slice(0, sep), publicAndChange: answer.slice(sep + 1) };
}
