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

/**
 * Tạo worker process + hàm raw request khớp theo id.
 */
function spawnWorker() {
  const proc = spawn(WORKER, [], {
    env: { ...process.env, LC_ALL: "C" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buf = "";
  const pending = new Map<number, {
    resolve: (v: string) => void;
    reject: (e: Error) => void;
  }>();
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
    try {
      proc.stdin!.write("QUIT\n");
    } catch {
      /* ignore */
    }
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
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
  const toks = payload.split(" "); // "<width> <blob>"
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

/**
 * Mock AnonymousVault state (in-memory) mô phỏng hành vi Solidity contract thật.
 * Trong production đây là Solidity contract trên chain.
 */
class MockAnonymousVault {
  spentNullifiers = new Set<string>();
  existingCommitments = new Set<string>();
  latestRoot =
    "0x0000000000000000000000000000000000000000000000000000000000000000";
  totalLocked = 0n;

  deposit(amount: bigint, commitment: string, nullifierHash: string) {
    assert.ok(!this.existingCommitments.has(commitment), "commitment exists");
    assert.ok(!this.spentNullifiers.has(nullifierHash), "nullifier spent");
    this.existingCommitments.add(commitment);
    this.totalLocked += amount;
  }

  updateRoot(root: string) {
    this.latestRoot = root;
  }

  withdraw(params: {
    recipient: string;
    amount: bigint;
    root: string;
    nullifierHash: string;
    commitment: string;
    zkProof: string;
    thresholdSigs: string;
  }) {
    const { nullifierHash, commitment, root, zkProof, thresholdSigs, amount } =
      params;
    assert.ok(!this.spentNullifiers.has(nullifierHash), "nullifier already spent");
    assert.ok(this.existingCommitments.has(commitment), "commitment does not exist");
    assert.equal(root, this.latestRoot, "stale merkle root");
    assert.ok(zkProof.length > 0, "invalid ZK proof");
    assert.ok(thresholdSigs.length > 0, "missing threshold signatures");

    this.spentNullifiers.add(nullifierHash);
    this.existingCommitments.delete(commitment);
    this.totalLocked -= amount;

    return { recipient: params.recipient, amount, success: true };
  }

  getTotalLocked() {
    return this.totalLocked;
  }

  isSpent(nullifierHash: string) {
    return this.spentNullifiers.has(nullifierHash);
  }
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

describe("Anonymous cross-chain withdrawal (Coprocessor + ZK + FHE 16-bit)", () => {
  let vault: MockAnonymousVault;

  afterEach(() => {
    vault = new MockAnonymousVault();
  });

  it("end-to-end: deposit note, FHE-encrypted amount (16-bit), coprocessor CMP check, ZK + vault withdraw", async () => {
    vault = new MockAnonymousVault();

    const ck = `/tmp/ccav-test-cloud-${process.pid}-${Date.now()}.key`;

    // ── 1. Client nạp tiền, mã hóa số tiền bằng FHE (width 16) ──
    const worker = spawnWorker();
    const kgPayload = await worker.raw("KEYGEN", "128", ck);
    assert.ok(kgPayload.startsWith("client 128 "), kgPayload);

    const fheDepositAmount = 50_000n; // dưới 65535, đủ cho 16-bit FHE

    const encBlob = await encryptNumber(worker, fheDepositAmount, 16);
    assert.ok(encBlob.length > 0);

    // Tạo note (tương tự Tornado Cash)
    const secret = toHex("user_secret_12345");
    const nullifier = toHex("user_secret_12345_nullifier");
    const commitment = toHex(`commitment:${nullifier}:${secret}`);
    const nullifierHash = toHash(`nullifierHash:${nullifier}`);

    vault.deposit(fheDepositAmount, commitment, nullifierHash);
    vault.updateRoot(toHash("merkle_root_epoch_1"));

    console.log(
      `[Client] deposited ${fheDepositAmount}, commitment=${commitment.slice(0, 12)}...`
    );

    // ── 2. Coprocessor node (evaluator) tải cloud key và kiểm tra FHE ──
    const evalWorker = spawnWorker();
    const loadPayload = await evalWorker.raw("LOADCLOUD", ck);
    assert.ok(loadPayload.startsWith("evaluator "), loadPayload);

    // Simulate CoprocessorNode usage
    const coproc = new CoprocessorNode("test-node-1");

    const withdrawAmount = 30_000n; // <= 50,000 (dưới 16-bit limit)
    const recipient = "0xAnonymousRecipientAddress";

    // Chỉ client mới có quyền ENC. Evaluator chỉ nhận ciphertext đã mã hóa.
    const encWithdrawBlob = await encryptNumber(worker, withdrawAmount, 16);
    const cmpPayload = await evalWorker.raw(
      "CMP",
      "ge",
      "16",
      encBlob,
      encWithdrawBlob
    );
    // CMP trả về encrypted boolean (width 1). Client giải mã để biết kết quả.
    const cmpToks = cmpPayload.split(" ");
    const cmpWidth = Number(cmpToks[0]);
    const cmpBlob = cmpToks[1];
    const cmpResult = await decryptNumber(worker, cmpWidth, cmpBlob);
    assert.equal(cmpResult, 1n, `FHE CMP check failed: balance >= ${withdrawAmount}`);

    console.log(
      `[Coprocessor] FHE CMP check passed: encrypted balance >= ${withdrawAmount}`
    );

    // ── 3. ZK proof mock (trong production: circom/snarkjs proof thật) ──
    const zkProof = Buffer.from("mock_zk_proof_withdrawal").toString("hex");
    const thresholdSigs = Buffer.from(
      "mock_threshold_signatures_from_validators"
    ).toString("hex");

    // ── 4. Build withdrawal packet (gửi lên blockchain, KHÔNG chứa ciphertext FHE) ──
    const packet = buildWithdrawalPacket(
      {
        nullifierHash,
        commitment,
        amount: withdrawAmount,
        encryptedAmountFHE: encBlob,
        root: vault.latestRoot,
        recipient,
      },
      zkProof,
      thresholdSigs,
      true // fheComparisonResult
    );
    assert.equal(packet.fheComparisonResult, true);
    assert.equal(packet.nullifierHash, nullifierHash);

    // ── 5. Vault unlock tiền ──
    const result = vault.withdraw({
      recipient,
      amount: withdrawAmount,
      root: vault.latestRoot,
      nullifierHash,
      commitment,
      zkProof: packet.zkProof,
      thresholdSigs: packet.thresholdSigs,
    });

    assert.equal(result.success, true);
    assert.equal(result.recipient, recipient);
    assert.equal(result.amount, withdrawAmount);
    assert.ok(vault.isSpent(nullifierHash), "nullifier should be marked spent");
    assert.equal(vault.getTotalLocked(), fheDepositAmount - withdrawAmount);

    console.log(
      `[Vault] withdrawn ${withdrawAmount} to ${recipient}. Total locked: ${vault.getTotalLocked()}`
    );

    // ── 6. Double-spend phải bị chặn ──
    assert.throws(() => {
      vault.withdraw({
        recipient,
        amount: withdrawAmount,
        root: vault.latestRoot,
        nullifierHash,
        commitment,
        zkProof: packet.zkProof,
        thresholdSigs: packet.thresholdSigs,
      });
    }, /nullifier already spent/);

    // ── Cleanup ──
    try {
      fs.unlinkSync(ck);
    } catch {
      /* ignore */
    }
    worker.close();
    evalWorker.close();
  });

  it("CoprocessorNetwork threshold consensus works", () => {
    const network = new CoprocessorNetwork(2);
    const n1 = new CoprocessorNode("node-1");
    const n2 = new CoprocessorNode("node-2");
    const n3 = new CoprocessorNode("node-3");
    network.addNode(n1);
    network.addNode(n2);
    network.addNode(n3);

    const hash = "0xabc123";
    network.submitVote(hash, true, "node-1");
    assert.equal(network.isThresholdMet(hash), false);
    network.submitVote(hash, true, "node-2");
    assert.equal(network.isThresholdMet(hash), true);

    const consensus = network.getConsensus(hash);
    assert.equal(consensus.valid, true);
    assert.equal(consensus.votes, 2);
    assert.equal(consensus.total, 2);
    assert.equal(network.getNodeCount(), 3);
  });

  it("CoprocessorNode rejects double vote", () => {
    const node = new CoprocessorNode("test-node");
    assert.equal(node.signVote("0xhash1", true), node.signVote("0xhash2", true) ? "should throw" : "ok");
    assert.throws(() => node.signVote("0xhash1", true), /already voted/);
  });
});
