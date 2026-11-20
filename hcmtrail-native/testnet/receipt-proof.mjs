import { concat, encodeRlp, getBytes, hexlify, keccak256, toBeHex } from 'ethers';

export const RECEIPT_PROOF_LIMITS = Object.freeze({ bytes: 65_535, headers: 33, headerBytes: 4096,
  nodes: 11, nodeBytes: 32_768, logIndex: 255 });
const MAX_RECEIPTS = 16_384;
const MAX_RLP_INPUT = 32 * 1024 * 1024;
const ZERO_RLP = '0x';

function requireProof(ok, message) { if (!ok) throw new Error(message); }
function bytes(value, size, label) {
  requireProof(typeof value === 'string' && /^0x(?:[0-9a-f]{2})*$/i.test(value) &&
    (size === undefined || value.length === 2 + size * 2), `Invalid ${label} bytes.`);
  return value.toLowerCase();
}
function quantity(value, label) {
  requireProof(typeof value === 'string' && /^0x(?:0|[1-9a-f][0-9a-f]{0,63})$/i.test(value), `Invalid ${label} quantity.`);
  return BigInt(value);
}
const small = (n) => n === 0n ? ZERO_RLP : toBeHex(n);

/** Reconstruct a supported execution header, never guessing missing or nonstandard RPC fields. */
export function executionHeader(block) {
  const h32 = (field) => bytes(block[field], 32, field);
  const n = (field) => small(quantity(block[field], field));
  const extra = bytes(block.extraData, undefined, 'extraData');
  requireProof((extra.length - 2) / 2 <= RECEIPT_PROOF_LIMITS.headerBytes, 'Oversize header extra data.');
  const entries = [h32('parentHash'), h32('sha3Uncles'), bytes(block.miner, 20, 'miner'), h32('stateRoot'),
    h32('transactionsRoot'), h32('receiptsRoot'), bytes(block.logsBloom, 256, 'logsBloom'),
    n('difficulty'), n('number'), n('gasLimit'), n('gasUsed'), n('timestamp'), extra,
    h32('mixHash'), bytes(block.nonce, 8, 'nonce')];
  const optional = [['baseFeePerGas', n], ['withdrawalsRoot', h32], ['blobGasUsed', n], ['excessBlobGas', n],
    ['parentBeaconBlockRoot', h32], ['requestsHash', h32]];
  let gap = false;
  for (const [field, encode] of optional) {
    if (block[field] == null) { gap = true; continue; }
    requireProof(!gap, 'Execution header has a gap in fork fields.');
    entries.push(encode(field));
  }
  const header = encodeRlp(entries);
  requireProof(getBytes(header).length <= RECEIPT_PROOF_LIMITS.headerBytes, 'Execution header exceeds proof limit.');
  requireProof(keccak256(header) === h32('hash'), 'Execution header does not reconstruct the block hash.');
  return header;
}

/** EIP-658 status receipts, including legacy and EIP-2718 types 1–4. */
export function executionReceipt(receipt) {
  const type = quantity(receipt.type, 'receipt type'), status = quantity(receipt.status, 'receipt status');
  const cumulativeGas = quantity(receipt.cumulativeGasUsed, 'receipt cumulative gas');
  requireProof(type <= 4n && status <= 1n && cumulativeGas > 0n && cumulativeGas <= (1n << 64n) - 1n,
    'Unsupported receipt type, status or cumulative gas.');
  requireProof(Array.isArray(receipt.logs) && (status === 1n || receipt.logs.length === 0), 'Invalid receipt log list.');
  const logs = receipt.logs.map((log) => {
    requireProof(Array.isArray(log.topics) && log.topics.length <= 4, 'Invalid log topics.');
    return [bytes(log.address, 20, 'log emitter'), log.topics.map((x) => bytes(x, 32, 'log topic')), bytes(log.data, undefined, 'log data')];
  });
  const payload = encodeRlp([small(status), small(cumulativeGas), bytes(receipt.logsBloom, 256, 'receipt bloom'), logs]);
  return type === 0n ? payload : concat([toBeHex(type, 1), payload]);
}

const txKey = (index) => [...getBytes(encodeRlp(small(BigInt(index))))].flatMap((b) => [b >> 4, b & 15]);
function compact(path, leaf) {
  const tape = [((leaf ? 2 : 0) | (path.length % 2)), ...(path.length % 2 === 0 ? [0] : []), ...path];
  return hexlify(Uint8Array.from(tape.filter((_, i) => i % 2 === 0).map((x, i) => 16 * x + tape[2 * i + 1])));
}
function node(fields, selected) {
  const rlp = encodeRlp(fields);
  // Receipt leaves include the entire 256-byte bloom. No receipt trie child is inlined.
  requireProof(getBytes(rlp).length >= 32, 'Unexpected short receipt trie node.');
  return { hash: keccak256(rlp), path: selected ? [rlp, ...selected] : undefined };
}
function trie(rows, depth) {
  if (rows.length === 1) {
    const [r] = rows;
    return node([compact(r.key.slice(depth), true), r.value], r.target ? [] : undefined);
  }
  const prefix = [];
  for (let i = depth; i < rows[0].key.length && rows.every((r) => r.key[i] === rows[0].key[i]); i++) prefix.push(rows[0].key[i]);
  if (prefix.length > 0) {
    const sub = trie(rows, depth + prefix.length);
    return node([compact(prefix, false), sub.hash], sub.path);
  }
  const groups = Array.from({ length: 16 }, () => []);
  let terminal;
  for (const r of rows) {
    if (r.key.length === depth) { requireProof(!terminal, 'Duplicate receipt key.'); terminal = r; }
    else groups[r.key[depth]].push(r);
  }
  const children = groups.map((group) => group.length > 0 ? trie(group, depth + 1) : null);
  const selected = terminal?.target ? [] : children.find((x) => x?.path)?.path;
  return node([...children.map((x) => x?.hash ?? ZERO_RLP), terminal?.value ?? ZERO_RLP], selected);
}

