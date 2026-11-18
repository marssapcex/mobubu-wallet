import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { Interface, ZeroAddress, ZeroHash, concat, getBytes, hexlify, parseEther } from "ethers";
import { slh_dsa_sha2_128s as slh } from "@noble/post-quantum/slh-dsa.js";
import {
  AUTH_DOMAIN, DEPOSIT, WITHDRAW, PUBLIC_KEY_BYTES, SECRET_KEY_BYTES, SIGNATURE_BYTES, PQ_VAULT_ABI,
  authorizationMessage, connectVault, createVaultKey, encodeVaultTransaction, signAuthorization, verifyAuthorization,
} from "mobubu-wallet";
import { compileContracts } from "../scripts/compile-contracts.mjs";
import { LOCAL_CHAIN_ID, TX_GAS_CAP, openLocalEvm } from "./support/local-evm.mjs";

const VAULT_SOURCE = "contracts/PostQuantumVault.sol";
const LIB_SOURCE = "contracts/lib/SlhDsaSha2_128s.sol";
const TEST_SOURCE = "test/PqVaultFixtures.sol";
const FIXTURES = `
// SPDX-License-Identifier: ISC
pragma solidity 0.8.24;
import {PostQuantumVault} from "${VAULT_SOURCE}";
import {SlhDsaSha2_128s} from "${LIB_SOURCE}";

contract SignatureChecker {
    function check(bytes32 key, bytes calldata message, bytes calldata signature) external view returns (bool) {
        return SlhDsaSha2_128s.verify(key, message, signature);
    }
    function checkFormatted(bytes32 key, bytes calldata messagePrime, bytes calldata signature) external view returns (bool) {
        return SlhDsaSha2_128s.verifyInternal(key, messagePrime, signature);
    }
}

// A receiving contract has the option to reject a legitimate payout. The
// vault must roll back then, and reject either entry point during a callback.
contract PayoutReceiver {
    PostQuantumVault private immutable vault;
    bool private accepts;
    uint256 public payments;
    constructor(PostQuantumVault vault_) { vault = vault_; }
    function acceptNative() external { accepts = true; }
    receive() external payable {
        require(accepts);
        (bool credited, bytes memory depositError) = address(vault).call(
            abi.encodeCall(vault.deposit, (bytes32(0), 0, 0, bytes("")))
        );
        require(!credited && bytes4(depositError) == PostQuantumVault.ReentrantCall.selector);
        (bool paid, bytes memory withdrawError) = address(vault).call(
            abi.encodeCall(vault.withdraw, (bytes32(0), payable(address(this)), 1, 0, 0, bytes("")))
        );
        require(!paid && bytes4(withdrawError) == PostQuantumVault.ReentrantCall.selector);
        ++payments;
    }
}

contract ForcedEther {
    constructor(address payable recipient) payable { selfdestruct(recipient); }
}
`;

const iface = new Interface(PQ_VAULT_ABI);
const opts = { gasLimit: 3_000_000n }; // Below the Osaka TX cap, no gas/size/precompile overrides.
const DEADLINE = 1_795_000_000n;
const ETH = parseEther("1");
const acvp = JSON.parse(readFileSync(new URL("fixtures/slh-dsa-sha2-128s-acvp.json", import.meta.url), "utf8"));
const fromHex = (s) => getBytes(`0x${s}`);

let compiled, evm, payer, relayer, recipient, keyA, keyB;
before(async () => {
  compiled = compileContracts({ [TEST_SOURCE]: FIXTURES });
  evm = await openLocalEvm();
  [payer, relayer, recipient] = await Promise.all([0, 1, 2].map((i) => evm.provider.getSigner(i)));
  // Public reproducible fixture keys. The SDK's real key API has no seed input.
  const fixture = (seed) => {
    const keys = slh.keygen(new Uint8Array(48).fill(seed));
    return { secretKey: keys.secretKey, publicKey: hexlify(keys.publicKey) };
  };
  keyA = fixture(0x28);
  keyB = fixture(0x51);
});
after(() => evm?.close());

