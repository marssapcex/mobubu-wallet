import { Interface, getAddress, keccak256, toQuantity } from 'ethers';
import { assetFor, baseUnits, CAPACITY, createNote, evmDomain, nonzero32, readNote } from './notes.mjs';
import { treeFromLeaves } from './tree.mjs';

const iface = new Interface([
  'function deposit(bytes32 noteKey) payable returns (uint32, bytes32)',
  'function domain() view returns (bytes32)',
  'function count() view returns (uint32)',
  'function root() view returns (bytes32)',
  'event LeafInserted(uint32 indexed index, bytes32 indexed leaf, bytes32 root)',
]);
const leafTopic = iface.getEvent('LeafInserted').topicHash;
const blockAt = (blockHash) => ({ blockHash, requireCanonical: true });
const DEVNET = Object.freeze({ ETH: 31_337n, BNB: 31_338n });
const hash32 = (value) => { nonzero32(value); return value; };

/** Local-devnet client; deployment pins and RPC must come from trusted local
 * configuration. All leaf events are fetched, never filtered by a user's note.
 * A snapshot is a membership anchor, not proof that a note is still unspent. */
export async function openEvmPool({ asset, rpc, vault, genesis, codeHash, deploymentBlock }) {
  const currency = assetFor(asset), chainId = DEVNET[currency.symbol], address = getAddress(vault);
  if (chainId === undefined || typeof rpc !== 'function' || !Number.isSafeInteger(deploymentBlock) || deploymentBlock < 1) {
    throw new Error('expected a local ETH/BNB pool deployment');
  }
  hash32(genesis); hash32(codeHash);
  const domain = await evmDomain(chainId, address);
  async function view(name, pinned, args = []) {
    const result = await rpc('eth_call', [{ to: address, data: iface.encodeFunctionData(name, args) }, blockAt(pinned)]);
    return iface.decodeFunctionResult(name, result)[0];
  }
  async function pin() {
    const [actualId, initial, block] = await Promise.all([rpc('eth_chainId'), rpc('eth_getBlockByNumber', ['0x0', false]),
      rpc('eth_getBlockByNumber', ['finalized', false])]);
    if (BigInt(actualId) !== chainId || initial?.hash !== genesis) throw new Error('wrong pool chain or genesis');
    const hash = hash32(block?.hash), height = Number(BigInt(block.number));
    if (!Number.isSafeInteger(height) || height < deploymentBlock) throw new Error('pool deployment not finalized');
    const [code, foundDomain] = await Promise.all([rpc('eth_getCode', [address, blockAt(hash)]), view('domain', hash)]);
    if (code === '0x' || keccak256(code) !== codeHash || foundDomain !== domain) throw new Error('wrong deployed pool');
    return { hash, height };
  }
  return Object.freeze({ asset: currency.id, chainId, address, domain,
    async draft(value) {
      await pin();
      const note = await createNote({ asset: currency.id, domain, value: baseUnits(value, currency.id) });
      // Persist the note before asking a wallet to sign this transaction.
      return Object.freeze({ note, transaction: Object.freeze({ to: address, chainId, value: BigInt(note.value),
        data: iface.encodeFunctionData('deposit', [note.key]) }) });
    },
    async snapshot() {
      const { hash, height } = await pin();
      const [count, root] = await Promise.all([view('count', hash), view('root', hash)]);
      if (count > CAPACITY) throw new Error('invalid pool count');
      const leaves = [], positions = new Map();
      let frontierRoot;
      for (let start = deploymentBlock; start <= height; start += 1_000) {
        const end = Math.min(height, start + 999);
        const logs = await rpc('eth_getLogs', [{ address, fromBlock: toQuantity(start), toBlock: toQuantity(end), topics: [leafTopic] }]);
        if (!Array.isArray(logs) || leaves.length + logs.length > Number(count)) throw new Error('invalid pool log response');
        for (const log of logs) {
          if (log.removed || getAddress(log.address) !== address || log.topics?.[0] !== leafTopic ||
              BigInt(log.blockNumber) < BigInt(start) || BigInt(log.blockNumber) > BigInt(end)) throw new Error('invalid pool leaf log');
          const { args } = iface.parseLog(log);
          if (args.index !== BigInt(leaves.length) || positions.has(args.leaf)) throw new Error('missing, duplicate or out-of-order pool leaf');
          positions.set(args.leaf, leaves.length);
          leaves.push(args.leaf);
          frontierRoot = args.root;
        }
      }
      const tree = await treeFromLeaves(leaves);
      const canonical = await rpc('eth_getBlockByNumber', [toQuantity(height), false]);
      if (tree.root !== root || (count > 0 && frontierRoot !== root) || BigInt(tree.count) !== count || canonical?.hash !== hash) {
        throw new Error('pool logs do not match the finalized root');
      }
      return Object.freeze({ blockHash: hash, height, root, count: tree.count, async anchor(rawNote) {
        const note = await readNote(rawNote);
        if (note.asset !== currency.id || note.domain !== domain) throw new Error('note belongs to another pool');
        const index = positions.get(note.leaf);
        if (index === undefined) throw new Error('note has no finalized deposit in this pool');
        return tree.path(index);
      } });
    },
  });
}
