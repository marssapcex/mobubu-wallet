import { ZeroAddress, ZeroHash } from 'ethers';
import { relayLimits } from './dao-policy.mjs';
import { GOLDILOCKS } from './networks.mjs';
import { custodyCap, uint, unpack, word256 } from './notes.mjs';
import { address } from './rpc.mjs';
import { need } from './store.mjs';

export const exitContext = (net, m) => ({ schema: 1, asset: net.asset, chainId: m.chainId, vault: m.vault, domain: m.domain });
export const inContext = (ctx, data) => data && Object.entries(ctx).every(([key, value]) => data[key] === value);

export function localAmount(net, value) {
  const amount = uint(value, custodyCap(net), 'base-unit amount');
  need(amount > 0n && (!net.tvm || amount <= BigInt(Number.MAX_SAFE_INTEGER)), 'Use a positive testnet-sized amount in native base units.');
  return amount;
}

export function payoutAddress(net, m, text) {
  const to = address(net, text);
  need(to !== ZeroAddress && to !== m.vault && to !== m.dao?.treasury, 'Payout must target a nonzero address outside the vault and treasury.');
  return to;
}

export function relayTerms(net, m, terms) {
  const fee = uint(terms.fee, custodyCap(net), 'broadcaster fee');
  const feeRecipient = address(net, terms.feeRecipient);
  if (fee === 0n) need(feeRecipient === ZeroAddress, 'Zero broadcaster fee must not name a broadcaster.');
  else {
    const { min, max } = relayLimits(net);
    need(m.dao && fee >= min && fee <= max && feeRecipient !== ZeroAddress && feeRecipient !== m.vault,
      'Broadcaster fee or fee recipient is outside this fee vault policy.');
  }
  return { fee, feeRecipient };
}

export function exitTerms(net, m, terms) {
  const root = word256(terms.root);
  const pair = (v) => {
    need(Array.isArray(v) && v.length === 2, 'Expected two public digest words.');
    return v.map((word) => { const w = word256(word); unpack(w); need(w !== ZeroHash, 'Zero public digest.'); return w; });
  };
  const nullifiers = pair(terms.nullifiers), change = pair(terms.change);
  const amount = localAmount(net, terms.amount);
  const notBefore = uint(terms.notBefore, GOLDILOCKS - 1n, 'NotBefore');
  const relay = relayTerms(net, m, terms);
  unpack(root);
  need(amount + relay.fee <= custodyCap(net) && root !== ZeroHash && nullifiers[0] !== nullifiers[1] &&
    !change.includes(m.domainLeaf) && notBefore > 0n && notBefore % 600n === 0n, 'Invalid public local exit.');
  return { root, nullifiers, change, recipient: payoutAddress(net, m, terms.recipient), amount, notBefore, ...relay };
}