function newVault(local = evm) {
  return local.deploy(compiled[VAULT_SOURCE].PostQuantumVault);
}
function req(vault, overrides = {}) {
  return {
    chainId: LOCAL_CHAIN_ID, vault: vault.target, action: DEPOSIT, publicKey: keyA.publicKey,
    party: payer.address, amount: ETH, nonce: 0n, deadline: DEADLINE, ...overrides,
  };
}
async function send(sender, intent, signature) {
  const tx = await sender.sendTransaction({ ...encodeVaultTransaction(intent, signature), ...opts });
  const receipt = await tx.wait();
  assert.equal(receipt.status, 1);
  return receipt;
}
function deterministicSig(key, request) {
  return hexlify(slh.sign(getBytes(authorizationMessage(request)), key.secretKey, { extraEntropy: false }));
}
function expectError(vault, name) {
  return (error) => error.code === "CALL_EXCEPTION" && error.data === vault.interface.getError(name).selector;
}
async function expectCallError(vault, name, transaction) {
  await assert.rejects(evm.provider.call({ ...opts, ...transaction }), expectError(vault, name));
}
async function expectRevertedTx(sender, transaction) {
  const tx = await sender.sendTransaction({ ...opts, ...transaction });
  await assert.rejects(tx.wait(), (e) => e.code === "CALL_EXCEPTION" && e.receipt.status === 0 && e.receipt.logs.length === 0);
}
async function assertAccount(vault, publicKey, amount, nonce) {
  const actual = await vault.accounts(publicKey);
  assert.equal(actual.balance, amount);
  assert.equal(actual.nonce, nonce);
}
function signedArgs(request) {
  const { action, publicKey, party, amount, nonce, deadline } = request;
  return [action, publicKey, party, amount, nonce, deadline];
}
function assertEvent(vault, receipt, name, args) {
  assert.equal(receipt.logs.length, 1);
  assert.equal(receipt.logs[0].address, vault.target);
  const log = iface.parseLog(receipt.logs[0]);
  assert.equal(log.name, name);
  assert.deepEqual([...log.args], args);
}
function flipLastByte(signature) {
  const data = getBytes(signature);
  data[data.length - 1] ^= 1;
  return hexlify(data);
}

test("the build and package export the new vault ABI and canonical signed bytes", async () => {
  assert.deepEqual(Object.keys(compiled).sort(), [VAULT_SOURCE, LIB_SOURCE, 'contracts/NativeSwapRail.sol', TEST_SOURCE].sort());
  const vault = await newVault();
  assert.deepEqual(iface.format().sort(), vault.interface.format().sort());
  assert.equal(await vault.AUTH_DOMAIN(), AUTH_DOMAIN);
  assert.equal(await vault.ASSET(), ZeroAddress);
  assert.equal(await vault.DEPOSIT(), BigInt(DEPOSIT));
  assert.equal(await vault.WITHDRAW(), BigInt(WITHDRAW));
  const deposit = req(vault);
  const withdrawal = req(vault, { action: WITHDRAW, nonce: 1n, party: recipient.address, amount: ETH / 7n });
  for (const request of [deposit, withdrawal]) {
    const message = authorizationMessage(request);
    assert.equal(getBytes(message).length, 320);
    assert.equal(await vault.authorizationMessage(...signedArgs(request)), message);
  }
});

test("FIPS 205: independent NIST sigVer (255-byte context) and sigGen (empty context) match on EVM", async () => {
  const checker = await evm.deploy(compiled[TEST_SOURCE].SignatureChecker);
  const { pk, message, context, signature, testPassed } = acvp.sigVer.test;
  const sig = `0x${signature}`;
  const ctx = fromHex(context);
  const prime = concat([Uint8Array.of(0, ctx.length), ctx, fromHex(message)]);
  assert.equal(await checker.checkFormatted(`0x${pk}`, prime, sig), testPassed);
  assert.equal(await checker.checkFormatted(`0x${pk}`, prime, flipLastByte(sig)), false);
  assert.equal(await checker.check(`0x${pk}`, `0x${message}`, sig), false); // context is signed
  const generated = acvp.sigGen.test;
  const sk = fromHex(generated.sk); // NIST published test key, not a wallet secret
  const msg = fromHex(generated.message);
  const genSig = slh.sign(msg, sk, { extraEntropy: fromHex(generated.additionalRandomness) });
  assert.ok(hexlify(genSig) === `0x${generated.signature.toLowerCase()}`, "NIST signing known answer must match");
  assert.equal(await checker.check(hexlify(slh.getPublicKey(sk)), msg, genSig), true);
});

