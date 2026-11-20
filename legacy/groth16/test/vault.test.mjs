import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AbiCoder, ZeroAddress, id, keccak256, parseEther } from "ethers";
import { wtns } from "snarkjs";
import { setupLocalZk, verifyLocalZkCache } from "../scripts/zk-local-setup.mjs";
import { createVaultCrypto, proveWithdrawal, SCALAR_FIELD, TREE_DEPTH } from "../packages/client/src/zk-vault.mjs";
import { encodeProof, encodeStatement, encodeVerificationKey } from "../packages/client/src/zk-wire.mjs";
import { openVaultEvm } from "./support/vault-evm.mjs";

const value = parseEther("0.1");
const gasLimit = 2_500_000n;
let zk, evm, client;

before(async () => {
  zk = setupLocalZk();
  client = await createVaultCrypto();
  evm = await openVaultEvm(zk.verifier);
});
after(() => evm?.close());

async function deposit(vault, tree, commitment) {
  const receipt = await (await vault.deposit(commitment, { value, gasLimit })).wait();
  const [event] = receipt.logs.map((log) => vault.interface.parseLog(log)).filter(Boolean);
  assert.equal(event.name, "Deposit");
  assert.equal(event.args.commitment, commitment);
  assert.equal(event.args.length, 3); // No nullifier or note secrets at deposit.
  tree.appendDeposit(event.args);
  assert.equal(tree.root, await vault.latestRoot());
  return receipt.gasUsed;
}

function rejectsCall(call, name) {
  return assert.rejects(call, (error) => {
    assert.equal(error.revert?.name, name, error.shortMessage ?? error.message);
    return true;
  });
}

