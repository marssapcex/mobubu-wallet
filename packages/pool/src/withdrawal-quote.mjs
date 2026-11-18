import { baseUnits, assetFor, ZERO } from './notes.mjs';
import { DUST, hash, nonzero, pqSign, pqVerify, uint, time, unixSeconds } from '../../swap/src/protocol.mjs';
import { Buffer } from 'node:buffer';

const U64 = (1n << 64n) - 1n;
const U256 = (1n << 256n) - 1n;
const AMOUNT_BITS = 96;
const routeId = 'mobubu:pool:withdrawal-quote:v1';
const inputId = 'mobubu:pool:withdrawal-request:v1';
const outputId = 'mobubu:pool:withdrawal-result:v1';

export function rationalRate({ numerator, denominator }) {
  const n = uint(numerator, 'rate numerator', U256, 1n), d = uint(denominator, 'rate denominator', U256, 1n);
  let a = n, b = d;
  while (b) [a, b] = [b, a % b];
  if (n / a > U64 || d / a > U64) throw new RangeError('reduced rate does not fit uint64');
  return Object.freeze({ numerator: n / a, denominator: d / a });
}
/** Construct a conservative representable rate from an operator's pinned,
 * already refreshed oracle. At most 1 ppm below reference; no fallback on stale data.
 * A power-of-two denominator lets CGGI divide with shifts rather than gates. */
export function oracleRateResolver(oracle) {
  return (route) => {
    const { from, to } = withdrawalRoute(route), a = assetFor(from), b = assetFor(to);
    const snapshot = oracle.snapshot();
    const x = snapshot.pricesUsd18[a.symbol] * 10n ** BigInt(b.decimals);
    const y = snapshot.pricesUsd18[b.symbol] * 10n ** BigInt(a.decimals);
    if (x <= 0n || y <= 0n) throw new Error('invalid reference prices');
    for (let shift = 63n; shift >= 0n; --shift) {
      const denominator = 1n << shift, scaled = x * denominator, numerator = scaled / y;
      if (numerator > U64) continue;
      if (numerator === 0n || (scaled - numerator * y) * 1_000_000n > scaled) break;
      return Object.freeze({ ...rationalRate({ numerator, denominator }), rateRef: nonzero(`0x${snapshot.id}`, 'oracle snapshot'), validUntil: time(snapshot.validUntil) });
    }
    throw new Error('reference price is outside representable rate range');
  };
}

function destinationUnits(value, asset) {
  const amount = baseUnits(value, asset);
  if (assetFor(asset).symbol === 'BTC' && amount < DUST) throw new RangeError('Bitcoin output below service dust floor');
  return amount;
}

export function exactOutput({ from, to, rate }, amount) {
  const { numerator, denominator } = rationalRate(rate);
  return destinationUnits(baseUnits(amount, from) * numerator / denominator, to);
}

function cipher(c, bits) {
  const size = 4 * Math.ceil(bits * (16 + 4 * 630) / 3);
  if (c?.backend !== 'tfhe-cggi' || c.width !== bits || typeof c.blob !== 'string' || c.blob.length !== size ||
      Buffer.from(c.blob, 'base64').toString('base64') !== c.blob) throw new Error('invalid CGGI envelope');
  const keyId = nonzero(`0x${c.keyId}`, 'CGGI key ID').slice(2);
  return Object.freeze({ backend: c.backend, width: bits, keyId, blob: c.blob });
}
function withdrawalRoute(r) {
  const from = assetFor(r.from).id, to = assetFor(r.to).id;
  if (from === to) throw new Error('same-chain withdrawal needs no quote');
  return { from, to, source: nonzero(r.source, 'source pool'), destination: nonzero(r.destination, 'destination pool'), nonce: nonzero(r.nonce, 'quote nonce') };
}
function input(r) {
  const meta = withdrawalRoute(r);
  const amount = cipher(r.amount, AMOUNT_BITS), minimum = cipher(r.minimum, AMOUNT_BITS);
  if (amount.keyId !== minimum.keyId) throw new Error('quote ciphertext key mismatch');
  return { ...meta, amount, minimum };
}
function result(pkt, bits, keyId) {
  const output = cipher(pkt.output, bits), meets = cipher(pkt.meets, 1);
  if (output.keyId !== keyId || meets.keyId !== keyId) throw new Error('quote result key mismatch');
  return { output, meets };
}
const productWidth = (rate) => AMOUNT_BITS + rate.numerator.toString(2).length;
const tagged = (tag, value) => hash([tag, value]);
const signable = (ticket) => Buffer.from(tagged(routeId, ticket).slice(2), 'hex');