test("SDK keygen and signing stay local; invalid request values fail before encoding", async () => {
  const vault = await newVault();
  const key = createVaultKey();
  assert.equal(getBytes(key.publicKey).length, PUBLIC_KEY_BYTES);
  assert.equal(key.secretKey.length, SECRET_KEY_BYTES);
  const deposit = req(vault, { publicKey: key.publicKey, amount: 7n });
  const sig = signAuthorization(key.secretKey, deposit);
  assert.equal(getBytes(sig).length, SIGNATURE_BYTES);
  assert.equal(verifyAuthorization(deposit, sig), true);
  assert.equal(verifyAuthorization({ ...deposit, amount: 8n }, sig), false);
  assert.equal(verifyAuthorization(deposit, "0x"), false);
  const tx = encodeVaultTransaction(deposit, sig);
  assert.deepEqual(Object.keys(tx).sort(), ["chainId", "data", "from", "to", "value"]);
  assert.equal(tx.from, payer.address);
  assert.equal(tx.value, 7n);
  assert.equal(tx.to, vault.target);
  assert.throws(() => signAuthorization(keyA.secretKey, deposit), /does not match/);
  assert.throws(() => signAuthorization(new Uint8Array(1), deposit), /64-byte Uint8Array/);
  assert.throws(() => encodeVaultTransaction(deposit, "0x12"), /7856 bytes/);
  for (const fields of [
    { action: 3 }, { publicKey: "0x01" }, { publicKey: ZeroHash }, { vault: ZeroAddress }, { party: ZeroAddress },
    { amount: 0n }, { amount: -1n }, { amount: 1n << 256n }, { amount: Number.MAX_SAFE_INTEGER + 1 }, { amount: 1.5 },
    { chainId: 0n }, { nonce: -1n }, { deadline: 1n << 64n }, { asset: recipient.address },
    { action: WITHDRAW, party: vault.target },
  ]) assert.throws(() => authorizationMessage({ ...deposit, ...fields }));
  await send(payer, deposit, sig);
  const reader = connectVault(vault.target, evm.provider);
  await assertAccount(reader, key.publicKey, 7n, 1n);
  const withdrawal = { ...deposit, action: WITHDRAW, party: recipient.address, nonce: 1n };
  const payoutSig = signAuthorization(key.secretKey, withdrawal);
  assert.equal(verifyAuthorization(withdrawal, payoutSig), true);
  const recipientBefore = await evm.provider.getBalance(recipient.address);
  await send(relayer, withdrawal, payoutSig);
  await assertAccount(reader, key.publicKey, 0n, 2n);
  assert.equal(await evm.provider.getBalance(recipient.address), recipientBefore + 7n);
});

