import { ZeroAddress } from 'ethers';
import { daoFee } from './dao-policy.mjs';
import { receiptSummary, view } from './deployment.mjs';
import { exitContext, exitTerms, inContext, relayTerms } from './exit-terms.mjs';
import { Ledger } from './ledger.mjs';
import { custodyCap, uint, word256 } from './notes.mjs';
import { proofHash, proofShape } from './prover.mjs';
import { need } from './store.mjs';

const KIND = 'hcmt-relay-quote-v1';
const BOND_ABI = ['function isBroadcaster(address) view returns (bool)'];
const PENDING = 'relay-pending.json';
const label = (id) => `relay-${id}`;
const exact = (obj, fields) => obj && !Array.isArray(obj) && typeof obj === 'object' &&
  Object.keys(obj).length === fields.length && fields.every((key) => Object.hasOwn(obj, key));

export function validateQuote(net, manifest, quote) {
  const context = exitContext(net, manifest);
  need(exact(quote, [...Object.keys(context), 'kind', 'feeRecipient', 'fee']) && inContext(context, quote) && quote.kind === KIND,
    'Quote does not match this fee deployment.');
  const terms = relayTerms(net, manifest, quote);
  need(terms.fee > 0n, 'A relay quote must name a positive fee.');
  return terms;
}

export function activeBroadcaster(chain, manifest, who) {
  return view(chain, BOND_ABI, manifest.dao.treasury, 'isBroadcaster', [who], 'latest');
}

/** Single-signer, file-based worker. No user secret, arbitrary calldata, RPC URL or signer is accepted in a request. */
export class RelayOperator {
  constructor(chain, txs, manifest, abi, { fee, maxCost = fee }) {
    need(manifest.dao && chain.sender && chain.sender !== ZeroAddress, 'Use a fee vault and a dedicated broadcaster signer.');
    this.chain = chain;
    this.txs = txs;
    this.m = manifest;
    this.context = exitContext(chain.network, manifest);
    this.ledger = new Ledger(chain, manifest, abi);
    this.terms = relayTerms(chain.network, manifest, { fee, feeRecipient: chain.sender });
    need(this.terms.fee > 0n, 'Set a positive broadcaster fee in native base units.');
    this.maxCost = uint(maxCost, custodyCap(chain.network), 'relay cost budget');
  }

  async quote() {
    need(await activeBroadcaster(this.chain, this.m, this.chain.sender), 'Signer has less than 100 active staked HCMT.');
    return { ...this.context, kind: KIND, ...this.terms };
  }

  request(input) {
    need(exact(input, [...Object.keys(this.context), 'id', 'proof', 'exit']) && inContext(this.context, input) &&
      exact(input.exit, ['root', 'nullifiers', 'change', 'recipient', 'feeRecipient', 'amount', 'fee', 'notBefore']),
    'Accept only the public relay-export envelope for the configured vault.');
    need(proofShape(input.proof) && proofHash(input.proof) === input.id, 'Public proof length, header or hash mismatch.');
    const exit = exitTerms(this.chain.network, this.m, input.exit);
    need(exit.fee === this.terms.fee && exit.feeRecipient === this.terms.feeRecipient,
      'Proof must pay this signer exactly the currently quoted fee.');
    return { id: input.id, exit, spec: this.ledger.spec('withdraw', [input.proof, exit]) };
  }

  async checkLive(exit) {
    await this.quote();
    for (const nf of exit.nullifiers) need(!await this.ledger.read('spent', [nf], 'latest'), 'AlreadySpent: do not relay again.');
    need(await this.ledger.read('knownRoot', [exit.root], 'latest'), 'UnknownRoot: proof does not belong to this vault.');
  }

  checkCost(budget) {
    const tvm = this.chain.network.tvm;
    const cost = tvm ? BigInt(budget.estimatedBurnSun) : BigInt(budget.gasLimit) * BigInt(budget.gasPrice);
    need(cost <= this.maxCost, 'Gas budget exceeds configured relay cost threshold. No new transaction signed.');
    return { cost, basis: tvm ? 'estimated Energy burn only (excludes Bandwidth)' : 'signed gasLimit × gasPrice' };
  }

  async preflight(input) {
    const { id, exit, spec } = this.request(input);
    await this.checkLive(exit);
    const budget = await this.chain.simulate(spec);
    return { exitId: id, fee: exit.fee, calldataBytes: (spec.data.length - 2) / 2, budget, ...this.checkCost(budget) };
  }

  // Caller holds the private state lock. In particular, HyperEVM's latest nonce must not be used
  // to sign another request while the previous one is still awaiting confirmed inclusion.
  async submit(input) {
    const { id, exit, spec } = this.request(input);
    const { store } = this.txs;
    if (store.has(PENDING)) {
      const previous = word256(store.read(PENDING).id);
      const old = previous === id ? null : this.txs.existing(label(previous));
      need(!old || await this.chain.receipt(old.envelope.hash), 'Previous relay is not confirmed. Recover or retry the exact prior request first.');
    }
    const saved = this.txs.existing(label(id));
    if (saved) need(saved.envelope.sender === this.chain.sender, 'Relay journal belongs to a different signer.');
    if (!saved || !await this.chain.receipt(saved.envelope.hash)) await this.checkLive(exit);
    store.write(PENDING, { id });
    const receipt = await this.txs.submit(label(id), spec, (budget) => this.checkCost(budget));
    const appendedAt = this.ledger.exitIn(receipt, exit);
    const levy = daoFee(exit.amount);
    return { exitId: id, recipient: exit.recipient, gross: exit.amount, amount: exit.amount - levy, daoFee: levy,
      broadcasterFee: exit.fee, feeRecipient: exit.feeRecipient, appendedAt, receipt: receiptSummary(receipt) };
  }
}
