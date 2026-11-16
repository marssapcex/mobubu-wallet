import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import * as fs from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import {
  CoprocessorNode,
  CoprocessorNetwork,
  buildWithdrawalPacket,
} from "../../src/fhe/coprocessor.js";

const WORKER = path.join(process.cwd(), "native", "bin", "tfhe_worker");

if (!fs.existsSync(WORKER)) {
  throw new Error(
    `tfhe worker not found at ${WORKER}; run "bash scripts/build-tfhe.sh" before tests`,
  );
}

function spawnWorker() {
  const proc = spawn(WORKER, [], {
    env: { ...process.env, LC_ALL: "C" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buf = "";
  const pending = new Map<number, { resolve: (v: string) => void; reject: (e: Error) => void }>();
  let nextId = 1;

  proc.stdout!.on("data", (d) => {
    buf += d.toString();
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim() === "") continue;
      const sp = line.indexOf(" ");
      const id = Number(line.slice(0, sp));
      const rest = line.slice(sp + 1);
      const pend = pending.get(id);
      if (!pend) continue;
      pending.delete(id);
      if (rest.startsWith("OK ")) pend.resolve(rest.slice(3));
      else pend.reject(new Error(`tfhe request ${id} failed: ${rest.slice(4)}`));
    }
  });

  proc.on("close", (code) => {
    for (const { reject } of pending.values()) {
      reject(new Error(`tfhe worker exited (code ${code})`));
    }
    pending.clear();
  });

  async function raw(op: string, ...args: string[]): Promise<string> {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try {
        proc.stdin!.write([id, op, ...args].join(" ") + "\n");
      } catch (err) {
        pending.delete(id);
        reject(err);
      }
    });
  }

  function close(): void {
    try { proc.stdin!.write("QUIT\n"); } catch { /* ignore */ }
    try { proc.kill(); } catch { /* ignore */ }
  }

  return { raw, close };
}

async function encryptNumber(
  worker: ReturnType<typeof spawnWorker>,
  value: bigint | number,
  width: number
): Promise<string> {
  const v = typeof value === "bigint" ? value.toString() : String(value);
  const payload = await worker.raw("ENC", String(width), v);
  const toks = payload.split(" ");
  return toks[1];
}

async function decryptNumber(
  worker: ReturnType<typeof spawnWorker>,
  width: number,
  blob: string
): Promise<bigint> {
  const payload = await worker.raw("DEC", String(width), blob);
  return BigInt(payload);
}

function toHex(str: string): string {
  return Buffer.from(str, "utf8").toString("hex");
}

function toHash(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    const char = input.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return "0x" + (hash >>> 0).toString(16).padStart(64, "0");
}

/** Mock vault per asset (mirrors Solidity AnonymousVault) */
class Vault {
  totalLocked = 0n;
  commitments = new Set<string>();
  spentNullifiers = new Set<string>();
  latestRoot = "0x0000000000000000000000000000000000000000000000000000000000000000";

  deposit(amount: bigint, commitment: string, nullifierHash: string) {
    assert.ok(amount > 0, "amount must be positive");
    assert.ok(!this.commitments.has(commitment), "commitment exists");
    assert.ok(!this.spentNullifiers.has(nullifierHash), "nullifier spent");
    this.commitments.add(commitment);
    this.totalLocked += amount;
  }

  withdraw(
    recipient: string,
    amount: bigint,
    nullifierHash: string,
    commitment: string,
    zkProof: string,
    thresholdSigs: string,
  ) {
    assert.ok(!this.spentNullifiers.has(nullifierHash), "nullifier already spent");
    assert.ok(this.commitments.has(commitment), "commitment does not exist");
    assert.ok(zkProof.length > 0, "invalid ZK proof");
    assert.ok(thresholdSigs.length > 0, "missing threshold signatures");
    assert.ok(this.totalLocked >= amount, "insufficient funds");

    this.spentNullifiers.add(nullifierHash);
    this.commitments.delete(commitment);
    this.totalLocked -= amount;
    return { recipient, amount, success: true };
  }

  isSpent(nullifierHash: string) {
    return this.spentNullifiers.has(nullifierHash);
  }
}