test("PQ-gated deposits, top-up and relayed partial/full withdrawals transfer actual ETH (Osaka gas)", async (t) => {
  const vault = await newVault();
  const reader = connectVault(vault.target, evm.provider);
  const deposit = req(vault, { amount: ETH + 43n });
  const deterministic = (request) => deterministicSig(keyA, request);
  const startPayer = await evm.provider.getBalance(payer.address);
  const first = await send(payer, deposit, deterministic(deposit));
  assertEvent(vault, first, "Deposit", [keyA.publicKey, payer.address, deposit.amount, 0n]);
  assert.equal(await evm.provider.getBalance(payer.address), startPayer - deposit.amount - first.fee);
  await assertAccount(reader, keyA.publicKey, deposit.amount, 1n);
  const topup = { ...deposit, amount: 7n, nonce: 1n };
  const top = await send(payer, topup, deterministic(topup));
  const total = deposit.amount + topup.amount;
  await assertAccount(reader, keyA.publicKey, total, 2n);
  assert.equal(await reader.totalLocked(), total);
  assert.equal(await evm.provider.getBalance(vault.target), total);

  const partial = req(vault, { action: WITHDRAW, party: recipient.address, amount: ETH / 3n, nonce: 2n });
  const sig = deterministic(partial);
  const tx = encodeVaultTransaction(partial, sig);
  assert.equal(tx.from, undefined);
  assert.equal(tx.value, 0n);
  const startRecipient = await evm.provider.getBalance(recipient.address);
  const startRelayer = await evm.provider.getBalance(relayer.address);
  const paid = await send(relayer, partial, sig);
  assertEvent(vault, paid, "Withdrawal", [keyA.publicKey, recipient.address, partial.amount, 2n]);
  assert.equal(await evm.provider.getBalance(relayer.address), startRelayer - paid.fee);
  assert.equal(await evm.provider.getBalance(recipient.address), startRecipient + partial.amount);
  const remainder = total - partial.amount;
  await assertAccount(reader, keyA.publicKey, remainder, 3n);
  assert.equal(await reader.totalLocked(), remainder);
  assert.equal(await evm.provider.getBalance(vault.target), remainder);

  const final = { ...partial, amount: remainder, nonce: 3n };
  const drained = await send(relayer, final, deterministic(final));
  await assertAccount(reader, keyA.publicKey, 0n, 4n); // no nonce reset at zero balance
  assert.equal(await reader.totalLocked(), 0n);
  assert.equal(await evm.provider.getBalance(vault.target), 0n);
  assert.equal(await evm.provider.getBalance(recipient.address), startRecipient + total);
  const gas = [first, top, paid, drained].map((receipt) => receipt.gasUsed);
  assert.ok(opts.gasLimit < TX_GAS_CAP);
  assert.ok(gas.every((used) => used > 0n && used < opts.gasLimit));
  t.diagnostic(`Osaka gas: initial deposit=${gas[0]}, top-up=${gas[1]}, partial withdrawal=${gas[2]}, full withdrawal=${gas[3]}`);
});

test("deposit rejects unsigned, malformed, expired, wrong payer or wrong msg.value", async () => {
  const vault = await newVault();
  const deposit = req(vault);
  const sig = deterministicSig(keyA, deposit);
  const validTx = encodeVaultTransaction(deposit, sig);
  const withDeposit = (publicKey, nonce, deadline, signature) => ({
    ...validTx, data: iface.encodeFunctionData("deposit", [publicKey, nonce, deadline, signature]),
  });
  for (const malformed of ["0x", sig.slice(0, -2), `${sig}00`, flipLastByte(sig)]) {
    await expectCallError(vault, "InvalidSignature", withDeposit(keyA.publicKey, 0n, DEADLINE, malformed));
  }
  await expectCallError(vault, "InvalidSignature", { ...validTx, from: relayer.address });
  await expectCallError(vault, "InvalidSignature", { ...validTx, value: deposit.amount + 1n });
  await expectCallError(vault, "InvalidAmount", { ...validTx, value: 0n });
  await expectCallError(vault, "AuthorizationExpired", withDeposit(keyA.publicKey, 0n, 1n, sig));
  await expectCallError(vault, "InvalidNonce", withDeposit(keyA.publicKey, 1n, DEADLINE, sig));
  await expectCallError(vault, "InvalidPublicKey", withDeposit(ZeroHash, 0n, DEADLINE, sig));
  await expectRevertedTx(payer, { ...validTx, value: deposit.amount + 1n });
  await assertAccount(vault, keyA.publicKey, 0n, 0n);
  assert.equal(await evm.provider.getBalance(vault.target), 0n);
  assert.equal(await vault.totalLocked(), 0n);
  await send(payer, deposit, sig);
  await expectCallError(vault, "InvalidNonce", validTx);
  await assertAccount(vault, keyA.publicKey, ETH, 1n);
});

