import assert from 'node:assert/strict';
import { parseEther, toBeHex, toQuantity } from 'ethers';
import { deployEthNetwork } from '../pool/local.mjs';
import { ARBITRUM, BASE, ETHEREUM, NO_PACKET_GAS, Packet, packetPath, retryableBudget } from '../pool/clearing.mjs';
import { TX_GAS_CAP } from '../testnet/networks.mjs';

export const opts = { gasLimit: TX_GAS_CAP };
export const sent = async (method, ...args) => (await method(...args, opts)).wait();
const bid = Object.freeze({ gasLimit: 400_000n, maxFeePerGas: 100_000_000n, maxSubmissionCost: 1_234_567n,
  refundL2: toBeHex(0xf001n, 20) });
export const hopBid = (from, next) => from === ETHEREUM && next === ARBITRUM ? bid : NO_PACKET_GAS;
export const hopValue = (g) => g === NO_PACKET_GAS ? 0n : retryableBudget(g);

export async function labs(t, { verify = false } = {}) {
  const groups = await deployEthNetwork({ fixtures: !verify, harness: !verify,
    vmOptions: ({ labId }) => ({ keys: [1n, 2n].map((n) => toBeHex(BigInt(labId) * 2n + n, 32)) }) });
  const result = new Map();
  for (const vm of groups.values()) {
    t.after(vm.close);
    const lane = await vm.pool.lane();
    result.set(lane, { ...vm, lane, other: await vm.provider.getSigner(1) });
  }
  return result;
}

export function queued(from, next, receipt) {
  const wire = from.lane === BASE || next.lane === BASE ? from.base : from.arb;
  const logs = receipt.logs.filter((l) => l.address === wire.target).map((l) => wire.interface.parseLog(l));
  const matches = logs.filter((l) => l?.name === 'MessageQueued');
  assert.equal(matches.length, 1);
  const q = matches[0].args;
  assert.equal(q.from, from.pool.target);
  assert.equal(q.to, next.pool.target);
  assert.equal(q.callValue, 0n);
  assert.equal(q.gasBudget, hopValue(hopBid(from.lane, next.lane)));
  return { ...q.toObject(), lane: from.lane };
}

export async function deliver(vm, q, { sender = q.from } = {}) {
  if (vm.lane === ARBITRUM) {
    // EDR supplies only test gas to the system-derived sender alias. No principal
    // is minted/moved/imported for a packet. The pool payout must spend its own pot.
    const address = toBeHex(BigInt.asUintN(160, BigInt(sender) + 0x1111000000000000000000000000000000001111n), 20);
    await vm.provider.send('hardhat_setBalance', [address, toQuantity(parseEther('1'))]);
    await vm.provider.send('hardhat_impersonateAccount', [address]);
    try {
      const hash = await vm.provider.send('eth_sendTransaction', [{ from: address, to: q.to, data: q.packet, gas: toQuantity(TX_GAS_CAP) }]);
      return await (await vm.provider.getTransaction(hash)).wait();
    } finally { await vm.provider.send('hardhat_stopImpersonatingAccount', [address]); }
  }
  if (q.lane === ARBITRUM) return sent(vm.outbox.deliver, sender, vm.bridge.target, q.to, q.packet);
  return sent(vm.base.deliver, sender, q.to, q.packet);
}

export async function pushPacket(chains, o, kind, receipt, checks = () => {}) {
  const open = kind === Packet.Open;
  const path = packetPath(open ? o.source : o.destination, open ? o.destination : o.source);
  for (let i = 1; i < path.length; ++i) {
    const from = chains.get(path[i - 1]);
    const to = chains.get(path[i]);
    const packet = queued(from, to, receipt);
    await deliver(to, packet);
    await checks({ from, to, packet });
    if (i + 1 < path.length) {
      const gasBid = hopBid(to.lane, path[i + 1]);
      receipt = await (await to.pool.connect(to.other).forwardPacket(o, kind, gasBid, { ...opts, value: hopValue(gasBid) })).wait();
    }
  }
}

export async function balances(vm) {
  const b = await Promise.all([vm.provider.getBalance(vm.pool.target), vm.pool.shieldedNative(), vm.pool.reservedNative(),
    vm.pool.outboundNative(), vm.pool.liquidityNative(), vm.staking.fundedWei()]);
  assert.equal(b[0], b[1] + b[2] + b[3] + b[4], 'partitioned ETH balance');
  return { total: b[0], shielded: b[1], reserved: b[2], outbound: b[3], liquidity: b[4], fees: b[5] };
}
