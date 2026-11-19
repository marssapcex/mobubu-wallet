import { ZeroAddress } from 'ethers';
import { daoFee } from './dao-policy.mjs';
import { exitContext, exitTerms, inContext, localAmount, payoutAddress } from './exit-terms.mjs';
import { activeBroadcaster, validateQuote } from './relay.mjs';
import { receiptSummary } from './deployment.mjs';
import { Ledger } from './ledger.mjs';
import { noteNullifier, openNote, seedEntry, word256 } from './notes.mjs';
import { proofHash, proofShape, proveLocal } from './prover.mjs';
import { txId } from './rpc.mjs';
import { need } from './store.mjs';

const noteFile = (leaf) => `note-${word256(leaf)}.json`;
const fundFile = (leaf) => `fund-${word256(leaf)}.json`;
const exitFile = (id) => `exit-${word256(id)}.json`;
const planFile = (id) => `plan-${word256(id)}.json`;
const paidFile = (id) => `paid-${word256(id)}.json`;

export class TestnetWallet {
  constructor(chain, store, txs, manifest, abi) {
    this.chain = chain;
    this.net = chain.network;
    this.store = store;
    this.txs = txs;
    this.ledger = new Ledger(chain, manifest, abi);
    this.manifest = manifest;
    this.context = exitContext(this.net, manifest);
    this.domainLeaf = manifest.domainLeaf;
  }

  checkContext(stored) {
    need(inContext(this.context, stored), 'Local artifact belongs to another deployment.');
  }

  keep(note, source) {
    const file = noteFile(note.leaf);
    need(note.value > 0n && note.leaf !== this.domainLeaf && !this.store.has(file), 'Refusing a zero, domain, or duplicate local note.');
    this.store.write(file, { ...this.context, leaf: note.leaf, value: note.value, secret: note.secret, blinding: note.blinding, source });
    return note.leaf;
  }

  amount(value) { return localAmount(this.net, value); }

  newNote(value) {
    const gross = this.amount(value);
    const fee = this.manifest.dao ? daoFee(gross) : 0n;
    const n = openNote(this.net, gross - fee);
    const note = this.keep(n, { kind: 'deposit', ...(this.manifest.dao ? { gross } : {}) });
    return { note, amount: n.value, ownerCommit: n.ownerCommit, ...(this.manifest.dao ? { gross, daoFee: fee } : {}) };
  }

  note(id) {
    const stored = this.store.read(noteFile(id));
    this.checkContext(stored);
    const { source } = stored;
    need(source?.kind === 'deposit' || source?.kind === 'change', 'Unknown local note source.');
    const n = openNote(this.net, this.amount(stored.value), stored.secret, stored.blinding);
    need(n.leaf === word256(id) && stored.leaf === n.leaf && n.leaf !== this.domainLeaf, 'Note opening does not derive the saved commitment.');
    if (source.kind === 'deposit' && this.manifest.dao) {
      const gross = this.amount(source.gross);
      need(n.value === gross - daoFee(gross), 'Saved gross deposit does not match its net note opening.');
      source.gross = gross;
    }
    return { ...n, source };
  }

  async recordFunding(note, receipt) {
    let index;
    if (note.source.kind === 'deposit') index = this.ledger.depositIn(receipt, note);
    else {
      const exit = this.exitTerms(note.source.exit);
      need(note.source.slot === 0 && exit.change[0] === note.leaf, 'Change note does not match its saved exit.');
      index = this.ledger.exitIn(receipt, exit);
    }
    const data = { note: note.leaf, index, receipt: receiptSummary(receipt) };
    // A recovery can recheck an existing record after a reorg; never silently change a valid funded index.
    const file = fundFile(note.leaf);
    if (this.store.has(file)) {
      const previous = this.store.read(file);
      need(previous.receipt?.hash === receipt.hash && previous.index === String(index), 'Funding disagrees with the stored note position. Review receipts before replacing local evidence.');
    }
    this.store.write(file, data);
    return data;
  }

