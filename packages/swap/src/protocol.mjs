import { createHash, randomBytes } from 'node:crypto';
import { address as btcAddress, networks, opcodes } from 'bitcoinjs-lib';
import * as secp from 'tiny-secp256k1';
import { AbiCoder, ZeroAddress, ZeroHash, getAddress, getBytes, hexlify, id, keccak256, sha256 } from 'ethers';
import { slh_dsa_sha2_128s as slh } from '@noble/post-quantum/slh-dsa.js';

export const ASSETS = Object.freeze(['BTC', 'ETH', 'BNB']);
// Quote in exact, public lot units. No rounding of user inputs or minimums.
export const LOT = Object.freeze({ BTC: 100n, ETH: 1_000_000_000_000n, BNB: 1_000_000_000_000n });
export const DUST = 1_000n;
export const RATE_SHIFT = 16n;
export const MAX_IN = (1n << 24n) - 1n;
export const MAX_OUT = (1n << 32n) - 1n;
export const MAX_RATE = (1n << 24n) - 1n;
export const PAY = 1, REFUND = 2, COLLECT = 3, REJECT = 4;
export const ORDER_DOMAIN = id('mobubu:native-swap:order:v1');
export const SETTLE_DOMAIN = id('mobubu:native-swap:rail:settle:v1');
const abi = AbiCoder.defaultAbiCoder();
export const ORDER_TUPLE = 'tuple(bytes32 deployment,bytes32 key,bytes32 nonce,bytes32 source,bytes32 destination,bytes32 quote,address payer,bytes32 recipient,bytes32 refund,uint256 amountIn,uint256 amountOut,uint256 minOut,uint64 fundUntil,uint64 payUntil)';
export const unixSeconds = () => Math.floor(Date.now() / 1000);
export const newNonce = () => hexlify(randomBytes(32));

export function uint(value, name, max, min = 0n) {
  if (typeof value === 'number' && Number.isSafeInteger(value)) value = BigInt(value);
  if (typeof value === 'string' && value.length <= 78 && /^(0|[1-9][0-9]*)$/.test(value)) value = BigInt(value);
  if (typeof value !== 'bigint' || value < min || value > max) throw new RangeError(`invalid ${name}`);
  return value;
}
export const time = (value, name = 'timestamp') => Number(uint(value, name, 8_640_000_000_000n, 1n));
export function hex(value, bytes, name = 'hexadecimal value') {
  if (typeof value !== 'string' || value.length !== 2 + 2 * bytes || !/^0x[0-9a-f]+$/i.test(value)) throw new TypeError(`invalid ${name}`);
  return value.toLowerCase();
}
export function nonzero(value, name) {
  const v = hex(value, 32, name);
  if (v === ZeroHash) throw new RangeError(`zero ${name}`);
  return v;
}
export function address(value) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) throw new TypeError('invalid EVM address');
  const a = getAddress(value);
  if (a === ZeroAddress) throw new TypeError('zero EVM address');
  return a;
}
export function asset(value) {
  if (!ASSETS.includes(value)) throw new TypeError('expected BTC, ETH, or BNB');
  return value;
}
export const encode = (value) => JSON.stringify(value, (_key, v) => typeof v === 'bigint' ? v.toString() : v);
export const hash = (value) => `0x${createHash('sha256').update(encode(value)).digest('hex')}`;
export const bytesHash = (bytes) => `0x${createHash('sha256').update(bytes).digest('hex')}`;
export function evmRailId(chainId, rail) {
  return keccak256(abi.encode(['string', 'uint256', 'address'], ['mobubu:native-swap:evm-rail:v1', chainId, rail]));
}

