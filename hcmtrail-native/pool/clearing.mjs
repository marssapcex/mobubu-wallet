import { ZeroAddress, ZeroHash, getAddress, keccak256, toBeHex } from 'ethers';
import { abi, MAX_PART, need } from './protocol.mjs';
import { uint, word256 } from '../testnet/notes-core.mjs';
import { ARBITRUM, BASE, ETHEREUM } from '../testnet/networks.mjs';

export { ARBITRUM, BASE, ETHEREUM };
export const Packet = Object.freeze({ Open: 0, Paid: 1, Cancelled: 2 });
export const Stage = Object.freeze({ Unseen: 0n, Locked: 1n, Authorized: 2n, Paid: 3n, Cancelled: 4n, Settled: 5n, Refundable: 6n, Refunded: 7n });
export const NO_PACKET_GAS = Object.freeze({ gasLimit: 0n, maxFeePerGas: 0n, maxSubmissionCost: 0n, refundL2: ZeroAddress });
const U64 = (1n << 64n) - 1n;
const U128 = (1n << 128n) - 1n;
const EXIT_TAG = (1n << 63n) + 1n;
const ORDER = 'tuple(uint64 source,uint64 destination,uint64 gross,address recipient,bytes32 refundOwner,bytes32 cancelHash,bytes32 salt)';

export function packetPath(source, destination) {
  source = uint(source, U64, 'source');
  destination = uint(destination, U64, 'destination');
  need(source !== destination && [source, destination].every((x) => x === ETHEREUM || x === BASE || x === ARBITRUM),
    'Select two distinct ETH lanes');
  return source === ETHEREUM || destination === ETHEREUM ? [source, destination] : [source, ETHEREUM, destination];
}

export function exitId(networkDomain, o) {
  packetPath(o.source, o.destination);
  need(uint(o.gross, MAX_PART, 'gross wei') !== 0n && getAddress(o.recipient) !== ZeroAddress &&
    [o.refundOwner, o.cancelHash, o.salt].every((s) => word256(s) !== ZeroHash), 'Invalid exit order');
  return keccak256(abi.encode(['bytes32', ORDER], [networkDomain, o]));
}

export function readExitOrder(o) {
  return { source: uint(o.source, U64, 'source'), destination: uint(o.destination, U64, 'destination'),
    gross: uint(o.gross, MAX_PART, 'gross wei'), recipient: getAddress(o.recipient), refundOwner: word256(o.refundOwner),
    cancelHash: word256(o.cancelHash), salt: word256(o.salt) };
}

// Private backup metadata. The refund opening stays in `notes`. A cancellation
// preimage is independent of those openings and is made public only to cancel.
export function readRouteBackups(data, context, notes) {
  if (data.routes === undefined) return [];
  need(data.networkDomain === context.networkDomain && Array.isArray(data.routes) && data.routes.length <= notes.length,
    'Sai phiên lab hoặc danh sách rút liên mạng không hợp lệ.');
  const byLeaf = new Map(notes.map((n) => [n.leaf, n]));
  const routes = data.routes.map((r) => {
    const order = readExitOrder(r.order);
    const cancelSecret = word256(r.cancelSecret);
    const refundLeaf = word256(r.refundLeaf);
    const refund = byLeaf.get(refundLeaf);
    const id = exitId(context.networkDomain, order);
    need(r.id === id && order.source === BigInt(context.lane) && refund?.value === order.gross &&
      refund.ownerCommit === order.refundOwner && cancelSecret !== ZeroHash && keccak256(cancelSecret) === order.cancelHash,
    'Lệnh hoặc note hoàn không khớp khóa đã lưu.');
    return { id, order, refundLeaf, cancelSecret };
  });
  need(new Set(routes.map((r) => r.id)).size === routes.length, 'File chứa lệnh trùng.');
  return routes;
}

export function exitLeg(noteDomain, networkDomain, o) {
  const hash = BigInt(keccak256(abi.encode(['bytes32', 'bytes32'], [noteDomain, exitId(networkDomain, o)])));
  const gross = BigInt(o.gross);
  const to = (n) => getAddress(toBeHex(n, 20));
  if (gross === 1n) return { amount: 1n, fee: 0n, recipient: to(BigInt.asUintN(160, hash)), feeRecipient: ZeroAddress,
    tag: EXIT_TAG + BigInt.asUintN(62, hash >> 160n) };
  return { amount: gross - 1n, fee: 1n, recipient: to((1n << 128n) | (hash >> 128n)),
    feeRecipient: to((1n << 128n) | BigInt.asUintN(128, hash)), tag: EXIT_TAG };
}

export function retryableBudget(bid) {
  const gasLimit = uint(bid.gasLimit, U64, 'gas limit');
  const price = uint(bid.maxFeePerGas, U128, 'gas price');
  const submission = uint(bid.maxSubmissionCost, U128, 'submission cost');
  need(gasLimit >= 250_000n && gasLimit <= 2_000_000n && price > 1n && getAddress(bid.refundL2) !== ZeroAddress,
    'Invalid retryable gas bid');
  return gasLimit * price + submission;
}
