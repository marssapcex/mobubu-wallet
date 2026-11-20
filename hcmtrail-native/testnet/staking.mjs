import { AbiCoder, getAddress, Interface, keccak256, toBeHex, ZeroAddress, ZeroHash } from 'ethers';
import { HCMT_LOCAL_SUPPLY, STAKE_AUTH_ASSET, STAKE_PROFILE } from './dao-policy.mjs';
import { callSpec, receiptSummary } from './deployment.mjs';
import { GOLDILOCKS } from './networks.mjs';
import { noteNullifier, openNote, rebuildRoot, seedEntry, uint, unpack, word256 } from './notes.mjs';
import { proofHash, proofShape, proveLocal } from './prover.mjs';
import { address } from './rpc.mjs';
import { need } from './store.mjs';

const abi = AbiCoder.defaultAbiCoder();
const U64 = (1n << 64n) - 1n;
const MASK128 = (1n << 128n) - 1n;
const authNetwork = Object.freeze({ assetId: STAKE_AUTH_ASSET });
const exact = (data, keys) => data && !Array.isArray(data) && typeof data === 'object' &&
  Object.keys(data).length === keys.length && keys.every((k) => Object.hasOwn(data, k));
const sameContext = (ctx, data) => data && Object.entries(ctx).every(([key, value]) => data[key] === value);
const keyFile = (staker) => `stake-key-${staker.toLowerCase()}.json`;
const proofFile = (id) => `stake-proof-${word256(id)}.json`;
const authDomain = 'HCMTRAIL-HCMT-STAKE-AUTH-v1';
const keyDomain = 'HCMTRAIL-HCMT-CREDENTIAL-v1';

export function digest(value) {
  const d = word256(value);
  unpack(d);
  need(d !== ZeroHash, 'Zero staking digest.');
  return d;
}

export function claimPeriods(value) {
  const parts = Array.isArray(value) ? value : typeof value === 'string' && value.length <= 700 ? value.split(',') : [];
  need(parts.length > 0 && parts.length <= 32, 'Choose 1–32 distinct closed period IDs.');
  const periods = parts.map((n) => uint(n, U64, 'period'));
  need(!periods.includes(0n) && new Set(periods).size === periods.length, 'Choose 1–32 distinct positive period IDs.');
  return periods;
}

export function stakeCredential(context, staker, secret, blinding) {
  const note = openNote(authNetwork, 2n, secret, blinding);
  let leaf = keccak256(abi.encode(['string', 'uint256', 'address', 'address'], [keyDomain, context.chainId, context.treasury, staker]));
  for (;;) {
    try { digest(leaf); break; } catch { leaf = keccak256(leaf); }
  }
  need(leaf !== note.leaf, 'Degenerate staking credential. Generate a fresh key before staking.');
  const leaves = [leaf, note.leaf];
  return { note, leaves, root: digest(rebuildRoot(leaves)) };
}

export function intentHash(action) {
  if (action.kind === 'unstake') return keccak256(abi.encode(['uint8', 'uint256', 'address', 'uint64'],
    [1, action.amount, action.recipient, action.effectivePeriod]));
  need(action.kind === 'claim', 'Unknown staking proof action.');
  return keccak256(abi.encode(['uint8', 'address', 'uint64[]'], [2, action.recipient, action.periods]));
}

export function stakeChallenge(ctx, staker, nonce, action) {
  return keccak256(abi.encode(['string', 'uint256', 'address', 'address', 'uint64', 'bytes32'],
    [authDomain, ctx.chainId, ctx.treasury, staker, nonce, intentHash(action)]));
}

export function challengeAddresses(challenge) {
  const word = BigInt(challenge);
  const at = (half) => getAddress(toBeHex((1n << 128n) | half, 20));
  return [at(word >> 128n), at(word & MASK128)];
}

export class StakeWallet {
  constructor(chain, store, txs, manifest, treasuryAbi) {
    need(manifest.dao?.profile === STAKE_PROFILE, 'Use a new STARK staking treasury deployment.');
    this.chain = chain;
    this.store = store;
    this.txs = txs;
    this.m = manifest;
    this.iface = new Interface(treasuryAbi);
    this.ctx = { schema: 1, profile: STAKE_PROFILE, asset: manifest.asset, chainId: manifest.chainId, treasury: manifest.dao.treasury };
  }