  async recoverNote(id, hash) {
    const note = this.note(id);
    const file = fundFile(id);
    if (!hash && this.store.has(file)) hash = this.store.read(file).receipt.hash;
    let receipt;
    if (hash) receipt = await this.ledger.confirmed(txId(hash));
    else if (note.source.kind === 'change') receipt = await this.ledger.findExit(this.exitTerms(note.source.exit));
    else {
      const label = `deposit-${note.leaf}`;
      const pending = this.txs.existing(label);
      // A funded note can be recovered on a separate machine without the signed journal.
      if (pending) receipt = await this.ledger.confirmed(txId(pending.envelope.hash));
      else {
        const hits = await this.ledger.depositCandidates(note);
        need(hits.length === 1, 'Deposit not confirmed or ambiguous. Supply its confirmed transaction ID.');
        receipt = await this.ledger.confirmed(hits[0]);
      }
    }
    return this.recordFunding(note, receipt);
  }

  async deposit(id) {
    const note = this.note(id);
    need(note.source.kind === 'deposit', 'A recovered change note must not be deposited again.');
    const label = `deposit-${note.leaf}`;
    if (this.store.has(fundFile(id))) return this.recoverNote(id);
    if (!this.txs.existing(label)) {
      const hits = await this.ledger.depositCandidates(note);
      if (hits.length) {
        need(hits.length === 1, 'Note was deposited more than once; recover the intended position by transaction ID.');
        return this.recoverNote(id, hits[0]);
      }
      need(await this.ledger.read('commitment', [note.value, note.ownerCommit]) === note.leaf,
        'Vault commitment does not match the locally generated opening.');
    }
    const receipt = await this.txs.submit(label, this.ledger.spec('deposit', [note.ownerCommit], note.source.gross ?? note.value));
    return this.recordFunding(note, receipt);
  }

  exitTerms(terms) { return exitTerms(this.net, this.manifest, terms); }

  async prove(id, payout, recipient, prover, quote) {
    const note = this.note(id);
    const amount = this.amount(payout);
    const to = payoutAddress(this.net, this.manifest, recipient);
    const relay = quote === undefined ? { fee: 0n, feeRecipient: ZeroAddress } : validateQuote(this.net, this.manifest, quote);
    const debit = amount + relay.fee;
    need(debit <= note.value, 'Gross payout plus broadcaster fee exceeds the input note value.');
    if (relay.fee !== 0n) {
      need(await activeBroadcaster(this.chain, this.manifest, relay.feeRecipient), 'Broadcaster does not hold 100 active staked HCMT.');
    }
    const fund = await this.recoverNote(id);
    const snapshot = await this.ledger.snapshot();
    const row = snapshot.rows[Number(fund.index)];
    need(row?.leaf === note.leaf && row.hash === fund.receipt.hash && row.blockHash === fund.receipt.blockHash,
      'Funded note is missing from the confirmed and reconstructed tree.');
    const nf = noteNullifier(note, fund.index);
    need(!await this.ledger.read('spent', [nf]), 'This funded note has already been spent.');
    const notBefore = snapshot.head.timestamp / 600n * 600n;
    need(notBefore > 0n, 'Chain timestamp is not valid for the NotBefore grid.');
    const dummy = openNote(this.net, 0n);
    const request = {
      asset_id: this.net.assetId, note_root: snapshot.root, assoc_root: snapshot.root,
      pool_leaves: snapshot.leaves, assoc_leaves: snapshot.leaves, input_pool_index: [fund.index, 0n], input_assoc_index: [fund.index, 0n],
      recipient: to, fee_recipient: relay.feeRecipient, clearing_price: 0n, not_before: notBefore,
      public_amount: amount, fee: relay.fee, output_values: [note.value - debit, 0n], self_submit: relay.fee === 0n, any_amount: true,
    };
    const seed = { secrets: [note.secret, dummy.secret], notes: [seedEntry(note, this.net), seedEntry(dummy, this.net)] };
    const result = await proveLocal(this.store, this.net, prover, request, seed, nf, this.txs.report);
    const exit = this.exitTerms(result.exit);
    const hash = proofHash(result.proof);
    const changeNote = result.outputs[0].value > 0n ? this.keep(result.outputs[0], { kind: 'change', slot: 0, exitId: hash, exit }) : null;
    // The opening has been fsynced before releasing *any* public proof which could be relayed.
    this.store.write(planFile(hash), { ...this.context, input: note.leaf, inputIndex: fund.index, changeNote });
    this.store.write(exitFile(hash), { ...this.context, id: hash, proof: result.proof, exit, proofBytes: result.proofBytes, prover: result.build });
    const levy = this.manifest.dao ? daoFee(amount) : 0n;
    return { exitId: hash, publicFile: exitFile(hash), changeNote, payout: amount - levy, recipient: to,
      ...(this.manifest.dao ? { gross: amount, daoFee: levy, broadcasterFee: relay.fee, feeRecipient: relay.feeRecipient, debit } : {}),
      proofBytes: result.proofBytes, proofSeconds: result.proofSeconds, root: exit.root };
  }

