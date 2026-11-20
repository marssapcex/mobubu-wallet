import { describe, it, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TfheWorker, makeTfhe } from "../src/fhe/tfhe.js";

const WORKER = path.join(process.cwd(), "native", "bin", "tfhe_worker");

if (!fs.existsSync(WORKER)) {
  throw new Error(
    `tfhe worker not found at ${WORKER}; run "bash scripts/build-tfhe.sh" before tests`,
  );
}

const keys = fs.mkdtempSync(path.join(os.tmpdir(), "mobubu-tfhe-suite-"));
after(() => fs.rmSync(keys, { recursive: true, force: true }));
function cloudKeyPath(suffix: string): string { return path.join(keys, `${suffix}.key`); }

describe("TFHE worker (CGGI gate bootstrapping)", () => {
  let proc: TfheWorker | null = null;

  afterEach(() => {
    if (proc) {
      try {
        proc.close();
      } catch {
        /* ignore */
      }
      proc = null;
    }
  });

  it("PING / MODE / KEYGEN / STATS", async () => {
    proc = new TfheWorker(WORKER);
    assert.equal(await proc.raw("PING"), "PONG");
    assert.equal(await proc.raw("MODE"), "empty");
    const kg = await proc.raw("KEYGEN", "128", cloudKeyPath("kg"));
    assert.ok(kg.startsWith("client 128 "), kg);
    const st = await proc.raw("STATS");
    // "OK gates <N> linear <M>"
    const parts = st.split(" ");
    assert.equal(parts[0], "gates");
    assert.equal(Number(parts[1]), 0);
  });

  it("client encrypts; evaluator computes on ciphertexts without decrypting", async () => {
    proc = new TfheWorker(WORKER);
    const ck = cloudKeyPath("enc");
    const kg = await proc.raw("KEYGEN", "128", ck);
    assert.ok(kg.startsWith("client 128 "), kg);

    // Client encrypts two 9-bit values: 157 and 99.
    // raw() returns the payload after "OK ", so split yields [width, blob].
    const ea = (await proc.raw("ENC", "9", "157")).split(" ");
    const eb = (await proc.raw("ENC", "9", "99")).split(" ");
    const [wa, ba] = ea;
    const [wb, bb] = eb;
    assert.equal(wa, "9");
    assert.equal(wb, "9");

    // ADD: 157 + 99 = 256 (fits in 9 bits).  Worker binop: OP <w> <ba> <bb>.
    const add = (await proc.raw("ADD", "9", ba, bb)).split(" ");
    assert.equal(await decryptThrough(proc, Number(add[0]), add[1]), 256n);

    // MUL: 157 * 99 = 15543, output width 18 (= 9 + 9).
    const mul = (await proc.raw("MUL", "9", ba, "9", bb, "18")).split(" ");
    assert.equal(await decryptThrough(proc, Number(mul[0]), mul[1]), 15543n);

    // CMP lt: 157 < 99 => 0; gt => 1; eq => 0.  Worker: CMP <rel> <w> <ba> <bb>.
    const lt = (await proc.raw("CMP", "lt", "9", ba, bb)).split(" ");
    assert.equal(await decryptThrough(proc, Number(lt[0]), lt[1]), 0n);
    const gt = (await proc.raw("CMP", "gt", "9", ba, bb)).split(" ");
    assert.equal(await decryptThrough(proc, Number(gt[0]), gt[1]), 1n);
    const eq = (await proc.raw("CMP", "eq", "9", ba, bb)).split(" ");
    assert.equal(await decryptThrough(proc, Number(eq[0]), eq[1]), 0n);

    // MUX(sel encrypted 1, LSB=1) ? a : b => a = 157.  Worker: MUX <bsel> <w> <ba> <bb>.
    const sel = (await proc.raw("ENC", "1", "1")).split(" ");
    const mux = (await proc.raw("MUX", sel[1], "9", ba, bb)).split(" ");
    assert.equal(await decryptThrough(proc, Number(mux[0]), mux[1]), 157n);

    // MULCONST 157 * 3 = 471.
    const mc = (await proc.raw("MULCONST", "9", ba, "3", "12")).split(" ");
    assert.equal(await decryptThrough(proc, Number(mc[0]), mc[1]), 471n);

    // DIVCONST 157 / 7 = 22.
    const dc = (await proc.raw("DIVCONST", "9", ba, "7", "8")).split(" ");
    assert.equal(await decryptThrough(proc, Number(dc[0]), dc[1]), 22n);

    const st = await proc.raw("STATS");
    assert.ok(Number(st.split("gates ")[1].split(" ")[0]) > 0, st);
  });

  it("evaluator role refuses ENC/DEC but computes on ciphertexts", async (t) => {
    // Client produces a cloud key.
    const ck = cloudKeyPath("eval");
    const client = new TfheWorker(WORKER);
    t.after(() => client.close());
    const kg = await client.raw("KEYGEN", "128", ck);
    assert.ok(kg.startsWith("client 128 "), kg);

    proc = new TfheWorker(WORKER);
    const load = await proc.raw("LOADCLOUD", ck);
    assert.ok(load.startsWith("evaluator "), load);
    assert.equal(await proc.raw("MODE"), "evaluator");

    // Evaluator cannot encrypt or decrypt (holds only the cloud key).
    let threw = false;
    try {
      await proc.raw("ENC", "8", "1");
    } catch {
      threw = true;
    }
    assert.equal(threw, true);
    threw = false;
    try {
      await proc.raw("DEC", "8", "AAAA");
    } catch {
      threw = true;
    }
    assert.equal(threw, true);

    // Client encrypts two values; evaluator adds the ciphertexts.
    const ea = (await client.raw("ENC", "8", "10")).split(" ");
    const eb = (await client.raw("ENC", "8", "20")).split(" ");
    // Worker binop: ADD <w> <ba> <bb> (single width).
    const add = (await proc.raw("ADD", "8", ea[1], eb[1])).split(" ");
    const st = await proc.raw("STATS");
    assert.ok(Number(st.split("gates ")[1].split(" ")[0]) > 0, st);

    // Decrypt with the client to verify the evaluator's encrypted sum is correct.
    assert.equal(await decryptThrough(client, Number(add[0]), add[1]), 30n);

  });

  it("high-level TfheClient round-trips add/mul/cmp/mux", async () => {
    const { worker, crypto } = await makeTfhe({ role: "client", width: 9 });
    try {
      assert.equal((await crypto.params()).n, 630);

      const a = await crypto.encrypt(157n);
      const b = await crypto.encrypt(99n);
      assert.equal(a.backend, "tfhe-cggi");
      assert.equal(b.backend, "tfhe-cggi");

      assert.equal(await crypto.decrypt(await crypto.add(a, b)), 256n);
      assert.equal(await crypto.decrypt(await crypto.sub(a, b)), 58n);
      assert.equal(await crypto.decrypt(await crypto.mul(a, b)), 15543n);
      assert.equal(await crypto.decrypt(await crypto.cmp(a, b, "lt")), 0n);
      assert.equal(await crypto.decrypt(await crypto.cmp(a, b, "gt")), 1n);
      assert.equal(await crypto.decrypt(await crypto.cmp(a, b, "eq")), 0n);
      assert.equal(
        await crypto.decrypt(await crypto.mux(await crypto.cmp(a, b, "gt"), a, b)),
        157n,
      );
      assert.equal(await crypto.decrypt(await crypto.mulConst(a, 3n, 12)), 471n);
      assert.equal(await crypto.decrypt(await crypto.divConst(a, 7n, 8)), 22n);
      assert.equal(await crypto.decrypt(await crypto.div(a, b, 8)), 1n);
      assert.equal(await crypto.decrypt(await crypto.shr(a, 3)), 157n >> 3n);

      const st = await worker.raw("STATS");
      assert.ok(st.includes("gates "));
    } finally {
      worker.close();
    }
  });

  it("client params match the CGGI 128-bit parameter set", async () => {
    const { worker, crypto } = await makeTfhe({ role: "client" });
    try {
      const p = await crypto.params();
      assert.equal(p.n, 630);
      assert.equal(p.N, 1024);
      assert.equal(p.k, 1);
      assert.equal(p.l, 3);
      assert.equal(p.Bgbit, 7);
    } finally {
      worker.close();
    }
  });
});

async function decryptThrough(
  proc: TfheWorker,
  w: number,
  blob: string,
): Promise<bigint> {
  const payload = await proc.raw("DEC", String(w), blob);
  return BigInt(payload);
}