  spec(method, args) { return callSpec(this.iface, this.ctx.treasury, method, args); }
  async read(method, args = [], at) {
    return this.iface.decodeFunctionResult(method, await this.chain.call(this.spec(method, args), at));
  }
  actor(at) {
    const who = address(this.chain.network, at);
    need(who !== ZeroAddress && who !== this.ctx.treasury && who !== this.m.dao.token && who !== this.m.vault,
      'Use an external staker or payout address.');
    return who;
  }

  async newKey(at) {
    const staker = this.actor(at);
    const file = keyFile(staker);
    const [registered] = await this.read('authorities', [staker], 'latest');
    if (this.store.has(file)) {
      const { root } = this.credential(staker);
      need(registered === ZeroHash || registered === root, 'Local credential does not match the registered stake.');
      return { ...this.ctx, staker, authRoot: root, privateFile: file };
    }
    need(registered === ZeroHash, 'An immutable staking credential already exists. Recover the original secret backup; do not create a new key.');
    const { note, root } = stakeCredential(this.ctx, staker);
    this.store.write(file, { ...this.ctx, staker, root, secret: note.secret, blinding: note.blinding });
    return { ...this.ctx, staker, authRoot: root, privateFile: file };
  }

  credential(staker) {
    const key = this.store.read(keyFile(staker));
    need(sameContext(this.ctx, key) && key.staker === staker && Array.isArray(key.secret) && Array.isArray(key.blinding),
      'Local staking key belongs to another account or treasury.');
    const k = stakeCredential(this.ctx, staker, key.secret, key.blinding);
    need(k.root === key.root, 'Saved credential does not derive the registered root.');
    return k;
  }

  action(input) {
    if (input?.kind === 'unstake') {
      need(exact(input, ['kind', 'amount', 'recipient', 'effectivePeriod']), 'Malformed unlock intent.');
      const amount = uint(input.amount, HCMT_LOCAL_SUPPLY, 'unstake amount');
      const effectivePeriod = uint(input.effectivePeriod, U64, 'unlock period');
      need(amount > 0n && effectivePeriod > 1n, 'Use a positive amount and the next period.');
      return { kind: input.kind, amount, recipient: this.actor(input.recipient), effectivePeriod };
    }
    need(exact(input, ['kind', 'recipient', 'periods']) && input.kind === 'claim', 'Malformed claim intent.');
    return { kind: input.kind, recipient: this.actor(input.recipient), periods: claimPeriods(input.periods) };
  }

  async prove(stakerText, intent, prover) {
    const staker = this.actor(stakerText);
    if (intent.kind === 'unstake') {
      const [period] = await this.read('currentPeriod', [], 'latest');
      intent = { ...intent, effectivePeriod: period + 1n };
    }
    const action = this.action(intent);
    const credential = this.credential(staker);
    const [registered, nonce] = await this.read('authorities', [staker], 'latest');
    need(registered === credential.root, 'First lock HCMT with the backed-up authorization root.');
    if (action.kind === 'unstake') {
      const [weight] = await this.read('stakeAt', [staker, action.effectivePeriod], 'latest');
      const [, pending] = await this.read('unlocks', [staker], 'latest');
      need(weight >= action.amount && pending === 0n, 'Unlock would exceed scheduled stake or another unlock is pending.');
    } else {
      const [next] = await this.read('nextToClose', [], 'latest');
      for (const p of action.periods) {
        const [weight] = await this.read('stakeAt', [staker, p], 'latest');
        const [used] = await this.read('claimed', [p, staker], 'latest');
        need(p < next && weight > 0n && !used, 'Period must be closed with a nonzero historical stake and not claimed.');
      }
    }
    const head = await this.chain.head();
    const notBefore = head.timestamp / 600n * 600n;
    const packet = await proveStake(this.store, prover, this.ctx, staker, credential, action, nonce, notBefore, this.txs.report);
    // Proof construction takes minutes. Never export a permit already stale at this RPC head.
    const [bound, currentNonce] = await this.read('authorities', [staker], 'latest');
    need(bound === registered && currentNonce === nonce, 'Staking authorization changed while proving. Check the on-chain state before rebuilding.');
    if (action.kind === 'unstake') {
      const [period] = await this.read('currentPeriod', [], 'latest');
      need(period + 1n === action.effectivePeriod, 'The unstake period changed while proving. Rebuild for the new period.');
    }
    this.store.write(proofFile(packet.id), packet);
    return { id: packet.id, publicFile: proofFile(packet.id), staker, action, nonce, proofBytes: (packet.proof.length - 2) / 2 };
  }

