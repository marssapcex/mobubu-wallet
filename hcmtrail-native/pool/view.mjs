// Read only public state at a single block. No note-specific spent or log queries.
export async function readPool(pool, provider, fromBlock, { snapshot = false } = {}) {
  const block = await provider.getBlock('latest');
  const blockTag = block.number;
  const topics = ['BatchOpened', 'TicketQueued', 'BatchPaid'];
  if (snapshot) topics.push('LeafAppended', 'NullifiersSpent', 'PartReserved', 'Refunded');
  const [logs, shielded, reserved, root, leafCount] = await Promise.all([
    provider.getLogs({ address: pool.target, fromBlock, toBlock: blockTag,
      topics: [topics.map((name) => pool.interface.getEvent(name).topicHash)] }),
    pool.shieldedNative({ blockTag }), pool.reservedNative({ blockTag }), pool.currentRoot({ blockTag }), pool.leafCount({ blockTag }),
  ]);
  const rounds = new Map();
  const leaves = [], nullifiers = [], reservations = [], refunded = [];
  const key = (amount, round) => `${amount}:${round}`;
  for (const log of logs.sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index)) {
    const { name, args } = pool.interface.parseLog(log);
    switch (name) {
      case 'BatchOpened': {
        const [amount, round, target, expiresAt] = args;
        rounds.set(key(amount, round), { amount, round, target: Number(target), count: 0, expiresAt: Number(expiresAt), paid: false });
        break;
      }
      case 'TicketQueued': rounds.get(key(args[0], args[1])).count += 1; break;
      case 'BatchPaid': Object.assign(rounds.get(key(args[0], args[1])), { paid: true, tx: log.transactionHash, paidBlock: log.blockNumber }); break;
      case 'LeafAppended': {
        if (args[0] !== BigInt(leaves.length)) throw new Error('Missing leaf log');
        leaves.push(args[1]);
        break;
      }
      case 'NullifiersSpent': nullifiers.push(...args); break;
      case 'PartReserved': reservations.push({ ticket: args[0], nullifier: args[1], value: args[2], refundLeaf: args[3] }); break;
      case 'Refunded': refunded.push(args[0]); break;
    }
  }
  if (snapshot && BigInt(leaves.length) !== leafCount) throw new Error('Incomplete public tree snapshot');
  const rows = [...rounds.values()].map((row) => ({ ...row, missing: row.target - row.count,
    status: row.paid ? 'paid' : row.expiresAt <= block.timestamp ? 'expired' : row.target === row.count ? 'ready' : 'waiting' }));
  const batches = rows.filter((row) => row.status === 'waiting' || row.status === 'ready')
    .sort((a, b) => a.amount < b.amount ? -1 : a.amount > b.amount ? 1 : 0);
  const recent = rows.filter((r) => r.paid).sort((a, b) => b.paidBlock - a.paidBlock).slice(0, 4);
  return { block: blockTag, timestamp: block.timestamp, shielded, reserved, root, leafCount, batches, recent,
    ...(snapshot ? { leaves, nullifiers, reservations, refunded, history: rows } : {}) };
}