test("withdrawal binds action, public key, recipient, amount, deadline and nonce; isolated balances and no replay", async () => {
  const vault = await newVault();
  for (const key of [keyA, keyB]) {
    const deposit = req(vault, { publicKey: key.publicKey });
    await send(payer, deposit, deterministicSig(key, deposit));
  }
  const withdrawal = req(vault, { action: WITHDRAW, party: recipient.address, amount: ETH / 4n, nonce: 1n });
  const sig = deterministicSig(keyA, withdrawal);
  const tx = (request, signature = sig) => ({ ...encodeVaultTransaction(request, signature), from: relayer.address });
  for (const fields of [
    { party: relayer.address }, { amount: withdrawal.amount + 1n },
    { publicKey: keyB.publicKey }, { deadline: DEADLINE + 1n },
  ]) await expectCallError(vault, "InvalidSignature", tx({ ...withdrawal, ...fields }));
  await expectCallError(vault, "InvalidSignature", tx(withdrawal, flipLastByte(sig)));
  await expectCallError(vault, "InvalidSignature", tx(withdrawal, deterministicSig(keyB, { ...withdrawal, publicKey: keyB.publicKey })));
  await expectCallError(vault, "InvalidSignature", tx(withdrawal, deterministicSig(keyA, { ...withdrawal, action: DEPOSIT })));
  await expectCallError(vault, "AuthorizationExpired", tx({ ...withdrawal, deadline: 1n }));
  const oversized = { ...withdrawal, amount: ETH + 1n };
  await expectCallError(vault, "InsufficientBalance", tx(oversized, deterministicSig(keyA, oversized)));
  const invalidRecipient = (address) => ({ ...tx(withdrawal), data: iface.encodeFunctionData("withdraw", [
    keyA.publicKey, address, withdrawal.amount, withdrawal.nonce, withdrawal.deadline, sig,
  ]) });
  for (const address of [ZeroAddress, vault.target]) {
    await expectCallError(vault, "InvalidRecipient", invalidRecipient(address));
  }
  await expectRevertedTx(relayer, tx({ ...withdrawal, party: relayer.address }));
  await assertAccount(vault, keyA.publicKey, ETH, 1n);
  await assertAccount(vault, keyB.publicKey, ETH, 1n);
  assert.equal(await vault.totalLocked(), 2n * ETH);
  await send(relayer, withdrawal, sig);
  await expectCallError(vault, "InvalidNonce", tx(withdrawal));
  await expectCallError(vault, "InvalidSignature", tx({ ...withdrawal, nonce: 2n }));
  await assertAccount(vault, keyA.publicKey, ETH - withdrawal.amount, 2n);
  await assertAccount(vault, keyB.publicKey, ETH, 1n);
  assert.equal(await vault.totalLocked(), 2n * ETH - withdrawal.amount);
});

test("chain and vault binding: no cross-vault deposit or cross-chain deposit/withdrawal replay", async () => {
  const vault = await newVault();
  const another = await newVault();
  const original = req(vault);
  const sig = deterministicSig(keyA, original);
  await expectCallError(another, "InvalidSignature", encodeVaultTransaction({ ...original, vault: another.target }, sig));
  await assertAccount(another, keyA.publicKey, 0n, 0n);

  const other = await openLocalEvm(LOCAL_CHAIN_ID + 1n);
  const reference = await openLocalEvm();
  try {
    const left = await newVault(reference);
    const right = await newVault(other);
    assert.equal(left.target, right.target); // Same CREATE address, same code, different chain ID.
    const chain1 = req(left);
    const chain2 = { ...chain1, chainId: LOCAL_CHAIN_ID + 1n };
    const chain1Sig = deterministicSig(keyA, chain1);
    assert.equal(await right.authorizationMessage(...signedArgs(chain2)), authorizationMessage(chain2));
    await assert.rejects(other.provider.call({ ...opts, ...encodeVaultTransaction(chain2, chain1Sig) }), expectError(right, "InvalidSignature"));
    await send(await reference.provider.getSigner(0), chain1, chain1Sig);
    await assertAccount(left, keyA.publicKey, ETH, 1n);
    await assertAccount(right, keyA.publicKey, 0n, 0n);
    await send(await other.provider.getSigner(0), chain2, deterministicSig(keyA, chain2));
    await assertAccount(right, keyA.publicKey, ETH, 1n);

    const firstPayout = { ...chain1, action: WITHDRAW, party: recipient.address, amount: ETH / 3n, nonce: 1n };
    const crossChain = { ...firstPayout, chainId: chain2.chainId };
    const payoutSig = deterministicSig(keyA, firstPayout);
    await assert.rejects(other.provider.call({ ...opts, ...encodeVaultTransaction(crossChain, payoutSig) }),
      expectError(right, "InvalidSignature"));
    await send(await reference.provider.getSigner(1), firstPayout, payoutSig);
    await assertAccount(left, keyA.publicKey, ETH - firstPayout.amount, 2n);
    await assertAccount(right, keyA.publicKey, ETH, 1n);
  } finally {
    reference.close();
    other.close();
  }
});

