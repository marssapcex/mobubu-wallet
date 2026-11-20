import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { wtns } from "snarkjs";
import { setupLocalZk } from "../scripts/zk-local-setup.mjs";
import { createVaultTree } from "../packages/client/src/zk-tree.mjs";
import {
  AMOUNT_LIMIT, newValueNote, prepareNoteSpend, proveNoteSpend, valueNoteKey, valueNoteLeaf,
} from "../packages/client/src/zk-value-note.mjs";
import { openValueNoteEvm } from "./support/vault-evm.mjs";

const gasLimit = 2_500_000n;
let zk, evm;

before(async () => {
  zk = setupLocalZk("notes");
  evm = await openValueNoteEvm(zk.verifier);
});
after(() => evm?.close());

function appendLogs(vault, tree, receipt) {
  for (const log of receipt.logs) {
    if (log.address !== vault.target) continue;
    const event = vault.interface.parseLog(log);
    if (event?.name === "NoteInserted") tree.appendDeposit(event.args);
  }
}

async function deposit(vault, tree, value) {
  const note = newValueNote(await vault.domain(), value);
  const receipt = await (await vault.deposit(valueNoteKey(note), { value, gasLimit })).wait();
  appendLogs(vault, tree, receipt);
  assert.equal(tree.root, await vault.latestRoot());
  assert.equal(tree.path(tree.size - 1).leaf, valueNoteLeaf(valueNoteKey(note), value));
  return note;
}

async function prove(note, tree, index, amount, recipient) {
  const { input, change } = prepareNoteSpend(note, tree.path(index), amount, BigInt(recipient));
  const proof = await proveNoteSpend(input, zk);
  return { input, change, proof, args: [recipient, input.amount, input.root, input.nullifierHash, input.changeCommitment, ...proof.solidity] };
}

function fails(call, name) {
  return assert.rejects(call, (error) => {
    assert.equal(error.revert?.name, name, error.shortMessage ?? error.message);
    return true;
  });
}

test("v3 EVM: deposit arbitrary wei, withdraw part, then spend exactly the change", async () => {
  const vault = await evm.deployVault();
  const tree = createVaultTree();
  assert.equal(tree.root, await vault.latestRoot());
  const total = 123_456_789_123_456_789n;
  const debit = 31_234_567_890_123_457n;
  const note = await deposit(vault, tree, total);
  await deposit(vault, tree, 1n); // Same pool, unrelated amount and smallest native unit.
  assert.equal(await vault.totalLocked(), total + 1n);
  await fails(vault.deposit.staticCall(valueNoteKey(note), { value: 0n }), "InvalidDeposit");
  await fails(vault.deposit.staticCall(valueNoteKey(note), { value: total }), "DuplicateCommitment");

  const recipient = await (await evm.provider.getSigner(1)).getAddress();
  const forgedValue = { ...note, amount: (total + 1n).toString() };
  assert.equal(valueNoteKey(forgedValue), valueNoteKey(note));
  assert.throws(() => prepareNoteSpend(forgedValue, tree.path(0), debit, BigInt(recipient)), /credited leaf/);
  assert.throws(() => prepareNoteSpend(note, tree.path(0), total + 1n, BigInt(recipient)), /exceeds note value/);
  const beforeBalance = await evm.provider.getBalance(recipient);
  const first = await prove(note, tree, 0, debit, recipient);
  assert.equal(BigInt(first.change.amount), total - debit);
  const [, , root, nf, change, ...proof] = first.args;
  const otherRecipient = await (await evm.provider.getSigner(2)).getAddress();
  await fails(vault.withdraw.staticCall(otherRecipient, debit, root, nf, change, ...proof), "InvalidProof");
  await fails(vault.withdraw.staticCall(recipient, debit + 1n, root, nf, change, ...proof), "InvalidProof");
  await fails(vault.withdraw.staticCall(recipient, debit, root, nf, 0n, ...proof), "InvalidProof");
  appendLogs(vault, tree, await (await vault.withdraw(...first.args, { gasLimit })).wait());
  assert.equal(tree.size, 3);
  assert.equal(tree.root, await vault.latestRoot());
  assert.equal(await vault.totalLocked(), total - debit + 1n);
  assert.equal(await evm.provider.getBalance(recipient), beforeBalance + debit);
  await fails(vault.withdraw.staticCall(...first.args), "NullifierSpent");

  const rest = await prove(first.change, tree, 2, total - debit, recipient);
  assert.equal(rest.change, null);
  assert.equal(rest.input.changeCommitment, "0");
  appendLogs(vault, tree, await (await vault.withdraw(...rest.args, { gasLimit })).wait());
  assert.equal(tree.size, 3); // Full spend emits no zero-valued change leaf.
  assert.equal(await evm.provider.getBalance(recipient), beforeBalance + total);
  assert.equal(await vault.totalLocked(), 1n);
  assert.equal(await evm.provider.getBalance(vault.target), 1n);
});