/** All actors pin the same immutable public deployment configuration. */
export function makePolicy(config) {
  const q = nonzero(config.quoter, 'quoter key');
  const b = config.BTC;
  if (!b || !Object.hasOwn(networks, b.network)) throw new TypeError('invalid Bitcoin address network');
  if (!Array.isArray(b.keys) || b.keys.length !== 3) throw new Error('Bitcoin needs three distinct compressed public keys');
  const keys = b.keys.map((k) => hex(k, 33, 'Bitcoin key')).sort();
  if (new Set(keys).size !== 3 || keys.some((k) => !secp.isPointCompressed(getBytes(k)))) throw new Error('invalid Bitcoin keys');
  const bitcoin = Object.freeze({
    network: b.network, genesis: nonzero(b.genesis, 'Bitcoin genesis'), keys: Object.freeze(keys),
    depth: Number(uint(b.depth, 'BTC confirmations', 100n, 1n)),
    fee: uint(b.fee, 'fixed Bitcoin fee', 100_000n, 1n),
    id: hash(['mobubu:native-swap:btc-rail:v1', b.network, nonzero(b.genesis, 'Bitcoin genesis'), keys, 2]),
  });
  const evm = (c) => {
    const chainId = uint(c.chainId, 'chainId', (1n << 64n) - 1n, 1n), rail = address(c.rail);
    return Object.freeze({ chainId, rail, id: evmRailId(chainId, rail), genesis: nonzero(c.genesis, 'EVM genesis'),
      codeHash: nonzero(c.codeHash, 'rail runtime code hash'), treasury: nonzero(c.treasury, 'treasury key'),
      depth: Number(uint(c.depth, 'EVM confirmations', 2_000n, 1n)) });
  };
  const rails = Object.freeze({ BTC: bitcoin, ETH: evm(config.ETH), BNB: evm(config.BNB) });
  if (rails.ETH.chainId === rails.BNB.chainId || [56n, 97n].includes(rails.ETH.chainId) ||
      [1n, 11_155_111n, 17_000n].includes(rails.BNB.chainId)) throw new Error('ETH/BNB chain identities overlap or are reversed');
  return Object.freeze({ quoter: q, rails, id: hash(['mobubu:native-swap:deployment:v1', q, rails]) });
}

export function pqSign(secret, publicKey, message) {
  if (!(secret instanceof Uint8Array) || secret.length !== 64) throw new TypeError('expected a 64-byte SLH-DSA secret');
  if (hexlify(slh.getPublicKey(secret)) !== nonzero(publicKey, 'signing key')) throw new Error('SLH-DSA key mismatch');
  return hexlify(slh.sign(message, secret));
}
export function pqVerify(publicKey, message, signature) {
  try { return slh.verify(getBytes(hex(signature, 7856, 'SLH-DSA signature')), message, getBytes(nonzero(publicKey, 'signing key'))); }
  catch { return false; }
}

export function destination(policy, chain, value) {
  const rail = policy.rails[asset(chain)];
  if (chain !== 'BTC') {
    const to = address(value);
    if (to === rail.rail) throw new Error('recipient cannot be the rail itself');
    return Object.freeze({ address: to, hash: sha256(to) });
  }
  if (typeof value !== 'string' || value.length > 90 || value.length < 14) throw new TypeError('invalid Bitcoin recipient');
  const network = networks[rail.network];
  const script = btcAddress.toOutputScript(value, network);
  if (script[0] >= opcodes.OP_1 && script[0] <= opcodes.OP_16 &&
      !(script[0] === opcodes.OP_1 && script.length === 34)) throw new Error('unsupported Bitcoin witness version');
  return Object.freeze({ address: btcAddress.fromOutputScript(script, network), script: hexlify(script), hash: sha256(script) });
}

export function routeRequest(policy, r) {
  const from = asset(r.from), to = asset(r.to);
  if (from === to) throw new Error('source and destination must be different native chains');
  return Object.freeze({ deployment: policy.id, from, to, key: nonzero(r.key, 'user key'), nonce: nonzero(r.nonce, 'order nonce') });
}

export function lots(amount, which, max) {
  const unit = LOT[asset(which)];
  const value = uint(amount, `${which} amount`, max * unit, unit);
  if (value % unit !== 0n) throw new RangeError(`${which} amount must be a whole lot of ${unit} base units`);
  if (which === 'BTC' && value < DUST) throw new RangeError('BTC amount below service minimum');
  return value / unit;
}

export function fundingLots(policy, amount, from) {
  const units = lots(amount, from, MAX_IN);
  if (from === 'BTC' && units * LOT.BTC < policy.rails.BTC.fee + DUST) throw new Error('BTC deposit cannot cover refund and fixed fee');
  return units;
}