  request(packet) {
    need(exact(packet, [...Object.keys(this.ctx), 'id', 'staker', 'action', 'permit', 'proof']) && sameContext(this.ctx, packet),
      'Proof file is not a public permit for this staking treasury.');
    need(proofShape(packet.proof) && proofHash(packet.proof) === packet.id, 'Invalid staking proof length, header or hash.');
    const staker = this.actor(packet.staker);
    const p = packet.permit;
    need(exact(p, ['nonce', 'notBefore', 'nullifiers', 'outputs']), 'Invalid staking permit.');
    const pair = (values) => {
      need(Array.isArray(values) && values.length === 2, 'Invalid staking permit digest pair.');
      return values.map(digest);
    };
    const permit = { nonce: uint(p.nonce, U64, 'nonce'), notBefore: uint(p.notBefore, GOLDILOCKS - 1n, 'notBefore'),
      nullifiers: pair(p.nullifiers), outputs: pair(p.outputs) };
    need(permit.notBefore > 0n && permit.notBefore % 600n === 0n && permit.nullifiers[0] !== permit.nullifiers[1], 'Invalid staking permit time or nullifiers.');
    const action = this.action(packet.action);
    const args = action.kind === 'unstake' ? [staker, action.amount, action.recipient, action.effectivePeriod] : [staker, action.recipient, action.periods];
    const spec = this.spec(action.kind === 'unstake' ? 'requestUnstake' : 'claim', [...args, packet.proof, permit]);
    return { id: packet.id, staker, action, permit, spec };
  }

  async check(packet) {
    const { id, staker, action, permit, spec } = this.request(packet);
    return { id, staker, action, nonce: permit.nonce, ...await this.chain.simulate(spec), calldataBytes: (spec.data.length - 2) / 2 };
  }

  async submit(packet) {
    const { id, staker, action, permit, spec } = this.request(packet);
    const receipt = await this.txs.submit(`stake-auth-${id}`, spec);
    const event = this.iface.getEvent('StakeAuthorized').topicHash;
    const authorized = receipt.logs.filter((log) => log.address === this.ctx.treasury && log.topics[0] === event).map((log) => this.iface.parseLog(log).args);
    need(authorized.length === 1 && authorized[0][0] === staker && authorized[0][1] === permit.nonce &&
      authorized[0][2] === stakeChallenge(this.ctx, staker, permit.nonce, action), 'Confirmed receipt has no matching stake authorization.');
    return { id, staker, action, receipt: receiptSummary(receipt) };
  }
}

export async function proveStake(store, prover, ctx, staker, credential, action, nonce, notBefore, report) {
  need(notBefore > 0n && notBefore % 600n === 0n, 'Wait for a valid confirmed timestamp.');
  const { note, leaves, root } = credential;
  const dummy = openNote(authNetwork, 0n);
  const [recipient, fee_recipient] = challengeAddresses(stakeChallenge(ctx, staker, nonce, action));
  const request = { asset_id: STAKE_AUTH_ASSET, note_root: root, assoc_root: root, pool_leaves: leaves, assoc_leaves: leaves,
    input_pool_index: [1n, 0n], input_assoc_index: [1n, 0n], recipient, fee_recipient, clearing_price: 0n, not_before: notBefore,
    public_amount: 1n, fee: 1n, output_values: [0n, 0n], any_amount: true };
  const seed = { secrets: [note.secret, dummy.secret], notes: [seedEntry(note, authNetwork), seedEntry(dummy, authNetwork)] };
  const { exit, proof } = await proveLocal(store, authNetwork, prover, request, seed, noteNullifier(note, 1n), report);
  return { ...ctx, id: proofHash(proof), staker, action, permit: { nonce, notBefore, nullifiers: exit.nullifiers, outputs: exit.change }, proof };
}