  loadExit(id) {
    const e = this.store.read(exitFile(id));
    this.checkContext(e);
    need(e.id === word256(id) && proofShape(e.proof) && proofHash(e.proof) === e.id, 'Proof envelope length, header or SHA-256 mismatch.');
    return { proof: e.proof, exit: this.exitTerms(e.exit), id: e.id };
  }

  checkedPlan(e) {
    const p = this.store.read(planFile(e.id));
    this.checkContext(p);
    const note = this.note(p.input);
    const debit = e.exit.amount + e.exit.fee;
    need(noteNullifier(note, p.inputIndex) === e.exit.nullifiers[0] && note.value >= debit,
      'Saved note and position do not match the exit.');
    const remaining = note.value - debit;
    if (remaining === 0n) need(p.changeNote === null, 'Unexpected local change opening.');
    else {
      const change = this.note(p.changeNote);
      need(change.value === remaining && change.leaf === e.exit.change[0] && change.source.kind === 'change' && change.source.exitId === e.id,
        'Backed-up change opening is missing or does not match the proof.');
    }
    return p;
  }

  exportRelay(id) {
    const e = this.loadExit(id);
    this.checkedPlan(e);
    need(e.exit.fee > 0n, 'This exit was not prepared for a paid broadcaster.');
    return { ...this.context, ...e };
  }

  async preflight(id) {
    const e = this.loadExit(id);
    this.checkedPlan(e);
    need(e.exit.fee === 0n, 'Use relay-export and have the quoted broadcaster run relay-check for a paid exit.');
    for (const nf of e.exit.nullifiers) need(!await this.ledger.read('spent', [nf]), 'AlreadySpent: this proof must not be submitted again.');
    need(await this.ledger.read('knownRoot', [e.exit.root]), 'UnknownRoot: proof does not belong to this vault tree.');
    const spec = this.ledger.spec('withdraw', [e.proof, e.exit]);
    return { ...await this.chain.simulate(spec), calldataBytes: (spec.data.length - 2) / 2 };
  }

  async recordExit(e, receipt) {
    const index = this.ledger.exitIn(receipt, e.exit);
    for (const nf of e.exit.nullifiers) need(await this.ledger.read('spent', [nf]), 'Confirmed receipt did not retire both nullifiers.');
    const p = this.checkedPlan(e);
    if (p.changeNote) await this.recordFunding(this.note(p.changeNote), receipt);
    const levy = this.manifest.dao ? daoFee(e.exit.amount) : 0n;
    const result = { exitId: e.id, recipient: e.exit.recipient, amount: e.exit.amount - levy, changeNote: p.changeNote,
      ...(this.manifest.dao ? { gross: e.exit.amount, daoFee: levy, broadcasterFee: e.exit.fee, feeRecipient: e.exit.feeRecipient } : {}),
      appendedAt: index, receipt: receiptSummary(receipt) };
    this.store.write(paidFile(e.id), result);
    return result;
  }

  async recoverExit(id, hash) {
    const e = this.loadExit(id);
    if (!hash && this.store.has(paidFile(id))) hash = this.store.read(paidFile(id)).receipt.hash;
    const receipt = hash ? await this.ledger.confirmed(txId(hash)) : await this.ledger.findExit(e.exit);
    return this.recordExit(e, receipt);
  }

  async withdraw(id) {
    const e = this.loadExit(id);
    this.checkedPlan(e);
    if (this.store.has(paidFile(id))) return this.recoverExit(id);
    need(e.exit.fee === 0n, 'This exit must be sent by the quoted broadcaster, or recovered after confirmation.');
    if (!this.txs.existing(`withdraw-${e.id}`)) {
      const used = await Promise.all(e.exit.nullifiers.map((nf) => this.ledger.read('spent', [nf])));
      need(!used.some(Boolean), 'AlreadySpent: no new transaction. Use recover-exit if this proof was relayed.');
      need(await this.ledger.read('knownRoot', [e.exit.root]), 'UnknownRoot: proof does not belong to this vault tree.');
    }
    const receipt = await this.txs.submit(`withdraw-${e.id}`, this.ledger.spec('withdraw', [e.proof, e.exit]));
    return this.recordExit(e, receipt);
  }
}
