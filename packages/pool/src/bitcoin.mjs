import { bitcoinScript, makeBitcoinRail } from '../../swap/src/bitcoin-rail.mjs';
import { DUST } from '../../swap/src/protocol.mjs';
import { bitcoinDomain, hash, noteLeaf, nonzero32, baseUnits } from './notes.mjs';

/** Devnet intake only: observes a native confirmed note funding output. This is
 * not a note registry or a release authority. Never ask for the note secret. */
export async function makeBitcoinPoolIntake({ policy, rpc }) {
  if (policy.rails.BTC.network !== 'regtest') throw new Error('shielded BTC intake is regtest only');
  const common = bitcoinScript(policy);
  const domain = await bitcoinDomain(policy.rails.BTC.genesis, `0x${common.output.slice(6)}`);
  const rail = makeBitcoinRail({ policy, rpc });
  // The funding script is in a different namespace from direct-swap orders.
  const order = async (noteKey) => ({ from: 'BTC', id: await hash(7, nonzero32(domain), nonzero32(noteKey)) });
  return Object.freeze({ domain, vault: common.address,
    async funding(noteKey) { return bitcoinScript(policy, (await order(noteKey)).id).address; },
    async observe(noteKey, outpoint) {
      const scope = await order(noteKey);
      const receipt = await rail.observeFunding(scope, outpoint);
      if (!receipt || !(await rail.hasOpenFunding(scope, receipt))) return null;
      const value = baseUnits(receipt.value, 'BTC');
      if (value < DUST + policy.rails.BTC.fee) throw new Error('BTC funding cannot cover minimum and miner fee');
      return Object.freeze({ ...receipt, value, leaf: await noteLeaf(domain, noteKey, value) });
    },
  });
}
