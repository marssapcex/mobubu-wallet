import { PAY, REFUND, COLLECT, REJECT, ASSETS, nonzero, time, uint, unixSeconds, verifySwap } from './protocol.mjs';
import { assembleBitcoin, bitcoinFunding, bitcoinScript, btcTxid } from './bitcoin-rail.mjs';
import { evmFunding } from './evm-rail.mjs';

const terminal = new Set(['paid', 'refunded', 'review']);
const sameFunding = (live, stored) => live?.anchor === stored.anchor && live.value === BigInt(stored.value) && live.blockTime === stored.blockTime;

/** Exact-in, liquidity-backed, one settlement per order; no atomic cross-chain claim.
 * Coordinator prepares a durable spend before releasing signatures, and persists the
 * exact signed bytes before handing them to a node. Readers and signers pin policy.
 */
export function makeSettlement({ policy, rails, journal, now = unixSeconds }) {
  if (journal.deployment !== policy.id || ASSETS.some((symbol) => rails[symbol]?.chain !== symbol)) throw new Error('swap configuration mismatch');
  const clock = () => time(now());
  const load = (id) => {
    const row = journal.get(nonzero(id, 'order ID'));
    const order = verifySwap(policy, row.signed);
    if (order.id !== id) throw new Error('journal order mismatch');
    return { ...row, order };
  };
  function update(row, state, extra) {
    if (!journal.update(row.order.id, row.revision, state, extra)) return { status: 'retry' };
    return { status: state.phase, kind: state.plan?.kind, txid: state.payload?.txid };
  }
  function register(signed) {
    const order = verifySwap(policy, signed), now = clock();
    if (now < order.quote.issued || now >= order.wire.fundUntil) throw new Error('swap funding window is not open');
    if (order.from === 'BTC' && [bitcoinScript(policy, order.id).address, bitcoinScript(policy).address].includes(order.refund.address)) {
      throw new Error('BTC refund cannot be a treasury or funding address');
    }
    if (order.to === 'BTC' && order.recipient.address === bitcoinScript(policy).address) throw new Error('BTC payout cannot be a treasury address');
    journal.register(order.id, `${order.wire.key}:${order.wire.nonce}`, signed);
    const funding = order.from === 'BTC' ? bitcoinFunding(policy, order) : evmFunding(policy, order);
    return { id: order.id, funding, output: order.wire.amountOut, fundUntil: order.wire.fundUntil, payUntil: order.wire.payUntil };
  }
  async function attach(id, { txid, index }) {
    const row = load(id), { order, state } = row;
    if (state.phase !== 'funding') throw new Error('order already has funding');
    const tx = order.from === 'BTC' ? btcTxid(txid) : nonzero(txid, 'EVM tx ID');
    const ix = Number(uint(index, 'output or log index', 0xffff_ffffn));
    const funding = await rails[order.from].observeFunding(order, { txid: tx, index: ix });
    if (!funding) return { status: 'funding_not_final' };
    if (!(await rails[order.from].hasOpenFunding(order, funding))) throw new Error('funding is no longer unspent or escrowed');
    return update(row, { phase: 'decide', funding }, { fundingKey: `${policy.rails[order.from].id}:${tx}:${ix}` });
  }
  async function addBitcoinReserve(ref) {
    const confirmed = await rails.BTC.checkReserve(ref);
    if (!confirmed) throw new Error('BTC reserve not confirmed or already spent');
    journal.addReserve(confirmed);
    return { txid: confirmed.txid, index: confirmed.index, sats: confirmed.value };
  }
  function approvalRequest(row) {
    if (row.state.phase !== 'signing' || row.state.plan.chain !== 'BTC') throw new Error('no pending BTC approval');
    const { plan, funding, prior } = row.state;
    return { signed: row.signed, funding, plan, paidTxid: prior?.payload.txid };
  }
  async function observePrerequisites(row, requireOpen) {
    const { order, state } = row;
    const source = rails[order.from];
    const live = await source.observeFunding(order, state.funding);
    if (!live || !sameFunding(live, state.funding)) return 'funding_not_final';
    if (requireOpen && !(await source.hasOpenFunding(order, state.funding))) return 'funding_already_resolved';
    if (state.prior) {
      const { plan, payload, anchor, delivered } = state.prior;
      const current = await rails[plan.chain].observeLeg(plan, payload);
      if (current.status !== 'final' || current.anchor !== anchor || current.delivered !== delivered) return 'outbound_not_final';
    }
    return null;
  }
  async function prepare(row) {
    const { order, state } = row;
    const liveValue = BigInt(state.funding.value);
    const eligible = () => liveValue === order.wire.amountIn && state.funding.blockTime <= order.wire.fundUntil && clock() < order.wire.payUntil;
    let kind = state.follow;
    if (!kind) kind = eligible() ? PAY : order.from === 'BTC' ? REJECT : REFUND;
    let chain = kind === PAY || kind === REJECT ? order.to : order.from;
    let plan;
    if (chain === 'BTC' && kind === PAY) {
      for (const ref of journal.reserves()) {
        if (journal.claimed(`${policy.rails.BTC.id}:${ref.txid}:${ref.index}`)) continue;
        plan = await rails.BTC.planFor(kind, order, state.funding, ref);
        if (plan) break;
      }
      if (!plan) { kind = REFUND; chain = order.from; }
    }
    if (!plan) plan = chain === 'BTC'
      ? await rails.BTC.planFor(kind, order, state.funding)
      : await rails[chain].prepare(kind, order, state.funding);
    if (!plan) return { status: 'no_spend_available', kind }; // e.g. refund below dust, no gas, or an in-flight nonce.
    if (kind === PAY && !eligible()) return { status: 'retry' }; // Never commit a new payout after the signed window.
    const blocked = await observePrerequisites(row, true);
    if (blocked) return { status: blocked };
    if (kind === PAY && !eligible()) return { status: 'retry' };
    return update(row, { ...state, phase: 'signing', plan }, { resource: plan.resource });
  }
  async function advance(id, { partials } = {}) {
    const row = load(id), { order, state } = row;
    if (terminal.has(state.phase) || state.phase === 'funding') return { status: state.phase, txid: state.payload?.txid };
    let blocked = await observePrerequisites(row, state.phase !== 'outbox');
    if (blocked) return { status: blocked };
    if (state.phase === 'decide') return prepare(row);
    const { plan } = state, rail = rails[plan.chain];
    if (state.phase === 'signing') {
      if (plan.chain === 'BTC' && !partials) {
        return { status: plan.kind === PAY && clock() >= order.wire.payUntil ? 'btc_approval_window_closed' : 'btc_approval_required' };
      }
      // No automatic switch to refund from here: a cosigner or another process may
      // already hold an executable payment. The outbox permits only this plan.
      const payload = plan.chain === 'BTC' ? assembleBitcoin(policy, plan, partials) : await rail.sign(plan, order, state.funding);
      return update(row, { ...state, phase: 'outbox', payload });
    }
    if (state.phase !== 'outbox') throw new Error('invalid journal phase');
    const status = await rail.observeLeg(plan, state.payload);
    if (status.status === 'failed_tx') return update(row, { ...state, phase: 'review', reason: 'outer EVM transaction reverted; no authoritative outcome' });
    if (status.status === 'confirming' || status.status === 'orphaned') return { status: status.status, txid: state.payload.txid };
    if (status.status === 'missing') {
      blocked = await observePrerequisites(row, true);
      if (blocked) return { status: blocked };
      await rail.broadcast(state.payload); // If response is lost, next tick reconciles this exact hash/bytes.
      return { status: 'broadcast', txid: state.payload.txid };
    }
    if (status.status !== 'final') throw new Error('unknown settlement observation');
    if (plan.kind === PAY || plan.kind === REJECT) {
      if (plan.kind === REJECT && status.delivered) throw new Error('invalid reject outcome');
      const prior = { plan, payload: state.payload, anchor: status.anchor, delivered: status.delivered };
      return update(row, { phase: 'decide', funding: state.funding, prior, follow: status.delivered ? COLLECT : REFUND }, { reserves: status.reserves });
    }
    if (status.delivered !== true) throw new Error('source resolution missing delivery');
    return update(row, { ...state, phase: plan.kind === COLLECT ? 'paid' : 'refunded', anchor: status.anchor }, { reserves: status.reserves });
  }
  return Object.freeze({ register, attach, addBitcoinReserve, advance,
    approvalRequest(id) { return approvalRequest(load(id)); },
    status(id) { const { order, state } = load(id); return { id: order.id, from: order.from, to: order.to, ...state }; },
    active() { return journal.active(); },
  });
}