test("failed payout rolls back ETH, account, total and nonce; retry works and callbacks cannot reenter", async () => {
  const vault = await newVault();
  const receiver = await evm.deploy(compiled[TEST_SOURCE].PayoutReceiver, vault.target);
  const deposit = req(vault);
  await send(payer, deposit, deterministicSig(keyA, deposit));
  const withdrawal = req(vault, { action: WITHDRAW, party: receiver.target, amount: 51n, nonce: 1n });
  const sig = deterministicSig(keyA, withdrawal);
  const tx = { ...encodeVaultTransaction(withdrawal, sig), from: relayer.address };
  await expectCallError(vault, "TransferFailed", tx);
  await expectRevertedTx(relayer, tx);
  assert.equal(await evm.provider.getBalance(receiver.target), 0n);
  assert.equal(await evm.provider.getBalance(vault.target), ETH);
  assert.equal(await vault.totalLocked(), ETH);
  await assertAccount(vault, keyA.publicKey, ETH, 1n);
  await (await receiver.acceptNative()).wait();
  await send(relayer, withdrawal, sig);
  assert.equal(await receiver.payments(), 1n);
  assert.equal(await evm.provider.getBalance(receiver.target), withdrawal.amount);
  assert.equal(await evm.provider.getBalance(vault.target), ETH - withdrawal.amount);
  assert.equal(await vault.totalLocked(), ETH - withdrawal.amount);
  await assertAccount(vault, keyA.publicKey, ETH - withdrawal.amount, 2n);
});

test("old Groth16 selectors and bare ETH are not accepted; forced ETH creates no credit", async () => {
  const vault = await newVault();
  const deposit = req(vault);
  await send(payer, deposit, deterministicSig(keyA, deposit));
  const old = new Interface([
    "function deposit(uint256) payable",
    "function withdraw(address,uint256,uint256,uint256[2],uint256[2][2],uint256[2])",
    "function withdraw(address,uint256,uint256,uint256,uint256,uint256[2],uint256[2][2],uint256[2])",
  ]);
  const [a, b, c] = [[0n, 0n], [[0n, 0n], [0n, 0n]], [0n, 0n]];
  const call = { to: vault.target, from: payer.address, ...opts };
  for (const args of [[recipient.address, 1n, 1n, a, b, c], [recipient.address, 1n, 1n, 1n, 0n, a, b, c]]) {
    const fn = old.fragments.find((f) => f.name === "withdraw" && f.inputs.length === args.length);
    await assert.rejects(evm.provider.call({ ...call, data: old.encodeFunctionData(fn, args) }), { code: "CALL_EXCEPTION" });
  }
  await assert.rejects(evm.provider.call({ ...call, value: 1n, data: old.encodeFunctionData("deposit", [1n]) }), { code: "CALL_EXCEPTION" });
  await assert.rejects(evm.provider.call({ ...call, value: 1n }), { code: "CALL_EXCEPTION" });
  await evm.deploy(compiled[TEST_SOURCE].ForcedEther, vault.target, { value: 9n });
  assert.equal(await evm.provider.getBalance(vault.target), ETH + 9n);
  assert.equal(await vault.totalLocked(), ETH);
  await assertAccount(vault, keyA.publicKey, ETH, 1n);
  const withdrawal = req(vault, { action: WITHDRAW, party: recipient.address, amount: ETH + 1n, nonce: 1n });
  await expectCallError(vault, "InsufficientBalance", encodeVaultTransaction(withdrawal, deterministicSig(keyA, withdrawal)));
});
