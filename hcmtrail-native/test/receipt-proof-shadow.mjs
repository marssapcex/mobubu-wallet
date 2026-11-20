import assert from 'node:assert/strict';
import { getBytes } from 'ethers';
import { compileReceiptProof } from '../scripts/build-receipt-proof.mjs';
import { collectReceiptEvidence } from '../testnet/receipt-proof.mjs';
import { on } from './crosschain-fixture.mjs';

// Read-only second verification of real settlement logs. The V1 trade still uses its quorum.
// Freeze a checkpoint from this isolated source VM; never use this selection rule on a public chain.
export async function verifyHistoricalSettlement(from, to, emitter, order, messages) {
  const a = compileReceiptProof({ fixtures: true });
  const rpc = (name, args) => from.chain.rpc(name, args);
  const fromId = from.chain.network.chainId, toId = to.chain.network.chainId;
  const genesis = await rpc('eth_getBlockByNumber', ['0x0', false]);
  const checkpoint = await rpc('eth_getBlockByNumber', ['latest', false]);
  const probe = await on(to, a, 'ReceiptProofFixture');
  const adapter = await on(to, a, 'EvmCheckpointReceiptVerifier', [fromId, genesis.hash, BigInt(checkpoint.number), checkpoint.hash,
    emitter.at, probe.at, messages.reduce((bits, { kind }) => bits | (1 << (kind - 1)), 0)]);
  const topic = emitter.abi.getEvent('SettlementMessage').topicHash;
  for (const { tx, kind, data } of messages) {
    const raw = await rpc('eth_getTransactionReceipt', [tx.hash]);
    assert.equal(raw.blockHash, tx.blockHash);
    const matching = raw.logs.flatMap((log, i) => {
      if (log.address.toLowerCase() !== emitter.at.toLowerCase() || log.topics[0] !== topic) return [];
      const e = emitter.abi.parseLog(log).args;
      return e[0] === BigInt(kind) && e[1] === order && e[2] === data ? [i] : [];
    });
    assert.equal(matching.length, 1);
    const proof = await collectReceiptEvidence(rpc, { checkpointHash: checkpoint.hash, blockHash: raw.blockHash,
      txIndex: Number(BigInt(raw.transactionIndex)), logIndex: matching[0] });
    assert.equal(await probe.read('check', [adapter.at, fromId, emitter.at, kind, order, data, proof]), true);
    console.log(`Receipt-only shadow ${fromId} → ${toId}, kind=${kind}: ${getBytes(proof).length} B from actual settlement receipt`);
  }
  return adapter;
}
