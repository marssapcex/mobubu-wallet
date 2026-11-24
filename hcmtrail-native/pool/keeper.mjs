// Permissionless transaction sender. It only reads public queue state and submits
// executeBatch; it never receives a note, witness, or change/refund opening.
export async function settleReady({ pool, read, send, report = () => {} }) {
  const state = await read();
  for (const { amount, round, status } of state.batches) {
    if (status !== 'ready') continue;
    try {
      const [expiresAt, target, count, paid] = await pool.getBatch(amount, round);
      if (paid || Number(expiresAt) <= state.timestamp || count !== target) continue;
      const receipt = await send('executeBatch', [amount, round]);
      report({ amount, round, receipt });
    } catch {
      // Another keeper may win, or an address may reject ETH. Don't block other
      // amounts; for the rejected batch the bound refund notes remain recoverable.
      report({ amount, round, failed: true });
    }
  }
}
