// Browser-safe note construction. Do not send a note opening to an API or a prover service.
import { nativeAsset, parseNativeAssetArg } from '../../../fhe-swap/src/network-catalog.mjs';

export const NOTE_VERSION = 'mobubu-pool-note-v1';
export const DEPTH = 20;
export const CAPACITY = 2 ** DEPTH;
export const MAX_VALUE = (1n << 96n) - 1n;
export const ZERO = '0x' + '00'.repeat(32);
export const MAX_SATS = 2_100_000_000_000_000n;

export function bytes(hex, length) {
  if (typeof hex !== 'string' || hex.length !== 2 + length * 2 || !/^0x[0-9a-f]+$/.test(hex)) throw new TypeError('noncanonical hex');
  return Uint8Array.from({ length }, (_, i) => Number.parseInt(hex.slice(2 + i * 2, 4 + i * 2), 16));
}
export const hex = (bytes) => '0x' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
export function word(value, length) {
  if (typeof value !== 'bigint' || value < 0n || value >= 1n << BigInt(length * 8)) throw new RangeError('integer out of range');
  return bytes('0x' + value.toString(16).padStart(length * 2, '0'), length);
}
export function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, v) => n + v.length, 0));
  let pos = 0;
  for (const v of parts) { out.set(v, pos); pos += v.length; }
  return out;
}
export async function hash(tag, ...parts) {
  return hex(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', concat(Uint8Array.of(tag), ...parts))));
}
export const nonzero32 = (v) => {
  const b = bytes(v, 32);
  if (v === ZERO) throw new RangeError('zero value');
  return b;
};
export function assetFor(asset) { return nativeAsset(parseNativeAssetArg(asset)); }
export function baseUnits(value, asset) {
  const max = assetFor(asset).symbol === 'BTC' ? MAX_SATS : MAX_VALUE;
  if (typeof value === 'string' && /^(0|[1-9][0-9]{0,28})$/.test(value)) value = BigInt(value);
  if (typeof value !== 'bigint' || value < 1n || value > max) throw new RangeError('invalid native amount');
  return value;
}
export function parseAmount(text, asset) {
  const { decimals } = assetFor(asset);
  if (typeof text !== 'string' || text.length > 49 || !/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(text)) throw new TypeError('invalid decimal amount');
  const [whole, fraction = ''] = text.split('.');
  if (fraction.length > decimals) throw new RangeError(`at most ${decimals} decimal places`);
  return baseUnits(BigInt(whole + fraction.padEnd(decimals, '0')), asset);
}
export function formatAmount(units, asset) {
  const { decimals } = assetFor(asset);
  const padded = baseUnits(units, asset).toString().padStart(decimals + 1, '0');
  const remainder = padded.slice(-decimals).replace(/0+$/, '');
  return padded.slice(0, -decimals) + (remainder ? `.${remainder}` : '');
}
export async function evmDomain(chainId, vault) { return hash(5, word(BigInt(chainId), 32), bytes(vault.toLowerCase(), 20)); }
export async function bitcoinDomain(genesis, poolScriptHash) { return hash(6, nonzero32(genesis), nonzero32(poolScriptHash)); }
export const noteKey = (domain, secret) => hash(1, nonzero32(domain), nonzero32(secret));
export const noteLeaf = (domain, key, units) => {
  if (typeof units !== 'bigint' || units <= 0n || units > MAX_VALUE) throw new RangeError('invalid note value');
  return hash(2, nonzero32(domain), nonzero32(key), word(units, 16));
};
export const noteNullifier = (domain, secret, leaf) => hash(3, nonzero32(domain), nonzero32(secret), nonzero32(leaf));
export const parent = (left, right) => hash(4, bytes(left, 32), bytes(right, 32));

// A draft is a capability, not a balance or evidence that a deposit happened.
export async function createNote({ asset, domain, value }) {
  const draft = { version: NOTE_VERSION, asset: assetFor(asset).id, domain, value: baseUnits(value, asset).toString(),
    secret: hex(globalThis.crypto.getRandomValues(new Uint8Array(32))) };
  return readNote(draft);
}
export async function readNote(draft) {
  if (draft?.version !== NOTE_VERSION) throw new TypeError('wrong note version');
  const { domain, secret } = draft, asset = nativeAsset(draft.asset).id;
  const value = baseUnits(draft.value, asset);
  const key = await noteKey(domain, secret);
  const leaf = await noteLeaf(domain, key, value);
  if ((Object.hasOwn(draft, 'key') && draft.key !== key) || (Object.hasOwn(draft, 'leaf') && draft.leaf !== leaf)) {
    throw new Error('note does not match its commitment');
  }
  return Object.freeze({ version: NOTE_VERSION, asset, domain, value: value.toString(), secret, key, leaf });
}
export async function merkleRoot(leaf, index, siblings, count) {
  if (!Number.isInteger(count) || count < 1 || count > CAPACITY || !Number.isInteger(index) || index < 0 || index >= count ||
      !Array.isArray(siblings) || siblings.length !== DEPTH) throw new RangeError('invalid note path or count');
  let root = leaf, i = index;
  nonzero32(leaf);
  for (const sibling of siblings) {
    root = (i & 1) ? await parent(sibling, root) : await parent(root, sibling);
    i >>= 1;
  }
  return root;
}
export async function emptyNodes() {
  const nodes = [ZERO];
  for (let i = 0; i < DEPTH; i++) nodes.push(await parent(nodes[i], nodes[i]));
  return nodes;
}
