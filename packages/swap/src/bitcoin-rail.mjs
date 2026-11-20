import { Transaction, address, networks, opcodes, payments, script } from 'bitcoinjs-lib';
import * as secp from 'tiny-secp256k1';
import { getBytes, hexlify } from 'ethers';
import { COLLECT, DUST, PAY, REFUND, asset, encode, hash, hex, nonzero, time, uint, unixSeconds, verifySwap } from './protocol.mjs';
import { RpcError } from './rpc.mjs';

const MAX_SATS = 2_100_000_000_000_000n;
const SIGHASH = Transaction.SIGHASH_ALL;
const rawHex = (s) => Uint8Array.from(Buffer.from(s, 'hex'));
export function btcTxid(value) {
  if (typeof value !== 'string' || !/^[0-9a-fA-F]{64}$/.test(value)) throw new TypeError('invalid Bitcoin txid');
  return value.toLowerCase();
}
const vout = (v) => Number(uint(v, 'Bitcoin vout', 0xffff_ffffn));

export function bitcoinScript(policy, orderId) {
  const c = policy.rails.BTC;
  const keys = c.keys.map(getBytes);
  const prefix = orderId ? [getBytes(nonzero(orderId, 'order id')), opcodes.OP_DROP] : [];
  const witness = script.compile([...prefix, opcodes.OP_2, ...keys, opcodes.OP_3, opcodes.OP_CHECKMULTISIG]);
  const { address: to, output } = payments.p2wsh({ redeem: { output: witness }, network: networks[c.network] });
  return Object.freeze({ address: to, output: hexlify(output), witness: hexlify(witness) });
}

export function bitcoinFunding(policy, order) {
  if (order.from !== 'BTC') throw new Error('not a BTC deposit');
  return Object.freeze({ chain: 'BTC', address: bitcoinScript(policy, order.id).address, sats: order.wire.amountIn });
}

