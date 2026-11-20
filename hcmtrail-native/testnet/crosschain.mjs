import { AbiCoder, keccak256, toUtf8Bytes } from 'ethers';
import { daoFee } from './dao-policy.mjs';
import { CUSTODY_CAP_EVM, CUSTODY_CAP_TVM, TESTNETS } from './networks.mjs';
import { noteNullifier, openNote, seedEntry } from './notes.mjs';
import { proofHash, proveLocal } from './prover.mjs';
import { challengeAddresses } from './staking.mjs';
import { need } from './store.mjs';

const abi = AbiCoder.defaultAbiCoder();
const domain = keccak256(toUtf8Bytes('hcmtrail.crosschain-native-withdrawal.v1'));
export const orderType = 'tuple(uint256 sourceChain,address sourceVault,uint256 destinationChain,address destinationVault,uint64 amountIn,uint96 minNetOut,uint96 liquidityLimit,address recipient,address sourceLP,address destinationLP,bytes32 refundOwnerCommit,bytes32 salt,uint64 acceptBy,uint64 payBy)';
export const rateType = 'tuple(bytes32 epoch,uint80 priceIn18,uint80 priceOut18,uint64 acceptedAt,uint96 grossOut)';
export const orderId = (order) => keccak256(abi.encode(['bytes32', orderType], [domain, order]));
export const rateHash = (rate) => keccak256(abi.encode([rateType], [rate]));
const coin = (chainId) => Object.values(TESTNETS).find((n) => n.chainId === BigInt(chainId));

// Local price preview only; final order lock reads currentPair() at execution.
export function previewOrder(order, input18, output18) {
  const src = coin(order.sourceChain), dst = coin(order.destinationChain);
  const input = BigInt(input18), output = BigInt(output18), amount = BigInt(order.amountIn);
  const limit = BigInt(order.liquidityLimit), min = BigInt(order.minNetOut);
  const priceCap = (1n << 80n) - 1n;
  need(src && dst && src !== dst && input > 0n && output > 0n && input <= priceCap && output <= priceCap &&
    amount >= 2n && amount <= (src.tvm ? CUSTODY_CAP_TVM : CUSTODY_CAP_EVM) && min > 0n &&
    limit <= (dst.tvm ? CUSTODY_CAP_TVM : (1n << 96n) - 1n), 'Invalid cross-chain pricing input.');
  const gross = amount * input * 10n ** BigInt(dst.decimals) / (output * 10n ** BigInt(src.decimals));
  const fee = daoFee(gross), net = gross - fee;
  need(net >= min && gross <= limit, 'Price outside order bounds.');
  return { gross, fee, net };
}

const refundFile = (id) => `cross-refund-${id}.json`;

export function saveCrosschainRefund(store, net, order, opening) {
  const { ownerCommit, leaf, secret, blinding } = openNote(net, BigInt(order.amountIn), opening.secret, opening.blinding);
  need(net.chainId === BigInt(order.sourceChain) && ownerCommit === order.refundOwnerCommit,
    'Refund backup does not open this order commitment.');
  const id = orderId(order), file = refundFile(id);
  if (store.has(file)) {
    need(store.read(file).leaf === leaf, 'Refusing to replace an existing refund backup.');
  } else store.write(file, { id, leaf, secret, blinding, value: BigInt(order.amountIn), sourceVault: order.sourceVault });
  return { id, refundNote: leaf }; // never return the opening to the gas sponsor
}

/// A local proof builder for a confirmed note/tree. Save the refund opening before sharing the order.
export async function proveCrosschain(store, net, prover, order, note, index, snapshot, report) {
  const amount = BigInt(order.amountIn);
  need(net.chainId === BigInt(order.sourceChain) && amount >= 2n && amount <= note.value && BigInt(index) > 0n &&
    snapshot.leaves[Number(index)] === note.leaf, 'Cross-chain order does not match the funded note.');
  const id = orderId(order);
  const backup = store.read(refundFile(id));
  need(backup.id === id && backup.sourceVault === order.sourceVault && backup.value === String(amount) &&
    openNote(net, amount, backup.secret, backup.blinding).ownerCommit === order.refundOwnerCommit,
  'Missing or invalid backup for the authorized refund note.');
  const [recipient, fee_recipient] = challengeAddresses(id);
  const dummy = openNote(net, 0n);
  const request = {
    asset_id: net.assetId, note_root: snapshot.root, assoc_root: snapshot.root,
    pool_leaves: snapshot.leaves, assoc_leaves: snapshot.leaves, input_pool_index: [BigInt(index), 0n], input_assoc_index: [BigInt(index), 0n],
    recipient, fee_recipient, clearing_price: 0n, not_before: snapshot.head.timestamp / 600n * 600n,
    public_amount: amount - 1n, fee: 1n, output_values: [note.value - amount, 0n], any_amount: true,
  };
  const seed = { secrets: [note.secret, dummy.secret], notes: [seedEntry(note, net), seedEntry(dummy, net)] };
  const result = await proveLocal(store, net, prover, request, seed, noteNullifier(note, index), report);
  const { root, nullifiers, change, notBefore } = result.exit;
  const changeNote = result.outputs[0];
  const proofId = proofHash(result.proof);
  if (changeNote.value > 0n) store.write(`cross-change-${proofId}.json`, { id, value: changeNote.value,
    leaf: changeNote.leaf, secret: changeNote.secret, blinding: changeNote.blinding, sourceVault: order.sourceVault });
  return { id, proofId, publicSpend: { root, nullifiers, change, notBefore }, proof: result.proof, seconds: result.proofSeconds };
}
