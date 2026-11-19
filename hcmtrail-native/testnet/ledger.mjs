import { Interface, ZeroHash } from 'ethers';
import { daoFee } from './dao-policy.mjs';
import { callSpec, view } from './deployment.mjs';
import { rebuildRoot, unpack, uint } from './notes.mjs';
import { need } from './store.mjs';

const MAX_LEAVES = 16_384n; // Testnet client limit, NOT a limit in the vault contract.
const LEAF = 'LeafAppended';
const ROOT = 'RootPublished';
const DEPOSIT = 'Deposited';
const WITHDRAW = 'Withdrawn';
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

export class Ledger {
  constructor(chain, manifest, abi) {
    this.chain = chain;
    this.m = manifest;
    this.at = manifest.vault;
    this.from = uint(manifest.created.block, (1n << 64n) - 1n, 'deployment block');
    this.iface = new Interface(abi);
  }

  spec(method, args = [], value = 0n) { return callSpec(this.iface, this.at, method, args, value); }
  read(method, args, at) { return view(this.chain, this.iface, this.at, method, args, at); }
  topic(event) { return this.iface.getEvent(event).topicHash; }

  events(receipt, name) {
    return receipt.logs.filter((l) => l.address === this.at && l.topics[0] === this.topic(name)).map((log) => {
      need(log.hash === receipt.hash && log.blockHash === receipt.blockHash && log.blockNumber === receipt.blockNumber,
        'Receipt log metadata disagrees with the canonical receipt.');
      return this.iface.parseLog(log).args;
    });
  }

  async *scan(topics, head) {
    for (let start = this.from; start <= head.number; start += this.chain.logPage) {
      const last = start + this.chain.logPage - 1n;
      const to = last > head.number ? head.number : last;
      const logs = await this.chain.logs(this.at, topics, start, to);
      for (const log of logs) {
        need(log.address === this.at && log.blockNumber >= start && log.blockNumber <= to &&
          (Array.isArray(topics[0]) ? topics[0].includes(log.topics[0]) : topics[0] === log.topics[0]),
        'RPC returned a vault log outside the requested filter.');
        yield { log, event: this.iface.parseLog(log) };
      }
    }
  }

  async confirmed(hash) {
    const r = await this.chain.receipt(hash);
    need(r?.ok, `No successful confirmed receipt for ${hash}.`);
    return r;
  }

  async snapshot() {
    const head = await this.chain.head();
    let anchor;
    const rows = [];
    let total = 0;
    for await (const { log, event } of this.scan([[this.topic(LEAF), this.topic(ROOT)]], head)) {
      need(++total <= Number(MAX_LEAVES) * 2, 'Testnet log scan exceeded the local wallet resource cap.');
      if (event.name === LEAF) rows.push({ ...log, leafIndex: event.args[0], leaf: event.args[1] });
      else if (event.name === ROOT) {
        const [root, count] = event.args;
        if (!anchor || count > anchor.count) anchor = { ...log, count, root };
        else need(count !== anchor.count, 'Duplicate tree root publication at the anchor count.');
      }
    }
    rows.sort((a, b) => compare(a.leafIndex, b.leafIndex));
    need(anchor && anchor.count <= MAX_LEAVES && BigInt(rows.length) === anchor.count && rows[0]?.leaf === this.m.domainLeaf,
      'Incomplete or oversized leaf log range, or wrong domain leaf.');
    for (const [i, row] of rows.entries()) {
      need(row.leafIndex === BigInt(i) && row.leaf !== ZeroHash && (i === 0 || row.leaf !== this.m.domainLeaf),
        'Missing, duplicate, or invalid leaf index.');
      unpack(row.leaf);
    }
    const last = rows.at(-1);
    need(last.hash === anchor.hash && last.blockHash === anchor.blockHash, 'Root event does not match last inserted leaf.');
    const receipt = await this.confirmed(anchor.hash);
    need(receipt.blockHash === anchor.blockHash && this.events(receipt, ROOT).some(([root, count]) => root === anchor.root && count === anchor.count),
      'Snapshot root publication is absent from its confirmed receipt.');
    const leaves = rows.map((row) => row.leaf);
    need(rebuildRoot(leaves) === anchor.root, 'Leaf log sequence does not rebuild the confirmed tree root.');
    if (this.chain.historical) {
      const [count, root] = await Promise.all([this.read('leafCount', [], head.number), this.read('currentRoot', [], head.number)]);
      need(count === anchor.count && root === anchor.root, 'RPC log scan differs from vault state at the confirmed block.');
    }
    need(await this.read('knownRoot', [anchor.root]), 'Anchor is no longer a known vault root.');
    need((await this.chain.block(head.number)).hash === head.hash, 'Confirmed RPC snapshot reorged; try again.');
    return { head, root: anchor.root, leaves, rows };
  }