/** No note opening, leaf, Merkle path, SLH key or deposit tx goes to the price desk. */
export async function encryptWithdrawal({ client, withdrawal, amount, minimum }) {
  const meta = withdrawalRoute(withdrawal);
  const a = baseUnits(amount, meta.from), m = destinationUnits(minimum, meta.to);
  return input({ ...meta, amount: await client.encrypt(a, AMOUNT_BITS), minimum: await client.encrypt(m, AMOUNT_BITS) });
}

/** resolveRate is trusted operator configuration (e.g. a verified fresh price snapshot), not client-supplied. */
export function makeWithdrawalQuoteDesk({ key, secret, resolveRate, now = unixSeconds, ttl = 180 }) {
  nonzero(key, 'desk key');
  if (typeof resolveRate !== 'function' || !Number.isInteger(ttl) || ttl < 1 || ttl > 600) throw new Error('invalid quote desk configuration');
  return Object.freeze({ async evaluate(request, cloud) {
    const r = input(request), meta = withdrawalRoute(r), issued = time(now());
    const resolved = await resolveRate(meta), rate = rationalRate(resolved);
    const rateRef = resolved.rateRef === undefined ? ZERO : nonzero(resolved.rateRef, 'rate reference');
    const expires = Math.min(issued + ttl, resolved.validUntil === undefined ? issued + ttl : time(resolved.validUntil));
    if (time(now()) >= expires) throw new Error('withdrawal rate expired');
    const bits = productWidth(rate);
    const product = await cloud.mulConst(r.amount, rate.numerator, bits);
    const output = await cloud.divConst(product, rate.denominator, bits);
    const meets = await cloud.cmp(output, await cloud.resize(r.minimum, bits), 'ge');
    const evaluated = result({ output, meets }, bits, r.amount.keyId);
    const terms = Object.freeze({ ...meta, rate, rateRef, issued, expires,
      inputHash: tagged(inputId, r), resultHash: tagged(outputId, evaluated) });
    if (time(now()) >= terms.expires) throw new Error('quote expired during evaluation');
    return Object.freeze({ ...evaluated, terms, signature: pqSign(secret, key, signable(terms)) });
  } });
}

async function openWide(client, ct) {
  if (ct.width <= 128) return client.decrypt(ct);
  const lo = await client.decrypt(await client.resize(ct, AMOUNT_BITS));
  const hi = await client.decrypt(await client.shr(ct, AMOUNT_BITS));
  return lo | (hi << BigInt(AMOUNT_BITS));
}

/** Use only after a fresh request initiated on this user's client. No spending authority. */
export async function openWithdrawalQuote({ client, request, reply, deskKey, now = unixSeconds }) {
  const r = input(request), meta = withdrawalRoute(reply.terms), rate = rationalRate(reply.terms.rate);
  const issued = time(reply.terms.issued), expires = time(reply.terms.expires), clock = time(now());
  if (clock < issued || clock >= expires || expires - issued < 1 || expires - issued > 600 || hash(meta) !== hash(withdrawalRoute(r))) throw new Error('wrong or expired withdrawal quote');
  const evaluated = result(reply, productWidth(rate), r.amount.keyId);
  const rateRef = reply.terms.rateRef === ZERO ? ZERO : nonzero(reply.terms.rateRef, 'rate reference');
  const terms = { ...meta, rate, rateRef, issued, expires, inputHash: tagged(inputId, r), resultHash: tagged(outputId, evaluated) };
  const message = signable(terms);
  if (reply.terms.inputHash !== terms.inputHash || reply.terms.resultHash !== terms.resultHash || !pqVerify(deskKey, message, reply.signature)) throw new Error('invalid withdrawal quote transcript');
  const amount = await client.decrypt(r.amount), minimum = await client.decrypt(r.minimum);
  if (await client.decrypt(evaluated.meets) !== 1n) throw new Error('withdrawal below encrypted minimum');
  const output = await openWide(client, evaluated.output);
  if (output !== exactOutput({ ...meta, rate }, amount) || output < destinationUnits(minimum, meta.to)) throw new Error('withdrawal quote arithmetic mismatch');
  if (time(now()) >= expires) throw new Error('withdrawal quote expired');
  return Object.freeze({ ...terms, id: `0x${message.toString('hex')}`, debit: amount, out: output, minimum });
}