function quoteFields(policy, t) {
  const request = routeRequest(policy, t);
  if (t.deployment !== policy.id) throw new Error('quote deployment mismatch');
  const rate = uint(t.rate, 'Q16 rate', MAX_RATE, 1n);
  const issued = time(t.issued), fundUntil = time(t.fundUntil), payUntil = time(t.payUntil);
  if (fundUntil <= issued || fundUntil - issued > 7_200 || payUntil <= fundUntil || payUntil - fundUntil > 86_400) {
    throw new RangeError('invalid funding/payment windows');
  }
  return Object.freeze({ ...request, rate, issued, fundUntil, payUntil,
    inputHash: nonzero(t.inputHash, 'encrypted input hash'), outputHash: nonzero(t.outputHash, 'encrypted result hash') });
}
function quoteMessage(t) {
  return Buffer.from(encode(['mobubu:native-swap:fhe-quote:v1', t.deployment,t.from,t.to,t.key,t.nonce,t.rate,t.issued,t.fundUntil,t.payUntil,t.inputHash,t.outputHash]));
}
export function signQuote(policy, fields, secret) {
  const quote = quoteFields(policy, fields);
  return Object.freeze({ ...quote, signature: pqSign(secret, policy.quoter, quoteMessage(quote)) });
}
export function verifyQuote(policy, packet) {
  const quote = quoteFields(policy, packet);
  const msg = quoteMessage(quote);
  if (!pqVerify(policy.quoter, msg, packet.signature)) throw new Error('invalid FHE quote signature');
  return Object.freeze({ ...quote, signature: hex(packet.signature, 7856), id: bytesHash(msg) });
}

export function clearQuote(q, input, min) {
  const x = lots(input, q.from, MAX_IN), y = lots(min, q.to, MAX_OUT);
  const output = (x * q.rate) >> RATE_SHIFT;
  if (output === 0n || output > MAX_OUT || output < y) throw new Error('quote below minimum or outside range');
  return output * LOT[q.to];
}

function orderTerms(policy, details, q) {
  const recipient = destination(policy, q.to, details.recipient), refund = destination(policy, q.from, details.refund);
  const amountIn = fundingLots(policy, details.amountIn, q.from) * LOT[q.from];
  const minOut = lots(details.minOut, q.to, MAX_OUT) * LOT[q.to];
  const amountOut = clearQuote(q, amountIn, minOut);
  const payer = q.from === 'BTC' ? ZeroAddress : address(details.payer);
  if (q.from === 'BTC' && details.payer !== undefined && details.payer !== ZeroAddress) throw new Error('Bitcoin funding does not use an EVM payer');
  const wire = Object.freeze({ deployment: policy.id, key: q.key, nonce: q.nonce, source: policy.rails[q.from].id,
    destination: policy.rails[q.to].id, quote: q.id, payer, recipient: recipient.hash, refund: refund.hash,
    amountIn, amountOut, minOut, fundUntil: q.fundUntil, payUntil: q.payUntil });
  const data = abi.encode(['bytes32', ORDER_TUPLE], [ORDER_DOMAIN, wire]);
  return { id: sha256(data), wire, recipient, refund, message: getBytes(data) };
}

export function signSwap(policy, details, ticket, secret) {
  const q = verifyQuote(policy, ticket);
  const o = orderTerms(policy, details, q);
  return Object.freeze({ quote: q, payer: o.wire.payer, recipient: o.recipient.address, refund: o.refund.address,
    amountIn: o.wire.amountIn, minOut: o.wire.minOut, amountOut: o.wire.amountOut,
    signature: pqSign(secret, q.key, o.message) });
}
export function verifySwap(policy, signed) {
  const quote = verifyQuote(policy, signed.quote);
  const { message, ...terms } = orderTerms(policy, signed, quote);
  if (uint(signed.amountOut, 'output', MAX_OUT * LOT[quote.to], 1n) !== terms.wire.amountOut) throw new Error('output does not match signed price');
  const signature = hex(signed.signature, 7856, 'user signature');
  if (!pqVerify(quote.key, message, signature)) throw new Error('invalid swap signature');
  return Object.freeze({ ...terms, quote, signature, from: quote.from, to: quote.to });
}
export function settlementMessage(rail, kind, orderId, recipient, amount, submitter) {
  return getBytes(abi.encode(['bytes32','bytes32','uint8','bytes32','address','uint256','address'],
    [SETTLE_DOMAIN, rail.id, kind, orderId, recipient, amount, submitter]));
}