test("real Groth16 withdrawal binds root, nullifier, payout and deployment domain", async (t) => {
  const vault = await evm.deployVault(value);
  const domain = await vault.domain();
  const { chainId } = await evm.provider.getNetwork();
  assert.equal(domain, BigInt(keccak256(AbiCoder.defaultAbiCoder().encode(
    ["bytes32", "uint256", "address", "uint256"], [id("mobubu-native-vault-v2"), chainId, vault.target, value],
  ))) % SCALAR_FIELD);
  const tree = client.createTree();
  assert.equal(tree.root, await vault.latestRoot());
  assert.equal(await vault.TREE_DEPTH(), BigInt(TREE_DEPTH));
  assert.equal(await vault.leafCount(), 0n);
  const note = client.newNote(domain);
  const commitment = client.commitment(note);

  await rejectsCall(vault.deposit.staticCall(commitment, { value: value - 1n }), "IncorrectDepositValue");
  await rejectsCall(vault.deposit.staticCall(commitment, { value: value + 1n }), "IncorrectDepositValue");
  await rejectsCall(vault.deposit.staticCall(0n, { value }), "InvalidCommitment");
  await rejectsCall(vault.deposit.staticCall(SCALAR_FIELD, { value }), "InvalidCommitment");
  const firstGas = await deposit(vault, tree, commitment);
  await rejectsCall(vault.deposit.staticCall(commitment, { value }), "DuplicateCommitment");

  const recipient = await (await evm.provider.getSigner(1)).getAddress();
  const input = client.withdrawalInput(note, tree, 0, recipient);
  const result = await proveWithdrawal(input, zk);
  const [to, root, nullifier, a, b, c] = result.calldata;
  assert.deepEqual(result.publicSignals, [input.root, input.nullifierHash, input.recipient, input.domain]);
  assert.equal(JSON.parse(readFileSync(zk.vkey, "utf8")).nPublic, 4);
  assert.equal(await evm.verifier.verifyProof(a, b, c, result.publicSignals), true);
  await vault.withdraw.staticCall(...result.calldata);
  await rejectsCall(vault.withdraw.staticCall(ZeroAddress, root, nullifier, a, b, c), "InvalidWithdrawal");
  await rejectsCall(vault.withdraw.staticCall(recipient, root, nullifier, [0n, 0n], b, c), "InvalidProof");
  await rejectsCall(vault.withdraw.staticCall(await (await evm.provider.getSigner(2)).getAddress(), root, nullifier, a, b, c), "InvalidProof");
  await rejectsCall(vault.withdraw.staticCall(to, root, BigInt(nullifier) + 1n, a, b, c), "InvalidProof");
  await rejectsCall(vault.withdraw.staticCall(to, 0n, nullifier, a, b, c), "UnknownRoot");

  const other = await evm.deployVault(value);
  assert.notEqual(await other.domain(), domain);
  await deposit(other, client.createTree(), commitment); // Even identical roots cannot replay a proof.
  assert.equal(await other.latestRoot(), BigInt(root));
  await rejectsCall(other.withdraw.staticCall(...result.calldata), "InvalidProof");

  const laterGas = await deposit(vault, tree, client.commitment(client.newNote(domain)));
  assert.equal(await vault.isKnownRoot(root), true);
  await rejectsCall(vault.withdraw.staticCall(to, tree.root, nullifier, a, b, c), "InvalidProof");
  const before = await evm.provider.getBalance(recipient);
  const withdrawal = await (await vault.withdraw(...result.calldata, { gasLimit })).wait();
  assert.equal(await evm.provider.getBalance(recipient), before + value);
  assert.equal(await vault.totalLocked(), value);
  assert.equal(await evm.provider.getBalance(vault.target), value);
  assert.equal(await vault.spentNullifiers(nullifier), true);
  await rejectsCall(vault.withdraw.staticCall(...result.calldata), "NullifierSpent");
  // A failed payout cannot consume an otherwise valid proof or debit the vault.
  const note2 = client.newNote(domain);
  await deposit(vault, tree, client.commitment(note2));
  const receiver = evm.payoutReceiver;
  const rejected = await proveWithdrawal(client.withdrawalInput(note2, tree, 2, receiver.target), zk);
  await rejectsCall(vault.withdraw.staticCall(...rejected.calldata), "NativeTransferFailed");
  const failedTx = await vault.withdraw(...rejected.calldata, { gasLimit });
  await assert.rejects(failedTx.wait(), (error) => error.receipt?.status === 0);
  assert.equal(await vault.spentNullifiers(rejected.publicSignals[1]), false);
  assert.equal(await vault.totalLocked(), 2n * value);
  assert.equal(await evm.provider.getBalance(vault.target), 2n * value);
  assert.equal(await evm.provider.getBalance(receiver.target), 0n);
  await (await receiver.acceptNative()).wait();
  await (await vault.withdraw(...rejected.calldata, { gasLimit })).wait();
  assert.equal(await vault.spentNullifiers(rejected.publicSignals[1]), true);
  assert.equal(await vault.totalLocked(), value);
  assert.equal(await evm.provider.getBalance(receiver.target), value);
  t.diagnostic(`gas: first deposit ${firstGas}, next deposit ${laterGas}, withdrawal ${withdrawal.gasUsed}`);
});

test("witness constraints reject false claims and non-canonical paths", async () => {
  const tree = client.createTree();
  const [d, wrong] = [1n, 2n];
  const note = client.newNote(d);
  tree.append(client.commitment(note));
  const recipient = await (await evm.provider.getSigner(1)).getAddress();
  const input = client.withdrawalInput(note, tree, 0, recipient);
  const [first, ...rest] = input.pathIndices;
  assert.equal(first, "0");
  for (const change of [
    { pathIndices: ["2", ...rest] }, { pathIndices: ["1", ...rest] },
    { secret: (1n << 248n).toString() }, { domain: wrong.toString() },
    { recipient: "0" }, { recipient: (1n << 160n).toString() },
    { nullifierHash: (BigInt(input.nullifierHash) + 1n).toString() },
  ]) {
    // Exercise circuit constraints directly, not the SDK's stricter wire validation.
    await assert.rejects(wtns.calculate({ ...input, ...change }, zk.wasm, { type: "mem" }), /(?:assert|constraint)/i);
  }
});