export function makeBitcoinRail({ policy, rpc }) {
  const c = policy.rails.BTC;
  const pool = bitcoinScript(policy);
  async function pin() {
    if (btcTxid(await rpc('getblockhash', [0])) !== c.genesis.slice(2)) throw new Error('wrong Bitcoin genesis');
  }
  async function read(txid) {
    txid = btcTxid(txid);
    let response;
    try { response = await rpc('getrawtransaction', [txid, true]); }
    catch (e) { if (e instanceof RpcError && e.code === -5) return { status: 'missing' }; throw e; }
    const tx = Transaction.fromHex(response.hex);
    if (tx.getId() !== txid || btcTxid(response.txid) !== txid) throw new Error('Bitcoin RPC returned wrong tx');
    if (!response.blockhash) return { status: 'confirming' };
    const anchor = btcTxid(response.blockhash);
    const header = await rpc('getblockheader', [anchor]);
    if (!Number.isSafeInteger(header.height) || header.height < 0 || btcTxid(header.hash) !== anchor) throw new Error('invalid Bitcoin block header');
    if (header.confirmations < 0 || btcTxid(await rpc('getblockhash', [header.height])) !== anchor) return { status: 'orphaned' };
    if (!Number.isSafeInteger(header.confirmations) || header.confirmations < c.depth) return { status: 'confirming' };
    return { status: 'final', tx, anchor, blockTime: time(header.time, 'Bitcoin block time') };
  }
  async function output(ref, expected) {
    const txid = btcTxid(ref.txid), index = vout(ref.index);
    const r = await read(txid);
    if (r.status !== 'final') return null;
    const out = r.tx.outs[index];
    if (!out || hexlify(out.script) !== expected || out.value <= 0n || out.value > MAX_SATS) throw new Error('Bitcoin output does not match expected script');
    return { txid, index, anchor: r.anchor, blockTime: r.blockTime, value: out.value };
  }
  async function observeFunding(order, ref) {
    if (order.from !== 'BTC') throw new Error('wrong BTC funding chain');
    await pin();
    return output(ref, bitcoinScript(policy, order.id).output);
  }
  async function unspent(ref, expected) {
    const info = await output(ref, expected);
    if (!info) return null;
    const utxo = await rpc('gettxout', [info.txid, info.index, true]);
    if (utxo === null) return null;
    if (`0x${utxo.scriptPubKey.hex}` !== expected || utxo.confirmations < c.depth) throw new Error('Bitcoin unspent output changed');
    return info;
  }
  async function checkReserve(ref) { await pin(); return unspent(ref, pool.output); }
  async function hasOpenFunding(order, funding) {
    await pin();
    const live = await unspent(funding, bitcoinScript(policy, order.id).output);
    return !!live && live.anchor === funding.anchor && live.value === BigInt(funding.value);
  }

  async function planFor(kind, order, funding, ref) {
    await pin();
    const payout = kind === PAY && order.to === 'BTC';
    const refund = kind === REFUND && order.from === 'BTC';
    const collect = kind === COLLECT && order.from === 'BTC';
    if (!payout && !refund && !collect) throw new Error('invalid BTC instruction');
    const source = payout ? pool : bitcoinScript(policy, order.id);
    const actual = await unspent(payout ? ref : funding, source.output);
    if (!actual) return null;
    if (!payout && (actual.anchor !== funding.anchor || actual.value !== BigInt(funding.value))) throw new Error('Bitcoin funding changed');
    const payee = payout ? order.recipient.script : refund ? order.refund.script : pool.output;
    if (payee === source.output || (payout && payee === pool.output)) throw new Error('BTC recipient is an input script');
    const amount = payout ? order.wire.amountOut : actual.value - c.fee;
    const change = actual.value - amount - c.fee;
    if (amount < DUST || change < 0n || (change !== 0n && change < DUST)) return null;
    const outputs = [{ script: payee, value: amount }];
    if (change > 0n) outputs.push({ script: pool.output, value: change });
    return { chain: 'BTC', kind, orderId: order.id, input: actual, witness: source.witness, outputs,
      resource: `${c.id}:${actual.txid}:${actual.index}` };
  }
  async function observeLeg(plan, payload) {
    await pin();
    const r = await read(payload.txid);
    if (r.status !== 'final') return { status: r.status };
    const intended = unsignedTx(plan);
    intended.setWitness(0, r.tx.ins[0]?.witness ?? []);
    if (r.tx.getId() !== intended.getId()) throw new Error('mined BTC spend does not match signed plan');
    const reserves = r.tx.outs.flatMap((out, index) => hexlify(out.script) === pool.output ? [{ txid: r.tx.getId(), index }] : []);
    return { status: 'final', delivered: true, anchor: r.anchor, reserves };
  }
  async function broadcast(payload) {
    await pin();
    if (Transaction.fromHex(payload.raw).getId() !== btcTxid(payload.txid)) throw new Error('signed BTC txid mismatch');
    const seen = await rpc('sendrawtransaction', [payload.raw]);
    if (btcTxid(seen) !== payload.txid) throw new Error('BTC RPC returned wrong broadcast ID');
  }
  return Object.freeze({ chain: 'BTC', checkReserve, observeFunding, hasOpenFunding, planFor, observeLeg, broadcast });
}

