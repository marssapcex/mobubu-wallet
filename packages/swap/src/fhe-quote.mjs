import { clearQuote, fundingLots, hash, LOT, lots, MAX_OUT, MAX_RATE, nonzero,
  routeRequest, signQuote, signSwap, time, uint, unixSeconds, verifyQuote } from './protocol.mjs';

// Existing worker's fixed CGGI preset, n=630. Refuse unknown widths or oversize frames before IPC.
function ct(value, width) {
  const keyId = nonzero(`0x${value?.keyId}`, 'TFHE cloud-key hash').slice(2);
  const size = width * (16 + 4 * 630);
  const encodedLength = 4 * Math.ceil(size / 3);
  const { blob } = value;
  if (value.backend !== 'tfhe-cggi' || value.width !== width || typeof blob !== 'string' || blob.length !== encodedLength ||
      Buffer.from(blob, 'base64').toString('base64') !== blob) throw new Error('invalid TFHE ciphertext envelope');
  return Object.freeze({ backend: 'tfhe-cggi', width, keyId, blob });
}
function inputOf(policy, request) {
  if (request.deployment !== policy.id) throw new Error('encrypted quote deployment mismatch');
  const meta = routeRequest(policy, request);
  const amount = ct(request.amount, 24), minimum = ct(request.minimum, 32);
  if (amount.keyId !== minimum.keyId) throw new Error('different TFHE keys');
  return Object.freeze({ ...meta, amount, minimum });
}
function inputHash(r) { return hash(['mobubu:quote:input:v1', r.deployment, r.from, r.to, r.key, r.nonce, r.amount, r.minimum]); }
function resultOf(packet, keyId) {
  const amount = ct(packet.output, 32), meets = ct(packet.meets, 1);
  if (amount.keyId !== keyId || meets.keyId !== keyId) throw new Error('TFHE result key mismatch');
  return { amount, meets };
}
function resultHash(result) { return hash(['mobubu:quote:output:v1', result.amount, result.meets]); }

/** User keeps the decryption key, and publishes only the two ciphertexts to the quote desk. */
export async function encryptQuoteRequest({ policy, client, route, amountIn, minOut }) {
  const meta = routeRequest(policy, route);
  const inputLots = fundingLots(policy, amountIn, meta.from), minimumLots = lots(minOut, meta.to, MAX_OUT);
  const [amount, minimum] = await Promise.all([client.encrypt(inputLots, 24), client.encrypt(minimumLots, 32)]);
  return inputOf(policy, { ...meta, amount, minimum });
}

/** Trusted quote desk: rates are configured by the liquidity operator, never taken from the request.
 * The evaluator has only the CGGI cloud key. The signed ticket attests evaluation, not a proof of opening.
 */
export function makeQuoteDesk({ policy, rates, secret, now = unixSeconds, fundSeconds = 1_800, paySeconds = 14_400 }) {
  const table = new Map();
  for (const [pair, rate] of Object.entries(rates)) {
    if (!/^(BTC|ETH|BNB)\/(BTC|ETH|BNB)$/.test(pair) || pair.split('/')[0] === pair.split('/')[1]) throw new TypeError('invalid rate route');
    table.set(pair, uint(rate, 'operator rate', MAX_RATE, 1n));
  }
  const fund = Number(uint(fundSeconds, 'funding window', 7_200n, 1n));
  const pay = Number(uint(paySeconds, 'settlement window', 86_400n, 1n));
  return Object.freeze({ async evaluate(request, evaluator) {
    const r = inputOf(policy, request);
    const rate = table.get(`${r.from}/${r.to}`);
    if (rate === undefined) throw new Error('swap lane disabled');
    const issued = time(now());
    // uint24 * uint24 fits in 48 bits. Q16 shift floors the output to a uint32 lot count.
    const product = await evaluator.mulConst(r.amount, rate, 48);
    const output = await evaluator.shr(product, 16);
    const meets = await evaluator.cmp(output, r.minimum, 'ge');
    if (time(now()) >= issued + fund) throw new Error('FHE evaluation exceeded funding window');
    const result = resultOf({ output, meets }, r.amount.keyId);
    const ticket = signQuote(policy, { ...r, rate, issued, fundUntil: issued + fund, payUntil: issued + fund + pay,
      inputHash: inputHash(r), outputHash: resultHash(result) }, secret);
    return Object.freeze({ ticket, output: result.amount, meets: result.meets });
  } });
}

/** Open ciphertexts only on the client's device. Sign clear exact settlement terms after both checks. */
export async function openQuoteAndSign({ policy, client, request, packet, userSecret, payer, recipient, refund, now = unixSeconds }) {
  const r = inputOf(policy, request);
  const q = verifyQuote(policy, packet.ticket);
  const result = resultOf(packet, r.amount.keyId);
  if (r.key !== q.key || r.nonce !== q.nonce || r.from !== q.from || r.to !== q.to || q.inputHash !== inputHash(r) ||
      q.outputHash !== resultHash(result) || time(now()) >= q.fundUntil) throw new Error('wrong or expired quote transcript');
  const input = await client.decrypt(r.amount), minimum = await client.decrypt(r.minimum);
  const amountIn = input * LOT[r.from], minOut = minimum * LOT[r.to];
  const [output, meets] = await Promise.all([client.decrypt(result.amount), client.decrypt(result.meets)]);
  if (meets !== 1n) throw new Error('encrypted output below minimum');
  if (output * LOT[r.to] !== clearQuote(q, amountIn, minOut)) throw new Error('bad encrypted quote arithmetic');
  return signSwap(policy, { payer, recipient, refund, amountIn, minOut }, q, userSecret);
}