describe("Cross-chain swap (FHE 16-bit + ZK + vault + threshold)", () => {
  const ASSETS = ["BTC", "ETH", "XMR", "ZEC", "DAI"] as const;
  let vaults = new Map<string, Vault>();

  afterEach(() => {
    vaults = new Map();
    for (const a of ASSETS) vaults.set(a, new Vault());
  });

  it("per-asset: deposit, FHE CMP check, ZK + vault withdraw, block double-spend", async () => {
    vaults = new Map();
    for (const a of ASSETS) vaults.set(a, new Vault());

    const ck = `/tmp/cc-swap-test-cloud-${process.pid}-${Date.now()}.key`;
    const worker = spawnWorker();
    const kgPayload = await worker.raw("KEYGEN", "128", ck);
    assert.ok(kgPayload.startsWith("client 128 "), kgPayload);

    for (const asset of ASSETS) {
      const vault = vaults.get(asset);
      assert.ok(vault, `${asset} vault should exist`);

      // Deposit amount fits 16-bit (<= 65535)
      const depositAmount = 10_000n;
      const secret = toHex(`${asset}_secret`);
      const nullifier = toHex(`${asset}_nullifier`);
      const commitment = toHex(`commitment:${nullifier}:${secret}`);
      const nullifierHash = toHash(`nullifierHash:${nullifier}`);

      // FHE encrypt deposit amount
      const encBlob = await encryptNumber(worker, depositAmount, 16);
      assert.ok(encBlob.length > 0, `${asset}: FHE encrypt`);

      vault.deposit(depositAmount, commitment, nullifierHash);

      // Withdraw half
      const withdrawAmount = 4_000n;
      const recipient = `0x${asset}_recipient`;

      // Evaluator checks encrypted_balance >= withdraw_amount
      const evalWorker = spawnWorker();
      const loadPayload = await evalWorker.raw("LOADCLOUD", ck);
      assert.ok(loadPayload.startsWith("evaluator "), loadPayload);

      const encWithdrawBlob = await encryptNumber(worker, withdrawAmount, 16);
      const cmpPayload = await evalWorker.raw("CMP", "ge", "16", encBlob, encWithdrawBlob);
      const cmpToks = cmpPayload.split(" ");
      const cmpResult = await decryptNumber(worker, Number(cmpToks[0]), cmpToks[1]);
      assert.equal(cmpResult, 1n, `${asset}: FHE CMP balance >= amount`);

      // ZK proof mock + threshold sigs
      const zkProof = Buffer.from(`mock_zk_${asset}`).toString("hex");
      const thresholdSigs = Buffer.from(`mock_sigs_${asset}`).toString("hex");

      const packet = buildWithdrawalPacket(
        { nullifierHash, commitment, amount: withdrawAmount, encryptedAmountFHE: encBlob, root: vault.latestRoot, recipient },
        zkProof,
        thresholdSigs,
        true,
      );

      const result = vault.withdraw(recipient, withdrawAmount, nullifierHash, commitment, packet.zkProof, packet.thresholdSigs);
      assert.equal(result.success, true);
      assert.equal(result.amount, withdrawAmount);
      assert.ok(vault.isSpent(nullifierHash), `${asset}: nullifier spent`);
      assert.equal(vault.totalLocked, depositAmount - withdrawAmount);

      // Double-spend blocked
      assert.throws(() => {
        vault.withdraw(recipient, withdrawAmount, nullifierHash, commitment, packet.zkProof, packet.thresholdSigs);
      }, /nullifier already spent/);

      console.log(`[${asset}] deposit=${depositAmount}, withdraw=${withdrawAmount}, remaining=${vault.totalLocked}`);

      evalWorker.close();
    }

    try { fs.unlinkSync(ck); } catch { /* ignore */ }
    worker.close();
  });

  it("Threshold network 3-of-5 across all 5 chains", () => {
    const network = new CoprocessorNetwork(3);
    const nodes = ASSETS.map((a) => new CoprocessorNode(`node-${a}`));
    for (const node of nodes) network.addNode(node);

    const hash = "0xcrosschain-swap";
    // 2 votes < threshold 3
    network.submitVote(hash, true, nodes[0].nodeId);
    network.submitVote(hash, true, nodes[1].nodeId);
    assert.equal(network.isThresholdMet(hash), false);

    // 3 votes == threshold 3
    network.submitVote(hash, true, nodes[2].nodeId);
    assert.equal(network.isThresholdMet(hash), true);

    const consensus = network.getConsensus(hash);
    assert.equal(consensus.valid, true);
    assert.equal(consensus.votes, 3);
    assert.equal(consensus.total, 3);
    assert.equal(network.getNodeCount(), 5);
  });
});
