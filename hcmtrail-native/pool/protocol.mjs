import { AbiCoder, ZeroAddress, ZeroHash, decodeBase64, encodeBase64, getAddress, id, keccak256, parseEther, toBeHex, toUtf8Bytes, toUtf8String } from 'ethers';
import { GOLDILOCKS, STARK_IMAGE, STARK_NOTE_LIMIT, STARK_PARAMS } from '../testnet/networks.mjs';
import { limbs4, pack, seedEntry, uint, unpack } from '../testnet/notes-core.mjs';

export const ETH = Object.freeze({ assetId: 0n, decimals: 18 });
export const MIN_DEPOSIT = parseEther('0.01');
export const MAX_PART = STARK_NOTE_LIMIT;
export const U256 = (1n << 256n) - 1n;
export const MAX_TARGET = 100;
export const MIN_TARGET = 5;
export const NOTE_SCHEMA = 'hcmtrail.eth-pool.note.v3';
export const FEE_BPS = 9n;
export const abi = AbiCoder.defaultAbiCoder();
export const BATCH_TERMS = 'tuple(uint256 amount,uint64 round,uint8 target,address recipient,bytes32 salt)';
const BATCH_TAG = id('hcmtrail.eth-pool.reserve.v3');
const HEADER = `0x4e4f585007000100${STARK_PARAMS.slice(2)}`;
export const MAX_BACKUP_BYTES = 2_000_000;
const MAX_BACKUP_NOTES = 4096; // client file/resource limit, not an amount limit on chain

export function need(ok, message) { if (!ok) throw new Error(message); }
export const json = (x) => JSON.stringify(x, (_, v) => typeof v === 'bigint' ? `${v}` : v);
export function parseProver(text) {
  return JSON.parse(text, (_, value, context) => typeof value === 'number' ? uint(context?.source, (1n << 64n) - 1n) : value);
}

export function parseAmount(text, min = 1n) {
  // Accept a decimal comma as a separator in the Vietnamese UI. No grouping or rounding.
  const cleaned = text.trim().replace(',', '.');
  need(/^(?:0|[1-9][0-9]{0,59})(?:\.[0-9]{1,18})?$/.test(cleaned), 'Nhập số ETH dương, tối đa 18 chữ số thập phân.');
  const amount = parseEther(cleaned);
  need(amount >= min && amount <= U256, min === MIN_DEPOSIT ? 'Nạp tối thiểu 0,01 ETH.' : 'Số ETH ngoài phạm vi.');
  return amount;
}

export function targetCount(text) {
  need(/^[1-9][0-9]{0,2}$/.test(text) && Number(text) >= MIN_TARGET && Number(text) <= MAX_TARGET,
    'Chọn sĩ số từ 5 đến 100, không cần bội số của 5.');
  return Number(text);
}

export function poolDomain(chainId, pool) {
  return keccak256(abi.encode(['string', 'uint256', 'address', 'bytes32'], ['HCMTRAIL-ETH-POOL-v3', chainId, pool, STARK_IMAGE]));
}

export function payoutAddress(text, pool, staking = ZeroAddress) {
  const to = text.trim();
  need(/^0x[0-9a-fA-F]{40}$/.test(to), 'Nhập địa chỉ Ethereum 0x, đủ 40 ký tự hex.');
  const addr = getAddress(to);
  need(addr !== ZeroAddress && addr !== getAddress(pool) && addr !== getAddress(staking), 'Không thể nhận vào địa chỉ 0, pool hoặc hợp đồng staking.');
  return addr;
}

export function ticketId(domain, terms) {
  return keccak256(abi.encode(['bytes32', BATCH_TERMS], [domain, terms]));
}

export function quoteFee(gross) {
  gross = uint(gross, U256, 'gross wei');
  const fee = gross * FEE_BPS / 10_000n;
  return { fee, net: gross - fee };
}

export function directLeg(recipient, gross, staking) {
  gross = uint(gross, MAX_PART, 'withdrawal wei');
  const { fee, net } = quoteFee(gross);
  const feeRecipient = fee === 0n ? ZeroAddress : getAddress(staking);
  need(gross > 0n && (fee === 0n || feeRecipient !== ZeroAddress), 'Sai số wei hoặc hợp đồng staking.');
  return { recipient: getAddress(recipient), amount: net, feeRecipient, fee, tag: 0n };
}
export function reservationLeg(domain, terms, value, refundOwner) {
  const digest = BigInt(keccak256(abi.encode(['bytes32', 'bytes32', 'bytes32'], [BATCH_TAG, ticketId(domain, terms), refundOwner])));
  const to = (n) => getAddress(toBeHex(n, 20));
  if (value === 1n) {
    return { recipient: to(BigInt.asUintN(160, digest)), amount: 1n, feeRecipient: ZeroAddress, fee: 0n,
      tag: 1n + BigInt.asUintN(63, digest >> 160n) };
  }
  return { recipient: to((1n << 128n) | (digest >> 128n)), amount: value - 1n,
    feeRecipient: to((1n << 128n) | BigInt.asUintN(128, digest)), fee: 1n, tag: 1n };
}

