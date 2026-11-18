import { Interface, Transaction, Wallet, ZeroAddress, getAddress, keccak256 } from 'ethers';
import { PAY, REFUND, COLLECT, REJECT, ORDER_TUPLE, address, hex, pqSign, settlementMessage, uint } from './protocol.mjs';

export const SWAP_RAIL_ABI = Object.freeze([
  `function fund(${ORDER_TUPLE} order,address refund,bytes signature) payable`,
  `function pay(${ORDER_TUPLE} order,address recipient,bytes userSignature,bytes treasurySignature)`,
  'function settle(uint8 action,bytes32 orderId,address recipient,uint256 amount,bytes signature)',
  'function provideLiquidity() payable',
  'function liquidity() view returns (uint256)',
  'function escrowed() view returns (uint256)',
  'function treasuryKey() view returns (bytes32)',
  'function payoutState(bytes32 orderId) view returns(uint8)',
  'function credits(bytes32 orderId) view returns(uint256 amount,address refund,uint8 state)',
  'event Funded(bytes32 indexed orderId,address indexed payer,uint256 amount)',
  'event Resolved(bytes32 indexed orderId,uint8 indexed action,address recipient,uint256 amount,bool delivered)',
]);
const iface = new Interface(SWAP_RAIL_ABI);
const gasLimit = (kind) => kind === PAY ? 5_500_000n : 3_200_000n;
const MAX_U256 = (1n << 256n) - 1n;

export function evmFunding(policy, order) {
  if (order.from === 'BTC') throw new Error('not an EVM deposit');
  const c = policy.rails[order.from];
  return Object.freeze({ to: c.rail, chainId: c.chainId, from: order.wire.payer, value: order.wire.amountIn,
    data: iface.encodeFunctionData('fund', [order.wire, order.refund.address, order.signature]) });
}

