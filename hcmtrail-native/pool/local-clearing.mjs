import { parseEther, toBeHex, toQuantity } from 'ethers';
import { ARBITRUM, BASE, ETHEREUM, NO_PACKET_GAS, Packet, Stage, exitId, packetPath, readExitOrder, retryableBudget } from './clearing.mjs';
import { need } from './protocol.mjs';
import { TX_GAS_CAP } from '../testnet/networks.mjs';

const ALIAS = 0x1111000000000000000000000000000000001111n;
const opts = { gasLimit: TX_GAS_CAP };
const sent = async (method, args, value = 0n) => (await method(...args, { ...opts, value })).wait();

// In-process EDR only. No RPC, packet string, signer, or sender override is ever
// accepted from a preview client. Deliver only a canonical MessageQueued log
// from the pinned transport, in a successful transaction to its peer pool.
export function localClearing(vms, arbitrumPacketGas) {
  const lanes = new Map([...vms.values()].map((vm) => [vm.lane, vm]));
  const domain = lanes.get(ETHEREUM).config.networkDomain;
  const records = new Map();
  let serial = Promise.resolve();
  const lookup = (src, id) => records.get(id)?.source === src ? records.get(id) : undefined;
  const firstHop = (from, to) => packetPath(from, to)[1];
  const bid = (from, next) => from === ETHEREUM && next === ARBITRUM ? arbitrumPacketGas : NO_PACKET_GAS;
  const valueOf = (b) => b === NO_PACKET_GAS ? 0n : retryableBudget(b);

  function envelope(from, to, record, kind, receipt) {
    const wire = from.lane === BASE || to.lane === BASE ? from.base : from.arb;
    const topic = wire.interface.getEvent('MessageQueued').topicHash;
    need(receipt?.status === 1 && receipt.to === from.pool.target, 'Unconfirmed local packet');
    const logs = receipt.logs.filter((l) => l.address === wire.target && l.topics[0] === topic);
    need(logs.length === 1, 'Expected one local transport event');
    const q = wire.interface.parseLog(logs[0]).args;
    const packet = to.pool.interface.encodeFunctionData('acceptPacket', [record.id, record.order, kind]);
    need(q.from === from.pool.target && q.to === to.pool.target && q.packet === packet && q.callValue === 0n &&
      q.gasBudget === valueOf(bid(from.lane, to.lane)), 'Local transport event does not match the canonical route');
    return packet;
  }

  async function deliver(from, to, packet) {
    return to.write(async () => {
      if (to.lane === ARBITRUM) {
        // Only this locally derived address may be impersonated, for gas and
        // the canonical zero-value acceptPacket call above. No funds cross VMs.
        const alias = toBeHex(BigInt.asUintN(160, BigInt(from.pool.target) + ALIAS), 20);
        await to.provider.send('hardhat_setBalance', [alias, toQuantity(parseEther('1'))]);
        await to.provider.send('hardhat_impersonateAccount', [alias]);
        try {
          const hash = await to.provider.send('eth_sendTransaction', [{ from: alias, to: to.pool.target, data: packet, gas: toQuantity(TX_GAS_CAP) }]);
          return await (await to.provider.getTransaction(hash)).wait();
        } finally { await to.provider.send('hardhat_stopImpersonatingAccount', [alias]); }
      }
      return from.lane === ARBITRUM ? sent(to.outbox.deliver, [from.pool.target, to.bridge.target, to.pool.target, packet])
        : sent(to.base.deliver, [from.pool.target, to.pool.target, packet]);
    });
  }

  function publish(vm, method, args, next) {
    const b = bid(vm.lane, next);
    return vm.write(() => sent(vm.pool.connect(vm.relay)[method], [...args, b], valueOf(b)));
  }

  async function dispatch(record, kind, receipt) {
    const { source, destination, order } = record;
    const path = kind === Packet.Open ? packetPath(source.lane, destination.lane) : packetPath(destination.lane, source.lane);
    for (let i = 1; i < path.length; ++i) {
      const from = lanes.get(path[i - 1]), to = lanes.get(path[i]);
      await deliver(from, to, envelope(from, to, record, kind, receipt));
      if (i + 1 < path.length) receipt = await publish(to, 'forwardPacket', [order, kind], path[i + 1]);
    }
  }

  function recordLock(source, receipt) {
    const topic = source.pool.interface.getEvent('ExitLocked').topicHash;
    const logs = receipt.logs.filter((l) => l.address === source.pool.target && l.topics[0] === topic);
    need(logs.length === 1, 'Missing verified local exit');
    const args = source.pool.interface.parseLog(logs[0]).args;
    const order = readExitOrder(args.order);
    const id = exitId(domain, order), destination = lanes.get(order.destination);
    need(args.id === id && order.source === source.lane && !records.has(id), 'Wrong local exit scope');
    const record = { id, source, destination, order, open: receipt };
    envelope(source, lanes.get(firstHop(order.source, order.destination)), record, Packet.Open, receipt);
    records.set(id, record);
    return id;
  }

  async function describe(r, issue) {
    const { id, source, destination, order, payoutTx } = r;
    const [sourceStage, destinationStage, liquidity] = await Promise.all([
      source.pool.exitStage(id), destination.pool.exitStage(id), destination.pool.liquidityNative(),
    ]);
    return { found: true, id, networkDomain: domain, sourceStage, destinationStage, liquidity, gross: order.gross, payoutTx, issue };
  }

  async function progress(r) {
    const { source, destination, order } = r;
    let v = await describe(r);
    if (v.sourceStage === Stage.Locked && v.destinationStage === Stage.Unseen) {
      try { await dispatch(r, Packet.Open, r.open); }
      catch { return describe(r, 'open'); }
      v = await describe(r);
    }
    if (v.destinationStage === Stage.Authorized) {
      if (v.liquidity < order.gross) return { ...v, issue: 'liquidity' };
      try {
        const receipt = await destination.payoutRelayer?.active()
          ? await destination.payoutRelayer.send('claimAcross', [order])
          : await destination.write(() => sent(destination.pool.connect(destination.relay).claimAcross, [order]));
        r.payoutTx = receipt.hash;
      } catch {
        v = await describe(r, 'payout');
        if (v.destinationStage === Stage.Authorized) return v;
      }
      v = await describe(r);
    }
    if (v.sourceStage === Stage.Locked && (v.destinationStage === Stage.Paid || v.destinationStage === Stage.Cancelled)) {
      try {
        const receipt = await publish(destination, 'publishOutcome', [order], firstHop(destination.lane, source.lane));
        await dispatch(r, v.destinationStage === Stage.Paid ? Packet.Paid : Packet.Cancelled, receipt);
      } catch { return describe(r, 'outcome'); }
      v = await describe(r);
    }
    if (v.sourceStage === Stage.Refundable) {
      try { await source.write(() => sent(source.pool.connect(source.relay).refundAcross, [order])); }
      catch { return describe(r, 'refund'); }
      v = await describe(r);
    }
    return v;
  }

  return {
    recordLock,
    openingGas(source, order) {
      need(source.lane === order.source, 'Wrong source lane');
      const packetGas = bid(order.source, firstHop(order.source, order.destination));
      return { packetGas, value: valueOf(packetGas) };
    },
    canCancel(destination, order) {
      return records.get(exitId(domain, order))?.destination === destination;
    },
    async route(source, id) {
      const r = lookup(source, id);
      return r ? describe(r) : { found: false, id, networkDomain: domain };
    },
    async advance(source, id) {
      const r = lookup(source, id);
      need(r, 'Unknown local exit');
      const next = serial.then(() => progress(r));
      serial = next.catch(() => {});
      return next;
    },
  };
}