test("v3 circuit itself rejects inflated values, wraparound overspend and invalid change", async () => {
  const domain = 42n;
  const note = newValueNote(domain, 103n);
  const tree = createVaultTree();
  tree.append(valueNoteLeaf(valueNoteKey(note), note.amount));
  const { input } = prepareNoteSpend(note, tree.path(0), 28n, 123n);
  await wtns.calculate(input, zk.wasm, { type: "mem" });
  for (const changes of [
    { amount: "104", changeNullifier: "0", changeSecret: "0", changeCommitment: "0" },
    { amount: "0" },
    { amount: AMOUNT_LIMIT.toString() },
    { noteValue: "104" },
    { changeCommitment: "0" },
    { changeSecret: "0" },
    { payoutBinding: "0" },
  ]) {
    await assert.rejects(wtns.calculate({ ...input, ...changes }, zk.wasm, { type: "mem" }), /(?:assert|constraint)/i);
  }
  // A self-consistent witness at a different paid value still cannot use the
  // real ledger root. This bypasses the SDK and checks the membership relation.
  const wrongValue = { ...note, amount: "104" };
  const wrongTree = createVaultTree();
  wrongTree.append(valueNoteLeaf(valueNoteKey(wrongValue), wrongValue.amount));
  const inflated = prepareNoteSpend(wrongValue, wrongTree.path(0), 104n, 123n).input;
  await wtns.calculate(inflated, zk.wasm, { type: "mem" });
  await assert.rejects(wtns.calculate({ ...inflated, root: input.root }, zk.wasm, { type: "mem" }), /(?:assert|constraint)/i);
});

test("v3 EVM: failed payout rolls back the change leaf, nullifier and debit", async () => {
  const vault = await evm.deployVault();
  const tree = createVaultTree();
  const amount = 131_259_001n;
  const note = await deposit(vault, tree, amount);
  const receiver = evm.payoutReceiver;
  const spend = await prove(note, tree, 0, 97n, receiver.target);
  const sent = await vault.withdraw(...spend.args, { gasLimit });
  await assert.rejects(sent.wait(), (error) => error.receipt?.status === 0);
  assert.equal(await vault.leafCount(), 1n);
  assert.equal(await vault.latestRoot(), tree.root);
  assert.equal(await vault.commitments(spend.input.changeCommitment), false);
  assert.equal(await vault.spentNullifiers(spend.input.nullifierHash), false);
  assert.equal(await vault.totalLocked(), amount);
  assert.equal(await evm.provider.getBalance(receiver.target), 0n);
  await (await receiver.acceptNative()).wait();
  appendLogs(vault, tree, await (await vault.withdraw(...spend.args, { gasLimit })).wait());
  assert.equal(await vault.spentNullifiers(spend.input.nullifierHash), true);
  assert.equal(await vault.totalLocked(), amount - 97n);
  assert.equal(await evm.provider.getBalance(receiver.target), 97n);
  assert.equal(tree.root, await vault.latestRoot());
});

// Same code, keys and addresses: only the EIP-155 identity differs. These are
// two ordinary local EVMs, not emulators of the rollups' actual finality rules.
test("v3 EVM: identical vault addresses and roots on different chain IDs cannot share a proof", async (t) => {
  const a = await openValueNoteEvm(zk.verifier, { chainId: 8_453n });
  t.after(() => a.close());
  const b = await openValueNoteEvm(zk.verifier, { chainId: 10n });
  t.after(() => b.close());
  const va = await a.deployVault(), vb = await b.deployVault();
  assert.equal(va.target, vb.target);
  assert.equal(await va.deploymentChainId(), 8_453n);
  assert.equal(await vb.deploymentChainId(), 10n);
  assert.notEqual(await va.domain(), await vb.domain());
  const tree = createVaultTree();
  const amount = 1_234_567_891_234_567n;
  const note = await deposit(va, tree, amount);
  await (await vb.deposit(valueNoteKey(note), { value: amount, gasLimit })).wait();
  assert.equal(await vb.latestRoot(), tree.root);
  const receiver = await (await a.provider.getSigner(1)).getAddress();
  const spend = await prove(note, tree, 0, amount, receiver);
  await fails(vb.withdraw.staticCall(...spend.args), "InvalidProof");
  assert.equal(await vb.spentNullifiers(spend.input.nullifierHash), false);
  assert.equal(await vb.totalLocked(), amount);
  assert.equal((await (await va.withdraw(...spend.args, { gasLimit })).wait()).status, 1);
  assert.equal(await va.totalLocked(), 0n);
});
