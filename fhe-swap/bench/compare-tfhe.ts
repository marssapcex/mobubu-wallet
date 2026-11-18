import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { makeTfhe, TfheWorker, type TfheBackend } from "../src/fhe/tfhe.js";

const width = 16;
const balance = 50_000n;
const amount = 30_001n;
const repeats = 9;
const stats = async (worker: TfheBackend) => Number((await worker.raw("STATS")).split(" ")[1]);
const quantile = (values: number[], q: number) => [...values].sort((a, b) => a - b)[Math.ceil(q * values.length) - 1];

const { crypto: client } = await makeTfhe({ role: "client", width });
const evaluators: TfheBackend[] = [];
try {
  const { worker, crypto: evaluator } = await makeTfhe({ role: "evaluator", cloudKeyPath: client.getCloudPath(), width });
  evaluators.push(worker);
  if (process.env.TFHE_BASELINE_WORKER) {
    const baseline = new TfheWorker(process.env.TFHE_BASELINE_WORKER);
    evaluators.push(baseline);
    // Only run the historical binary as an evaluator with new locally generated keys.
    await baseline.raw("LOADCLOUD", client.getCloudPath());
  }
  const encrypted = await client.encrypt(balance);
  const rows = evaluators.map((worker, i) => ({
    name: i === 0 ? "current generic CONST+CMP" : "historical CONST+CMP",
    worker,
    run: async () => {
      const [, constant] = (await worker.raw("CONST", String(width), String(amount))).split(" ");
      const [size, blob] = (await worker.raw("CMP", "ge", String(width), encrypted.blob, constant)).split(" ");
      return { width: Number(size), blob, backend: "tfhe-cggi" as const, keyId: encrypted.keyId };
    },
  }));
  rows.unshift({ name: "optimized GE_CONST", worker, run: () => evaluator.geConst(encrypted, amount) });
  const all = rows.map(() => ({ ms: [] as number[], gates: [] as number[] }));
  const expected = balance >= amount ? 1n : 0n;
  for (const row of rows) assert.equal(await client.decrypt(await row.run()), expected); // warmup
  for (let sample = 0; sample < repeats; sample++) {
    for (let ordinal = 0; ordinal < rows.length; ordinal++) {
      const i = (ordinal + sample) % rows.length;
      const row = rows[i];
      const before = await stats(row.worker);
      const start = performance.now();
      const result = await row.run();
      all[i].ms.push(performance.now() - start);
      all[i].gates.push(await stats(row.worker) - before);
      assert.equal(await client.decrypt(result), expected);
    }
  }
  console.log(`CGGI ${width}-bit comparison, ${repeats} warm samples per path. Setup/decryption excluded.`);
  console.table(rows.map(({ name }, i) => ({
    path: name,
    "p50 ms": quantile(all[i].ms, 0.5).toFixed(1),
    "p95 ms": quantile(all[i].ms, 0.95).toFixed(1),
    "nonlinear gate calls": [...new Set(all[i].gates)].join(","),
  })));
} finally {
  for (const worker of evaluators) worker.close();
  client.close();
}