export function makeEvmRail({ policy, chain, rpc, gasKey, treasurySecret, relayerAddress, maxGasPrice }) {
  if (chain !== 'ETH' && chain !== 'BNB') throw new Error('not an EVM leg');
  const c = policy.rails[chain];
  // Read-only instances do not receive either key. Keep operational keys out of public configs.
  const wallet = gasKey ? new Wallet(gasKey) : null;
  const signer = wallet ? wallet.address : relayerAddress && address(relayerAddress);
  if (relayerAddress && wallet?.address && address(relayerAddress) !== wallet.address) throw new Error('wrong gas signer');
  const gasPriceCap = maxGasPrice === undefined ? undefined : uint(maxGasPrice, 'gas price cap', 10n ** 14n, 1n);

  async function pin() {
    const [id, genesis, bytecode] = await Promise.all([
      rpc('eth_chainId'), rpc('eth_getBlockByNumber', ['0x0', false]), rpc('eth_getCode', [c.rail, 'latest']),
    ]);
    if (BigInt(id) !== c.chainId || hex(genesis?.hash, 32) !== c.genesis || keccak256(bytecode) !== c.codeHash) {
      throw new Error(`wrong ${chain} chain or swap-rail code`);
    }
    const key = await rpc('eth_call', [{ to: c.rail, data: iface.encodeFunctionData('treasuryKey') }, 'latest']);
    if (iface.decodeFunctionResult('treasuryKey', key)[0] !== c.treasury) throw new Error('wrong EVM treasury key');
  }
  async function finalReceipt(txid) {
    await pin();
    const tx = hex(txid, 32, 'EVM tx ID');
    const receipt = await rpc('eth_getTransactionReceipt', [tx]);
    if (receipt === null) return { status: 'missing' };
    if (hex(receipt.transactionHash, 32) !== tx || getAddress(receipt.to) !== c.rail || !Array.isArray(receipt.logs)) {
      throw new Error('not a transaction to the authorized rail');
    }
    const [block, tip, finalized] = await Promise.all([
      rpc('eth_getBlockByNumber', [receipt.blockNumber, false]), rpc('eth_blockNumber'), rpc('eth_getBlockByNumber', ['finalized', false]),
    ]);
    if (!finalized?.hash) throw new Error(`${chain} RPC must support finalized blocks`);
    if (!block?.hash || block.hash !== receipt.blockHash) return { status: 'orphaned' };
    const height = BigInt(receipt.blockNumber);
    if (height > BigInt(finalized.number) || BigInt(tip) - height + 1n < BigInt(c.depth)) return { status: 'confirming' };
    const canonicalFinal = height === BigInt(finalized.number) ? block : await rpc('eth_getBlockByNumber', [finalized.number, false]);
    if (canonicalFinal?.hash !== finalized.hash) return { status: 'orphaned' };
    return { status: 'final', receipt, block };
  }
  function readLogs(r, name) {
    const topic = iface.getEvent(name).topicHash;
    return r.logs.filter((log) => getAddress(log.address) === c.rail && log.topics[0] === topic)
      .map((log) => ({ parsed: iface.parseLog(log), index: Number(BigInt(log.logIndex)) }));
  }
  async function observeFunding(order, ref) {
    if (order.from !== chain) throw new Error('funding chain mismatch');
    const read = await finalReceipt(ref.txid);
    if (read.status !== 'final') return null;
    const { block, receipt } = read;
    if (receipt.status !== '0x1') throw new Error('EVM funding transaction failed');
    const log = readLogs(receipt, 'Funded').find(({ index }) => index === ref.index);
    if (!log || log.parsed.args.orderId !== order.id || log.parsed.args.payer !== order.wire.payer ||
      log.parsed.args.amount !== order.wire.amountIn) throw new Error('EVM funding receipt does not match order');
    return { txid: hex(ref.txid, 32), index: ref.index, anchor: hex(block.hash, 32), value: order.wire.amountIn,
      blockTime: Number(BigInt(block.timestamp)) };
  }
  async function hasOpenFunding(order, funding) {
    await pin();
    const result = await rpc('eth_call', [{ to: c.rail, data: iface.encodeFunctionData('credits', [order.id]) }, 'latest']);
    const [amount, refund, state] = iface.decodeFunctionResult('credits', result);
    return order.from === chain && amount === BigInt(funding.value) && refund === order.refund.address && state === 1n;
  }
  function instruction(kind, order, funding) {
    if (kind === PAY && order.to === chain) return { recipient: order.recipient.address, amount: order.wire.amountOut };
    if (kind === REJECT && order.to === chain) return { recipient: ZeroAddress, amount: 0n };
    if (kind === REFUND && order.from === chain) return { recipient: order.refund.address, amount: BigInt(funding.value) };
    if (kind === COLLECT && order.from === chain) return { recipient: ZeroAddress, amount: BigInt(funding.value) };
    throw new Error('invalid EVM leg');
  }
  async function prepare(kind, order, funding) {
    if (!wallet || !treasurySecret || gasPriceCap === undefined) throw new Error('EVM rail has no configured settlement signer');
    await pin();
    const terms = instruction(kind, order, funding);
    const [next, confirmed, gas, balance] = await Promise.all([
      rpc('eth_getTransactionCount', [signer, 'pending']), rpc('eth_getTransactionCount', [signer, 'latest']),
      rpc('eth_gasPrice'), rpc('eth_getBalance', [signer, 'latest']),
    ]);
    if (BigInt(next) !== BigInt(confirmed)) return null; // Exclusive gas account, no speculative nonces.
    const nonce = Number(uint(BigInt(next), 'gas account nonce', BigInt(Number.MAX_SAFE_INTEGER)));
    const gasPrice = uint(BigInt(gas), 'gas price', MAX_U256, 1n);
    if (gasPrice > gasPriceCap || BigInt(balance) < gasPrice * gasLimit(kind)) return null;
    return { chain, kind, orderId: order.id, ...terms, nonce, gasPrice, resource: `${c.id}:${signer}:${nonce}` };
  }
  async function sign(plan, order, funding) {
    if (!wallet || !treasurySecret) throw new Error('EVM rail is read-only');
    await pin();
    const terms = instruction(plan.kind, order, funding);
    if (plan.chain !== chain || plan.orderId !== order.id || plan.recipient !== terms.recipient ||
      BigInt(plan.amount) !== terms.amount || plan.resource !== `${c.id}:${signer}:${plan.nonce}`) throw new Error('EVM plan mismatch');
    const permit = pqSign(treasurySecret, c.treasury, settlementMessage(c, plan.kind, order.id, terms.recipient, terms.amount, signer));
    const data = plan.kind === PAY
      ? iface.encodeFunctionData('pay', [order.wire, terms.recipient, order.signature, permit])
      : iface.encodeFunctionData('settle', [plan.kind, order.id, terms.recipient, terms.amount, permit]);
    const raw = await wallet.signTransaction({ type: 0, chainId: c.chainId, to: c.rail, nonce: plan.nonce,
      gasLimit: gasLimit(plan.kind), gasPrice: uint(plan.gasPrice, 'gas price', gasPriceCap, 1n), value: 0n, data });
    return { raw, txid: Transaction.from(raw).hash };
  }
  async function broadcast(payload) {
    await pin();
    const tx = Transaction.from(payload.raw);
    if (tx.hash !== payload.txid || tx.chainId !== c.chainId || tx.to !== c.rail || (signer && tx.from !== signer)) {
      throw new Error('wrong signed EVM transaction');
    }
    const seen = await rpc('eth_sendRawTransaction', [payload.raw]);
    if (seen !== tx.hash) throw new Error('EVM RPC returned different transaction ID');
  }
  async function observeLeg(plan, payload) {
    const read = await finalReceipt(payload.txid);
    if (read.status !== 'final') return read;
    if (read.receipt.status !== '0x1') return { status: 'failed_tx' };
    const log = readLogs(read.receipt, 'Resolved').find(({ parsed: { args } }) => args.orderId === plan.orderId &&
      args.action === BigInt(plan.kind) && args.recipient === plan.recipient && args.amount === BigInt(plan.amount));
    if (!log) throw new Error('EVM receipt is missing the exact resolved event');
    return { status: 'final', delivered: log.parsed.args.delivered, anchor: hex(read.block.hash, 32) };
  }
  async function failedPayout(order) {
    if (order.to !== chain) throw new Error('wrong payout rail');
    await pin();
    const block = await rpc('eth_getBlockByNumber', ['finalized', false]);
    if (!block?.hash) throw new Error('finalized block required');
    const value = await rpc('eth_call', [{to: c.rail, data: iface.encodeFunctionData('payoutState', [order.id]) },
      { blockHash: block.hash, requireCanonical: true }]);
    return iface.decodeFunctionResult('payoutState', value)[0] === 2n;
  }
  return Object.freeze({ chain, observeFunding, hasOpenFunding, prepare, sign, broadcast, observeLeg, failedPayout });
}