  checkDaoFee(receipt, withdrawal, gross) {
    if (!this.m.dao) return 0n;
    const fee = daoFee(gross);
    need(this.events(receipt, 'DaoFeePaid').some(([isExit, value, paid]) => isExit === withdrawal && value === gross && paid === fee),
      'Receipt is missing the matching DAO fee.');
    return fee;
  }

  depositIn(receipt, note) {
    const gross = note.source?.gross ?? note.value;
    need(gross - this.checkDaoFee(receipt, false, gross) === note.value, 'Net deposit amount disagrees with the note opening.');
    const deposits = this.events(receipt, DEPOSIT).filter(([, leaf, value]) => leaf === note.leaf && value === note.value);
    need(deposits.length === 1, 'Receipt does not contain exactly one matching vault deposit.');
    const index = deposits[0][0];
    need(index > 0n && this.events(receipt, LEAF).some(([i, leaf]) => i === index && leaf === note.leaf) &&
      this.events(receipt, ROOT).some(([, count]) => count === index + 1n),
    'Deposit receipt lacks its leaf/root publication.');
    return index;
  }

  exitIn(receipt, exit) {
    const net = BigInt(exit.amount) - this.checkDaoFee(receipt, true, BigInt(exit.amount));
    const paid = this.events(receipt, WITHDRAW).filter(([n0, n1, recipient, amount, feeRecipient, fee]) =>
      n0 === exit.nullifiers[0] && n1 === exit.nullifiers[1] && recipient === exit.recipient &&
      amount === net && feeRecipient === exit.feeRecipient && fee === BigInt(exit.fee));
    // The pinned vault checks msg.sender. A smart-contract broadcaster need not be the outer tx sender.
    need(paid.length === 1, 'Receipt does not contain exactly one matching vault payout.');
    const leaves = this.events(receipt, LEAF);
    const pair = leaves.filter(([index, hash], i) => hash === exit.change[0] &&
      leaves[i + 1]?.[0] === index + 1n && leaves[i + 1][1] === exit.change[1]);
    need(pair.length === 1 && pair[0][0] > 0n && this.events(receipt, ROOT).some(([, count]) => count === pair[0][0] + 2n),
      'Withdrawal receipt has no matching consecutive change leaves and root.');
    return pair[0][0];
  }

  async findExit(exit) {
    const head = await this.chain.head();
    const hashes = new Set();
    for await (const { log, event } of this.scan([this.topic(WITHDRAW), exit.nullifiers[0], exit.nullifiers[1]], head)) {
      need(event.args[0] === exit.nullifiers[0] && event.args[1] === exit.nullifiers[1], 'RPC returned a different nullifier pair.');
      hashes.add(log.hash);
    }
    need(hashes.size === 1, 'Withdrawal log is missing or ambiguous at confirmed height. If relayed, supply its transaction ID.');
    return this.confirmed([...hashes][0]);
  }

  async depositCandidates(note) {
    const head = await this.chain.head();
    const hits = [];
    for await (const { log, event } of this.scan([this.topic(DEPOSIT), null, note.leaf], head)) {
      need(event.args[1] === note.leaf, 'RPC returned a different deposit commitment.');
      if (event.args[2] === note.value) hits.push(log.hash);
    }
    return hits;
  }
}