export function privateBackup(context, notes, refunds = []) {
  need(notes.length <= MAX_BACKUP_NOTES && refunds.length <= MAX_BACKUP_NOTES, 'Bản sao có quá nhiều note; tách file trước khi tiếp tục.');
  return { schema: NOTE_SCHEMA, ...context, notes: notes.map(({ value, secret, blinding, leaf }) => ({ value, secret, blinding, leaf })), refunds };
}

export function readBackup(data, context, codec) {
  need(data?.schema === NOTE_SCHEMA && Object.entries(context).every(([k, v]) => data[k] === v),
    'Note thuộc pool hoặc phiên devnet khác.');
  need(Array.isArray(data.notes) && data.notes.length > 0 && data.notes.length <= MAX_BACKUP_NOTES &&
    Array.isArray(data.refunds) && data.refunds.length <= MAX_BACKUP_NOTES, 'File note không hợp lệ hoặc quá lớn.');
  const notes = data.notes.map((n) => {
    const note = codec.openNote(ETH, n.value, limbs4(n.secret), limbs4(n.blinding));
    need(note.leaf === n.leaf && note.value !== 0n, 'Một cam kết trong note không khớp.');
    return note;
  });
  const uniqueNotes = new Map(notes.map((n) => [n.leaf, n]));
  need(uniqueNotes.size === notes.length, 'File chứa note trùng.');
  const refunds = data.refunds.map((r) => {
    const t = r.terms;
    const terms = { amount: uint(t.amount, U256), round: uint(t.round, (1n << 64n) - 1n),
      target: targetCount(String(t.target)), recipient: payoutAddress(t.recipient, context.pool), salt: toBeHex(t.salt, 32) };
    const note = uniqueNotes.get(r.leaf);
    const nullifier = pack(unpack(r.nullifier));
    need(note && terms.round > 0n && terms.amount >= note.value && nullifier !== ZeroHash, 'Dữ liệu hoàn note không hợp lệ.');
    return { terms, leaf: note.leaf, nullifier };
  });
  need(new Set(refunds.map((r) => r.nullifier)).size === refunds.length, 'File chứa bản hoàn trùng.');
  return { notes, refunds };
}

const encodeUrl = (bytes) => encodeBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const MAX_KEY_LENGTH = Math.ceil(MAX_BACKUP_BYTES * 4 / 3) + 48;

/// The text key is a bearer backup, not a wallet private key and not encrypted.
/// The checksum catches transcription errors; pool/chain validation still applies.
export function encodeNoteKey(backup) {
  const bytes = toUtf8Bytes(json(backup));
  need(backup.schema === NOTE_SCHEMA && bytes.length <= MAX_BACKUP_BYTES, 'Khóa note vượt giới hạn hoặc sai phiên bản.');
  return `hceth3.${encodeUrl(bytes)}.${keccak256(bytes).slice(2, 18)}`;
}

export function decodeNoteKey(key) {
  need(typeof key === 'string' && key.length <= MAX_KEY_LENGTH, 'Khóa note vượt giới hạn.');
  const m = /^hceth3\.([A-Za-z0-9_-]+)\.([0-9a-f]{16})$/.exec(key.trim());
  need(m, 'Cần khóa note hceth3, không phải private key ví.');
  const bytes = decodeBase64(m[1].replace(/-/g, '+').replace(/_/g, '/'));
  need(bytes.length <= MAX_BACKUP_BYTES && encodeUrl(bytes) === m[1] && keccak256(bytes).slice(2, 18) === m[2], 'Khóa note sai checksum.');
  const data = JSON.parse(toUtf8String(bytes));
  need(data?.schema === NOTE_SCHEMA, 'Sai phiên bản khóa note.');
  return data;
}