test("incremental Poseidon matches every indexed log and evicts old roots", async (t) => {
  const vault = await evm.deployVault(value);
  const tree = client.createTree();
  const domain = await vault.domain();
  const capacity = Number(await vault.ROOT_HISTORY());
  const empty = tree.root;
  const commitment = client.commitment(client.newNote(domain));
  assert.throws(() => tree.appendDeposit({ commitment, leafIndex: 1n, root: empty }), /index/);
  assert.throws(() => tree.appendDeposit({ commitment, leafIndex: 0n, root: empty }), /root/);
  assert.equal(tree.size, 0);
  const roots = [empty];
  const gas = [];
  for (let i = 0; i < capacity + 1; i++) {
    gas.push(await deposit(vault, tree, client.commitment(client.newNote(domain))));
    roots.push(tree.root);
  }
  assert.equal(await vault.leafCount(), BigInt(tree.size));
  assert.equal(await vault.isKnownRoot(roots[0]), false);
  assert.equal(await vault.isKnownRoot(roots[1]), false);
  assert.equal(await vault.isKnownRoot(roots[2]), true);
  assert.equal(await vault.isKnownRoot(roots.at(-1)), true);
  t.diagnostic(`gas over ${gas.length} deposits: ${gas.reduce((a, b) => a < b ? a : b)}..${gas.reduce((a, b) => a > b ? a : b)}`);
});

test("disposable ceremony cache refuses altered artifacts", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "mobubu-cache-check-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(dirname(zk.zkey), dir, { recursive: true });
  const cached = verifyLocalZkCache(dir);
  writeFileSync(cached.vkey, "{}");
  assert.throws(() => verifyLocalZkCache(dir), (error) =>
    /Corrupt disposable ZK cache/.test(error.message) && /checksum mismatch for vkey/.test(error.cause?.message));
});

const native = process.env.MOBUBU_RUST_VERIFY_BIN;
test("native Rust and EVM verify the same Groth16 statement", { skip: !native }, async (t) => {
  const vault = await evm.deployVault(value);
  const tree = client.createTree();
  const domain = await vault.domain();
  // Use a nonzero index so the witness exercises both left and right branches.
  await deposit(vault, tree, client.commitment(client.newNote(domain)));
  const note = client.newNote(domain);
  await deposit(vault, tree, client.commitment(note));
  const recipient = await (await evm.provider.getSigner(1)).getAddress();
  const input = client.withdrawalInput(note, tree, 1, recipient);
  const result = await proveWithdrawal(input, zk);
  await vault.withdraw.staticCall(...result.calldata);

  const dir = mkdtempSync(join(tmpdir(), "mobubu-proof-parity-"));
  try {
    const [keyPath, proofPath, statementPath] = ["vk", "proof", "statement"].map((name) => join(dir, `${name}.bin`));
    writeFileSync(keyPath, encodeVerificationKey(JSON.parse(readFileSync(zk.vkey, "utf8"))));
    writeFileSync(proofPath, encodeProof(result.proof));
    writeFileSync(statementPath, encodeStatement(input));
    const verify = () => spawnSync(native, ["verify", keyPath, proofPath, statementPath], {
      encoding: "utf8", timeout: 10_000, maxBuffer: 4096,
    });
    let checked = verify();
    assert.equal(checked.status, 0, checked.error?.message ?? checked.stderr);
    assert.equal(checked.stdout.trim(), "valid");
    writeFileSync(statementPath, encodeStatement({ ...input, recipient: BigInt(input.recipient) ^ 1n }));
    checked = verify();
    assert.equal(checked.status, 1, checked.stderr);
    writeFileSync(statementPath, Buffer.concat([encodeStatement(input), Buffer.of(0)]));
    checked = verify();
    assert.equal(checked.status, 2);
    if (process.platform === "linux") {
      const fifo = join(dir, "statement.fifo");
      assert.equal(spawnSync("mkfifo", [fifo]).status, 0);
      checked = spawnSync(native, ["verify", keyPath, proofPath, fifo], { encoding: "utf8", timeout: 2_000 });
      assert.equal(checked.status, 2, checked.error?.message ?? checked.stderr);
      assert.match(checked.stderr, /regular file of exactly 128 bytes/);
    }
    t.diagnostic("Parity: authentic proof accepted by Solidity and Rust; changed recipient / malformed wire rejected");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