function safeNumber(n, max, label) {
  requireProof(Number.isSafeInteger(n) && n >= 0 && n <= max, `${label} outside proof limits.`);
  return n;
}
function frame(wire, max) {
  const size = getBytes(wire).length;
  requireProof(size > 0 && size <= max, 'Evidence frame outside proof limits.');
  return [toBeHex(size, 2), wire];
}

/** Build evidence for a caller-identified checkpoint. This never certifies that it was finalized. */
export function checkpointReceiptEvidence({ headers, blockReceipts, txIndex, logIndex }) {
  const limits = RECEIPT_PROOF_LIMITS;
  safeNumber(txIndex, 0xffffffff, 'Transaction index');
  safeNumber(logIndex, limits.logIndex, 'Receipt-local log index');
  requireProof(Array.isArray(headers) && headers.length > 0 && headers.length <= limits.headers, 'Invalid header history length.');
  for (let i = 1; i < headers.length; i++) {
    requireProof(bytes(headers[i - 1].parentHash, 32, 'parentHash') === bytes(headers[i].hash, 32, 'hash') &&
      quantity(headers[i - 1].number, 'block number') === quantity(headers[i].number, 'block number') + 1n,
    'Broken execution header history.');
  }
  const wires = headers.map(executionHeader);
  const target = headers.at(-1);
  requireProof(Array.isArray(target.transactions) && Array.isArray(blockReceipts) && logIndex < (blockReceipts[txIndex]?.logs?.length ?? 0) &&
    blockReceipts.length === target.transactions.length && blockReceipts.length <= MAX_RECEIPTS && txIndex < blockReceipts.length,
  'Need all receipts of the target block and an existing receipt-local log.');
  let inputBytes = 0;
  const rows = blockReceipts.map((receipt, i) => {
    requireProof(quantity(receipt.transactionIndex, 'receipt index') === BigInt(i) &&
      bytes(receipt.blockHash, 32, 'receipt blockHash') === bytes(target.hash, 32, 'block hash') &&
      quantity(receipt.blockNumber, 'receipt blockNumber') === quantity(target.number, 'block number') &&
      bytes(receipt.transactionHash, 32, 'receipt transactionHash') === bytes(target.transactions[i], 32, 'block transactionHash'),
    'Incomplete or mismatched block receipts.');
    const value = executionReceipt(receipt);
    inputBytes += (value.length - 2) / 2;
    requireProof(inputBytes <= MAX_RLP_INPUT, 'Receipt trie input exceeds builder limit.');
    return { key: txKey(i), value, target: txIndex === i };
  });
  const built = trie(rows, 0);
  requireProof(built.hash === bytes(target.receiptsRoot, 32, 'receiptsRoot'), 'Receipt trie does not match the block receiptsRoot.');
  requireProof(built.path?.length > 0 && built.path.length <= limits.nodes, 'Invalid receipt trie depth.');
  const proof = concat(['0x01', toBeHex(wires.length, 1), toBeHex(built.path.length, 1), toBeHex(txIndex, 4), toBeHex(logIndex, 2),
    ...wires.flatMap((x) => frame(x, limits.headerBytes)), ...built.path.flatMap((x) => frame(x, limits.nodeBytes))]);
  requireProof(getBytes(proof).length <= limits.bytes, 'Proof exceeds byte limit.');
  return proof;
}

/** Collect bounded execution history by hash; no default RPC, no signer and no `latest` or finality inference. */
export async function collectReceiptEvidence(rpc, { checkpointHash, blockHash, txIndex, logIndex }) {
  safeNumber(txIndex, 0xffffffff, 'Transaction index');
  safeNumber(logIndex, RECEIPT_PROOF_LIMITS.logIndex, 'Receipt-local log index');
  const targetHash = bytes(blockHash, 32, 'block hash');
  let cursor = bytes(checkpointHash, 32, 'checkpoint hash');
  const headers = [];
  for (let i = 0; i < RECEIPT_PROOF_LIMITS.headers; i++) {
    const b = await rpc('eth_getBlockByHash', [cursor, false]);
    requireProof(b && bytes(b.hash, 32, 'returned block hash') === cursor, 'Missing or mismatched header in checkpoint history.');
    headers.push(b);
    if (cursor === targetHash) {
      requireProof(Array.isArray(b.transactions) && b.transactions.length <= MAX_RECEIPTS && txIndex < b.transactions.length,
        'Target transaction outside block receipts.');
      const blockReceipts = [];
      for (let j = 0; j < b.transactions.length; j += 16) {
        const page = await Promise.all(b.transactions.slice(j, j + 16).map((tx) =>
          rpc('eth_getTransactionReceipt', [bytes(tx, 32, 'block transaction hash')])));
        requireProof(page.every(Boolean), 'RPC omitted a block receipt.');
        blockReceipts.push(...page);
      }
      return checkpointReceiptEvidence({ headers, blockReceipts, txIndex, logIndex });
    }
    cursor = bytes(b.parentHash, 32, 'parentHash');
  }
  throw new Error('Target outside the bounded checkpoint ancestry.');
}
