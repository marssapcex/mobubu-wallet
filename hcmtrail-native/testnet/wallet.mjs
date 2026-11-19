import { ZeroAddress, ZeroHash } from 'ethers';
import { receiptSummary } from './deployment.mjs';
import { Ledger } from './ledger.mjs';
import { custodyCap, noteNullifier, openNote, seedEntry, uint, unpack, word256 } from './notes.mjs';
import { proofHash, proofShape, proveLocal } from './prover.mjs';
import { address, txId } from './rpc.mjs';
import { need } from './store.mjs';
import { GOLDILOCKS } from './networks.mjs';

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
    this.context = { schema: 1, asset: this.net.asset, chainId: manifest.chainId, vault: manifest.vault, domain: manifest.domain };
    this.domainLeaf = manifest.domainLeaf;
  }

  checkContext(stored) {
    need(stored && Object.entries(this.context).every(([k, v]) => stored[k] === v), 'Local artifact belongs to another deployment.');
  }

  keep(note, source) {
    const file = noteFile(note.leaf);
    need(note.value > 0n && note.leaf !== this.domainLeaf && !this.store.has(file), 'Refusing a zero, domain, or duplicate local note.');
    this.store.write(file, { ...this.context, leaf: note.leaf, value: note.value, secret: note.secret, blinding: note.blinding, source });
    return note.leaf;
  }

  amount(value) {
    const amount = uint(value, custodyCap(this.net), 'base-unit amount');
    need(amount > 0n && (!this.net.tvm || amount <= BigInt(Number.MAX_SAFE_INTEGER)), 'Use a positive testnet-sized amount in native base units.');
    return amount;
  }

  newNote(value) {
    const n = openNote(this.net, this.amount(value));
    return { note: this.keep(n, { kind: 'deposit' }), amount: n.value, ownerCommit: n.ownerCommit };
  }

  note(id) {
    const stored = this.store.read(noteFile(id));
    this.checkContext(stored);
    const { source } = stored;
    need(source?.kind === 'deposit' || source?.kind === 'change', 'Unknown local note source.');
    const n = openNote(this.net, this.amount(stored.value), stored.secret, stored.blinding);
    need(n.leaf === word256(id) && stored.leaf === n.leaf && n.leaf !== this.domainLeaf, 'Note opening does not derive the saved commitment.');
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
    const receipt = await this.txs.submit(label, this.ledger.spec('deposit', [note.ownerCommit], note.value));
    return this.recordFunding(note, receipt);
  }

  recipient(text) {
    const to = address(this.net, text);
    need(to !== ZeroAddress && to !== this.context.vault, 'Payout must target a nonzero address outside the vault.');
    return to;
  }

  exitTerms(terms) {
    const root = word256(terms.root);
    const pair = (v) => {
      need(Array.isArray(v) && v.length === 2, 'Expected two public digest words.');
      return v.map((word) => { const w = word256(word); unpack(w); need(w !== ZeroHash, 'Zero public digest.'); return w; });
    };
    const nullifiers = pair(terms.nullifiers), change = pair(terms.change);
    const amount = this.amount(terms.amount);
    const notBefore = uint(terms.notBefore, GOLDILOCKS - 1n, 'NotBefore');
    const fee = uint(terms.fee, 0n, 'self-submit fee');
    unpack(root);
    need(root !== ZeroHash && nullifiers[0] !== nullifiers[1] && !change.includes(this.domainLeaf) &&
      address(this.net, terms.feeRecipient) === ZeroAddress && notBefore > 0n && notBefore % 600n === 0n,
    'Public exit is not a valid zero-fee local withdrawal.');
    return { root, nullifiers, change, recipient: this.recipient(terms.recipient), feeRecipient: ZeroAddress, amount, fee, notBefore };
  }

  async prove(id, payout, recipient, prover) {
    const note = this.note(id);
    const amount = this.amount(payout);
    const to = this.recipient(recipient);
    need(amount <= note.value, 'Requested payout exceeds the input note value.');
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
      recipient: to, fee_recipient: ZeroAddress, clearing_price: 0n, not_before: notBefore,
      public_amount: amount, fee: 0n, output_values: [note.value - amount, 0n], self_submit: true, any_amount: true,
    };
    const seed = { secrets: [note.secret, dummy.secret], notes: [seedEntry(note, this.net), seedEntry(dummy, this.net)] };
    const result = await proveLocal(this.store, this.net, prover, request, seed, nf, this.txs.report);
    const exit = this.exitTerms(result.exit);
    const hash = proofHash(result.proof);
    const changeNote = result.outputs[0].value > 0n ? this.keep(result.outputs[0], { kind: 'change', slot: 0, exitId: hash, exit }) : null;
    // The opening has been fsynced before releasing *any* public proof which could be relayed.
    this.store.write(planFile(hash), { ...this.context, input: note.leaf, inputIndex: fund.index, changeNote });
    this.store.write(exitFile(hash), { ...this.context, id: hash, proof: result.proof, exit, proofBytes: result.proofBytes, prover: result.build });
    return { exitId: hash, publicFile: exitFile(hash), changeNote, payout: amount, recipient: to,
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
    need(noteNullifier(note, p.inputIndex) === e.exit.nullifiers[0] && note.value >= e.exit.amount,
      'Saved note and position do not match the exit.');
    const remaining = note.value - e.exit.amount;
    if (remaining === 0n) need(p.changeNote === null, 'Unexpected local change opening.');
    else {
      const change = this.note(p.changeNote);
      need(change.value === remaining && change.leaf === e.exit.change[0] && change.source.kind === 'change' && change.source.exitId === e.id,
        'Backed-up change opening is missing or does not match the proof.');
    }
    return p;
  }

  async preflight(id) {
    const e = this.loadExit(id);
    this.checkedPlan(e);
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
    const result = { exitId: e.id, recipient: e.exit.recipient, amount: e.exit.amount, changeNote: p.changeNote,
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
    if (!this.txs.existing(`withdraw-${e.id}`)) {
      const used = await Promise.all(e.exit.nullifiers.map((nf) => this.ledger.read('spent', [nf])));
      need(!used.some(Boolean), 'AlreadySpent: no new transaction. Use recover-exit if this proof was relayed.');
      need(await this.ledger.read('knownRoot', [e.exit.root]), 'UnknownRoot: proof does not belong to this vault tree.');
    }
    const receipt = await this.txs.submit(`withdraw-${e.id}`, this.ledger.spec('withdraw', [e.proof, e.exit]));
    return this.recordExit(e, receipt);
  }
}