function unsignedTx(plan) {
  if (plan.chain !== 'BTC' || !Array.isArray(plan.outputs) || plan.outputs.length < 1 || plan.outputs.length > 2) throw new Error('invalid BTC plan');
  const tx = new Transaction();
  tx.version = 2;
  tx.addInput(rawHex(btcTxid(plan.input.txid)).reverse(), vout(plan.input.index), 0xffff_ffff);
  for (const out of plan.outputs) {
    if (typeof out.script !== 'string' || !/^0x(?:[0-9a-f]{2}){1,42}$/.test(out.script)) throw new Error('invalid BTC output script');
    tx.addOutput(getBytes(out.script), uint(out.value, 'BTC output sats', MAX_SATS, DUST));
  }
  return tx;
}
function digest(plan) {
  return unsignedTx(plan).hashForWitnessV0(0, getBytes(plan.witness), uint(plan.input.value, 'input sats', MAX_SATS, DUST), SIGHASH);
}
export function assembleBitcoin(policy, plan, partials) {
  if (!Array.isArray(partials) || partials.length !== 2) throw new Error('need two Bitcoin cosigners');
  const d = digest(plan);
  const checked = partials.map((p) => {
    const key = hex(p.key, 33, 'Bitcoin cosigner'), signature = getBytes(hex(p.signature, 64, 'ECDSA signature'));
    if (!policy.rails.BTC.keys.includes(key) || !secp.verify(d, getBytes(key), signature, true)) throw new Error('invalid BTC partial signature');
    return { key, signature: script.signature.encode(signature, SIGHASH) };
  }).sort((a, b) => a.key.localeCompare(b.key));
  if (checked[0].key === checked[1].key) throw new Error('duplicate Bitcoin cosigner');
  const tx = unsignedTx(plan);
  tx.setWitness(0, [new Uint8Array(), ...checked.map(({ signature }) => signature), getBytes(plan.witness)]);
  return { raw: tx.toHex(), txid: tx.getId() };
}

/** An individual operator. Own RPC readers and a durable, independent decision journal are required.
 * Returns one secp256k1 signature; the coordinator never needs this private key.
 */
export function makeBitcoinCosigner({ policy, rails, journal, secret, now = unixSeconds }) {
  if (!(secret instanceof Uint8Array) || secret.length !== 32 || !secp.isPrivate(secret)) throw new TypeError('invalid cosigner key');
  const privateKey = Uint8Array.from(secret);
  const key = hexlify(secp.pointFromScalar(privateKey, true));
  if (!policy.rails.BTC.keys.includes(key)) throw new Error('Bitcoin cosigner not in deployment');
  return Object.freeze({ key, async approve({ signed, funding, plan, paidTxid }) {
    const order = verifySwap(policy, signed);
    const live = await rails[order.from].observeFunding(order, funding);
    if (!live || live.anchor !== funding.anchor || live.value !== BigInt(funding.value)) throw new Error('cosigner cannot establish final funding');
    const { kind } = plan;
    if (kind === PAY) {
      if (order.to !== 'BTC' || live.value !== order.wire.amountIn || live.blockTime > order.wire.fundUntil ||
          time(now()) >= order.wire.payUntil) throw new Error('BTC payout not eligible');
    } else if (kind === REFUND) {
      if (order.from !== 'BTC' || !(await rails[order.to].failedPayout(order))) throw new Error('cosigner requires a final failed EVM payout before BTC refund');
    } else if (kind === COLLECT) {
      if (order.from !== 'BTC' || live.value !== order.wire.amountIn || live.blockTime > order.wire.fundUntil) throw new Error('invalid BTC collect');
      const evidence = await rails[order.to].observeLeg({ kind: PAY, orderId: order.id, recipient: order.recipient.address,
        amount: order.wire.amountOut }, { txid: paidTxid });
      if (evidence.status !== 'final' || evidence.delivered !== true) throw new Error('cosigner requires a final exact payout before collect');
    } else throw new Error('invalid BTC sign request');
    const expected = await rails.BTC.planFor(kind, order, live, plan.input);
    // Match the complete normalized spend, including change, fee, script and outpoint.
    if (!expected || encode(expected) !== encode(plan)) throw new Error('Bitcoin plan differs from signer policy');
    if (!(await rails[order.from].hasOpenFunding(order, live))) throw new Error('cosigner funding is no longer open');
    journal.approve(key, order.id, expected.resource, hash(['mobubu:native-swap:btc-approval:v1', expected]));
    return { key, signature: hexlify(secp.sign(digest(expected), privateKey)) };
  } });
}
