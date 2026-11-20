import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BalanceCoprocessor } from "../src/fhe/coprocessor.js";
import { makeTfhe, TfheWorker } from "../src/fhe/tfhe.js";

const workerPath = join(process.cwd(), "native", "bin", "tfhe_worker");

describe("CGGI public threshold and worker boundaries", () => {
  it("computes unsigned threshold comparisons with exact width and gate counts", async () => {
    const { crypto: client } = await makeTfhe({ role: "client", width: 16 });
    const { worker: evaluator, crypto: cloud } = await makeTfhe({ role: "evaluator", cloudKeyPath: client.getCloudPath() });
    try {
      const a = await client.encrypt(50_000n);
      for (const [threshold, expected, gates] of [
        [0n, 1n, 0], [32_768n, 1n, 0], [30_001n, 1n, 15],
        [50_000n, 1n, 11], [50_001n, 0n, 15], [65_535n, 0n, 15],
      ] as const) {
        const before = Number((await evaluator.raw("STATS")).split(" ")[1]);
        const result = await cloud.geConst(a, threshold);
        assert.equal(result.width, 1);
        assert.equal(await client.decrypt(result), expected);
        assert.equal(Number((await evaluator.raw("STATS")).split(" ")[1]) - before, gates);
      }
      await assert.rejects(cloud.geConst(a, -1n), /bit width/);
      await assert.rejects(cloud.geConst(a, 65_536n), /bit width/);
      await assert.rejects(cloud.mux(a, a, a), /encrypted bit/);
      // Power-of-two division is a linear copy, and an oversized divisor has quotient zero.
      const stats = await evaluator.raw("STATS");
      assert.equal(await client.decrypt(await cloud.divConst(a, 8n)), 6_250n);
      assert.equal(await client.decrypt(await cloud.divConst(a, 65_537n)), 0n);
      assert.equal((await evaluator.raw("STATS")).split(" ")[1], stats.split(" ")[1]);
    } finally {
      cloud.close();
      client.close();
    }
  });

  it("uses ciphertext width instead of truncating the public threshold to 16 bits", async () => {
    const { crypto: client } = await makeTfhe({ role: "client", width: 64 });
    const coprocessor = await BalanceCoprocessor.create(client.getCloudPath());
    try {
      const max = (1n << 64n) - 1n;
      const encrypted = await client.encrypt(max);
      assert.equal(await client.decrypt(await coprocessor.checkBalance(encrypted, max)), 1n);
      await assert.rejects(coprocessor.checkBalance(encrypted, max + 1n), /bit width/);
    } finally {
      coprocessor.close();
      client.close();
    }
  });

  it("rejects malformed frames without desynchronizing; spawn/close errors settle promises", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mobubu-worker-test-"));
    const proc = new TfheWorker(workerPath);
    try {
      await assert.rejects(proc.raw("CONST", "1", "0"), /no evaluation key/);
      await assert.rejects(proc.raw("PING", "extra"), /unexpected arguments/);
      await assert.rejects(proc.raw("PING", "a\nb"), /protocol token/);
      assert.equal(await proc.raw("PING"), "PONG");
      const cloudPath = join(dir, "cloud.key");
      await proc.raw("KEYGEN", "128", cloudPath);
      assert.equal(statSync(cloudPath).mode & 0o777, 0o600);
      const [, ciphertext] = (await proc.raw("ENC", "1", "1")).split(" ");
      const malformed = Buffer.from(ciphertext, "base64");
      malformed.writeInt32LE(0, 0); // Wrong type tag, correct file size.
      await assert.rejects(proc.raw("DEC", "1", malformed.toString("base64")), /LWE sample/);
      assert.equal(await proc.raw("DEC", "1", ciphertext), "1");
      const pending = proc.raw("PING");
      proc.close();
      await assert.rejects(pending, /closed/);
      const missing = new TfheWorker(join(dir, "missing"));
      try {
        await assert.rejects(missing.raw("PING"));
      } finally {
        missing.close();
      }
    } finally {
      proc.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the native reader rejects oversized or unterminated frames without dispatching them", () => {
    for (const input of ["1 PING", `${"X".repeat(2 * 1024 * 1024 + 1)}\n`]) {
      const run = spawnSync(workerPath, [], { input, encoding: "utf8", timeout: 2_000 });
      assert.equal(run.status, 2, run.error?.message ?? run.stderr);
      assert.equal(run.stdout, "");
    }
  });

  it("a timed out worker settles all queued requests and is no longer usable", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "mobubu-worker-timeout-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const executable = join(dir, "stall");
    writeFileSync(executable, "#!/bin/sh\nexec sleep 20\n", { mode: 0o700 });
    const proc = new TfheWorker(executable, 100);
    t.after(() => proc.close());
    const settled = await Promise.allSettled([proc.raw("PING"), proc.raw("MODE")]);
    assert.ok(settled.every((result) => result.status === "rejected" && /timed out/.test(result.reason.message)));
    await assert.rejects(proc.raw("PING"), /closed/);
  });

  it("rejects cross-key ciphertexts before evaluation and removes temporary cloud copies", async (t) => {
    const { crypto: a } = await makeTfhe({ role: "client", width: 1 });
    t.after(() => a.close());
    const { crypto: b } = await makeTfhe({ role: "client", width: 1 });
    t.after(() => b.close());
    const key1 = a.getCloudPath(), key2 = b.getCloudPath();
    const { crypto: cloud, worker: evaluator } = await makeTfhe({ role: "evaluator", cloudKeyPath: key1 });
    t.after(() => cloud.close());
    try {
      const one = await a.encrypt(1n);
      const two = await a.encrypt(1n);
      assert.notEqual(one.blob, two.blob);
      const foreign = await b.encrypt(0n);
      assert.notEqual(one.keyId, foreign.keyId);
      const stats = await evaluator.raw("STATS");
      await assert.rejects(a.decrypt(foreign), /different key/);
      await assert.rejects(cloud.add(one, foreign), /different key/);
      await assert.rejects(cloud.geConst({ ...one, blob: "AAAA" }, 1n), /encoding or length/);
      await assert.rejects(cloud.loadCloudKey(key2), /already loaded/);
      assert.equal(await evaluator.raw("STATS"), stats);
      const answer = await cloud.geConst(one, 1n);
      assert.equal(answer.keyId, one.keyId);
      assert.equal(await a.decrypt(answer), 1n);
    } finally {
      a.close();
      b.close();
    }
    assert.equal(existsSync(key1), false);
    assert.equal(existsSync(key2), false);
  });
});