export function depositGrosses(amount) {
  amount = uint(amount, U256, 'deposit wei');
  need(amount >= MIN_DEPOSIT, 'Nạp tối thiểu 0,01 ETH.');
  // Each tx carries at most 4 net notes. Invert the exact gross-to-net fee.
  const cap = 4n * MAX_PART * 10_000n / (10_000n - FEE_BPS);
  const count = (amount + cap - 1n) / cap;
  need(4n * count <= BigInt(MAX_BACKUP_NOTES), 'Vượt tài nguyên cho một khóa note; chia thành các lần nạp nhỏ hơn.');
  const values = [];
  for (let left = amount; left > 0n;) {
    let gross = left > cap ? cap : left;
    // The last transaction must also meet the gross minimum.
    if (left > cap && left - cap < MIN_DEPOSIT) gross = left - MIN_DEPOSIT;
    values.push(gross);
    left -= gross;
  }
  return values;
}

export function splitDeposit(amount, codec) {
  return depositGrosses(amount).map((gross) => {
    const { fee, net } = quoteFee(gross);
    const notes = [];
    for (let n = net; n > 0n;) {
      const value = n > MAX_PART ? MAX_PART : n;
      notes.push(codec.openNote(ETH, value));
      n -= value;
    }
    return { gross, fee, net, notes };
  });
}

export function prepareProof(codec, snapshot, row, leg) {
  const { note, index } = row;
  const { root, leaves, timestamp } = snapshot;
  const debit = leg.amount + leg.fee;
  need(index > 0 && leaves[index] === note.leaf && debit > 0n && debit <= note.value, 'Note không khớp cây hoặc không đủ ETH.');
  const dummy = codec.openNote(ETH, 0n);
  const time = BigInt(timestamp) / 600n * 600n;
  const request = { asset_id: ETH.assetId, note_root: root, assoc_root: root, pool_leaves: leaves, assoc_leaves: leaves,
    input_pool_index: [index, 0n], input_assoc_index: [index, 0n], recipient: leg.recipient, fee_recipient: leg.feeRecipient,
    clearing_price: leg.tag, not_before: time, public_amount: leg.amount, fee: leg.fee,
    output_values: [note.value - debit, 0n], self_submit: leg.fee === 0n, any_amount: true };
  const seed = { secrets: [note.secret, dummy.secret], notes: [seedEntry(note, ETH), seedEntry(dummy, ETH)] };
  return { request, seed, expectedNullifier: codec.noteNullifier(note, BigInt(index)) };
}

export function statement(spend, leg) {
  const addr = (to) => Array.from({ length: 4 }, (_, i) => BigInt.asUintN(48, BigInt(to) >> (48n * BigInt(i))));
  return [spend.root, spend.root, ...spend.nullifiers, ...spend.change].flatMap(unpack)
    .concat(leg.amount, leg.fee, ETH.assetId, leg.tag, addr(leg.recipient), addr(leg.feeRecipient), BigInt(spend.notBefore));
}

export function validateProof(codec, plan, proof, data) {
  need(typeof proof === 'string' && /^0x[0-9a-f]+$/.test(proof) && proof.length % 2 === 0 && proof.startsWith(HEADER) &&
    proof.length >= 60_122 && proof.length <= 256_002, 'Proof lệch định dạng STARK đã ghim.');
  const req = plan.request;
  need(Array.isArray(data.publics) && data.publics.length === 37, 'Proof không có đúng 37 public limbs.');
  const w = data.publics.map((v) => uint(v, GOLDILOCKS - 1n));
  const dig = (at) => pack(w.slice(at, at + 4));
  const spend = { root: req.note_root, nullifiers: [dig(8), dig(12)], change: [dig(16), dig(20)], notBefore: req.not_before };
  const leg = { recipient: req.recipient, feeRecipient: req.fee_recipient, tag: req.clearing_price,
    amount: req.public_amount, fee: req.fee };
  need(spend.nullifiers[0] === plan.expectedNullifier && spend.nullifiers[0] !== spend.nullifiers[1] &&
    ![...spend.nullifiers, ...spend.change].includes(ZeroHash) && statement(spend, leg).every((n, i) => w[i] === n),
    'Proof không khớp note hoặc điều khoản đã xác nhận.');
  need(data.outputs?.length === 2, 'Thiếu opening của note tiền dư.');
  const change = data.outputs.map((o, i) => {
    need(o.owned === true && o.value === req.output_values[i] && o.asset_id === ETH.assetId, 'Sai giá trị hoặc chủ sở hữu của note dư.');
    const opened = codec.openNote(ETH, o.value, limbs4(o.secret), limbs4(o.blinding));
    need(opened.leaf === o.leaf && opened.leaf === spend.change[i] && opened.spendPk === pack(o.spend_pk), 'Opening note dư không khớp proof.');
    return opened;
  }).filter((n) => n.value > 0n);
  return { spend, proof, change };
}
