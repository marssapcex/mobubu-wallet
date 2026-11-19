import { getAddress, getBytes, isHexString, keccak256, toQuantity, Transaction, Wallet, ZeroAddress } from 'ethers';
import { TronWeb, utils as tronUtils } from 'tronweb';
import { TRON_FEE_CAP, TX_GAS_CAP } from './networks.mjs';
import { uint, word256 } from './notes.mjs';
import { need, OperatorError } from './store.mjs';

const ZERO = ZeroAddress;
const q = toQuantity;
const same = (a, b) => a?.toLowerCase() === b?.toLowerCase();
const hex = (text) => {
  need(typeof text === 'string' && /^(0x)?(?:[0-9a-f]{2})*$/i.test(text), 'Invalid hex received from RPC.');
  return `0x${text.replace(/^0x/i, '').toLowerCase()}`;
};
const quantity = (v) => {
  need((typeof v === 'string' && /^(0x[\da-f]+|\d+)$/i.test(v)) ||
    (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) || (typeof v === 'bigint' && v >= 0n),
  'Invalid integer received from RPC.');
  return BigInt(v);
};

export function address(network, text) {
  if (typeof text === 'string') {
    try {
      if (/^0x[0-9a-f]{40}$/i.test(text)) return getAddress(text);
      if (network.tvm && TronWeb.isAddress(text)) {
        const raw = TronWeb.address.toHex(text);
        if (/^41[0-9a-f]{40}$/i.test(raw)) return getAddress(`0x${raw.slice(2).toLowerCase()}`);
      }
    } catch { /* reject all invalid address encodings */ }
  }
  throw new OperatorError('Invalid address for this testnet.');
}
const tvmHex = (evm) => `41${evm.slice(2).toLowerCase()}`;
const tvmAddress = (v) => address({ tvm: true }, /^[0-9a-f]{40}$/i.test(v) ? `0x${v.toLowerCase()}` : v);
export const txId = (value) => word256(typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value) ? `0x${value}` : value);

export class RpcError extends OperatorError {
  constructor(method, code, data) {
    super(`${method} refused the request${Number.isSafeInteger(code) ? ` (code ${code})` : ''}.`);
    this.rpcCode = code;
    this.revert = isHexString(data) ? data.slice(0, 10) : undefined;
  }
}

export function httpRpc(base, { tron = false, apiKey = '', timeoutMs = 60_000 } = {}) {
  let url;
  try { url = new URL(base); } catch { throw new OperatorError('Set NATIVE_RPC_URL to a valid HTTPS testnet endpoint.'); }
  need(url.protocol === 'https:' && !url.username && !url.password && !url.hash,
    'Use HTTPS without URL user/password credentials.');
  need(!tron || (!url.search && !url.pathname.replace(/\/+$/, '').endsWith('/jsonrpc')), 'Nile needs a base URL serving /jsonrpc and /wallet* on the same node.');
  const endpoint = tron ? url.href.replace(/\/+$/, '') : url.href;
  const headers = { 'content-type': 'application/json', ...(tron && apiKey ? { 'TRON-PRO-API-KEY': apiKey } : {}) };
  async function post(at, body, method) {
    try {
      const response = await fetch(at, { method: 'POST', headers, body: JSON.stringify(body),
        redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) throw new RpcError(method, response.status);
      return await response.json();
    } catch (e) { if (e instanceof RpcError) throw e; throw new RpcError(method); }
  }
  let id = 0;
  return {
    async rpc(method, params = []) {
      const request = { jsonrpc: '2.0', id: ++id, method, params };
      const response = await post(tron ? `${endpoint}/jsonrpc` : endpoint, request, method);
      if (response?.id !== request.id || response.error || !Object.hasOwn(response, 'result')) {
        throw new RpcError(method, response?.error?.code, response?.error?.data?.data ?? response?.error?.data);
      }
      return response.result;
    },
    native: tron ? (path, body) => post(`${endpoint}/${path}`, body, path) : undefined,
  };
}

function rpcBlock(b) {
  need(b?.hash && b.number != null && b.timestamp != null, 'RPC did not return the expected block.');
  return { number: quantity(b.number), hash: word256(b.hash), timestamp: quantity(b.timestamp),
    gasLimit: b.gasLimit == null ? undefined : quantity(b.gasLimit) };
}

function evmLog(l) {
  need(l.removed !== true && Array.isArray(l.topics), 'RPC returned a removed or malformed log.');
  return { address: getAddress(l.address), topics: l.topics.map(word256), data: hex(l.data), blockNumber: quantity(l.blockNumber),
    blockHash: word256(l.blockHash), hash: txId(l.transactionHash), index: quantity(l.logIndex) };
}

export class EvmChain {
  constructor(network, rpc, { key, confirmations = 8n, finalized = false, gasPriceCap, gasCap = TX_GAS_CAP } = {}) {
    this.network = network;
    this.rpc = rpc;
    this.wallet = key ? new Wallet(key) : null;
    this.sender = this.wallet?.address;
    this.confirmations = uint(confirmations, 256n, 'confirmations');
    need(this.confirmations > 0n, 'Confirmations must be positive.');
    this.finalized = finalized;
    this.gasCap = uint(gasCap, TX_GAS_CAP, 'transaction gas cap');
    this.gasPriceCap = gasPriceCap == null ? null : uint(gasPriceCap, 10n ** 18n, 'gas-price cap');
    this.logPage = network.bigBlocks ? 50n : 1_000n;
    this.historical = !network.bigBlocks;
  }

  get confirmationPolicy() { return this.finalized ? 'finalized tag' : `${this.confirmations} confirmations (depth)`; }

  async checkChain() {
    need(quantity(await this.rpc('eth_chainId')) === this.network.chainId, `RPC chain ID mismatch; expected ${this.network.chainId}. No transaction signed or sent.`);
  }

  async block(at = 'latest') { return rpcBlock(await this.rpc('eth_getBlockByNumber', [typeof at === 'bigint' ? q(at) : at, false])); }
  async head() {
    if (this.finalized) return this.block('finalized');
    const latest = await this.block();
    const number = latest.number + 1n - this.confirmations;
    need(number >= 0n, 'Not enough blocks for the confirmation policy.');
    return number === latest.number ? latest : this.block(number);
  }

  code(at) { return this.rpc('eth_getCode', [at, 'latest']).then(hex); }
  balance(at) { return this.rpc('eth_getBalance', [at, 'latest']).then(quantity); }
  call({ to, data }, at = 'latest') {
    return this.rpc('eth_call', [{ to, data }, typeof at === 'bigint' ? q(at) : at]).then(hex);
  }

  async logs(at, topics, from, to) {
    const rows = await this.rpc('eth_getLogs', [{ address: at, topics, fromBlock: q(from), toBlock: q(to) }]);
    need(Array.isArray(rows), 'Invalid log response.');
    return rows.map(evmLog);
  }

  async receipt(hash) {
    const r = await this.rpc('eth_getTransactionReceipt', [hash]);
    if (!r) return null;
    const status = quantity(r.status);
    const blockNumber = quantity(r.blockNumber);
    const head = await this.head();
    if (blockNumber > head.number) return null;
    const b = head.number === blockNumber ? head : await this.block(blockNumber);
    need(same(r.blockHash, b.hash) && same(r.transactionHash, hash) && status <= 1n, 'Receipt does not match the canonical confirmed block or transaction.');
    const gasUsed = quantity(r.gasUsed);
    return { hash, blockNumber, blockHash: b.hash, ok: status === 1n, confirmation: this.confirmationPolicy,
      from: getAddress(r.from), to: r.to == null ? null : getAddress(r.to),
      contractAddress: r.contractAddress ? getAddress(r.contractAddress) : null, logs: r.logs.map(evmLog),
      gasUsed, effectiveGasPrice: r.effectiveGasPrice == null ? undefined : quantity(r.effectiveGasPrice) };
  }

  async simulate(spec) {
    need(this.sender && this.gasPriceCap > 0n && this.gasCap > 0n, 'Set an EVM signer and positive NATIVE_GAS_PRICE_CAP_WEI.');
    await this.checkChain();
    if (this.network.bigBlocks) {
      need(await this.rpc('eth_usingBigBlocks', [this.sender]) === true,
        'Enable HyperCore usingBigBlocks for this signer; do not send a vault transaction to the small-block lane.');
    }
    const gasPrice = quantity(await this.rpc(this.network.bigBlocks ? 'eth_bigBlockGasPrice' : 'eth_gasPrice'));
    need(gasPrice > 0n && gasPrice <= this.gasPriceCap, 'RPC gas price is zero or above NATIVE_GAS_PRICE_CAP_WEI.');
    const value = spec.value ?? 0n;
    const gasEstimate = quantity(await this.rpc('eth_estimateGas', [{ from: this.sender, ...(spec.to ? { to: spec.to } : {}),
      data: spec.data, value: q(value), gasPrice: q(gasPrice), gas: q(this.gasCap) }]));
    need(gasEstimate > 0n && gasEstimate <= this.gasCap, 'Gas estimate exceeds the supported transaction cap.');
    const padded = gasEstimate + (gasEstimate + 9n) / 10n;
    const gasLimit = padded > this.gasCap ? this.gasCap : padded;
    need(await this.balance(this.sender) >= value + gasPrice * gasLimit, 'Testnet signer balance does not cover value and the maximum gas charge.');
    return { gasEstimate, gasLimit, gasPrice };
  }

  async prepare(spec) {
    const budget = await this.simulate(spec);
    // HyperEVM does not expose pending state on the reference RPC. Use a dedicated single-process signer.
    const nonce = quantity(await this.rpc('eth_getTransactionCount', [this.sender, this.network.bigBlocks ? 'latest' : 'pending']));
    await this.checkChain();
    const raw = await this.wallet.signTransaction({ type: 0, chainId: this.network.chainId, nonce,
      to: spec.to ?? null, data: spec.data, value: spec.value ?? 0n, gasLimit: budget.gasLimit, gasPrice: budget.gasPrice });
    return { hash: keccak256(raw), raw, sender: this.sender, bytes: getBytes(raw).length, budget };
  }

  async broadcast(envelope) {
    await this.checkChain();
    const tx = Transaction.from(envelope.raw);
    need(tx.hash === envelope.hash && tx.chainId === this.network.chainId && tx.from === envelope.sender, 'Signed EVM transaction journal mismatch.');
    if (this.network.bigBlocks) need(await this.rpc('eth_usingBigBlocks', [tx.from]) === true, 'HyperCore large-block flag is not enabled.');
    const hash = await this.rpc('eth_sendRawTransaction', [envelope.raw]);
    need(same(hash, envelope.hash), 'RPC broadcast did not return the locally computed transaction hash.');
  }
}

export class NileChain extends EvmChain {
  constructor(network, rpc, native, { key, feeLimit } = {}) {
    super(network, rpc);
    this.native = native;
    this.key = key?.slice(2);
    if (key) this.sender = tvmAddress(TronWeb.address.fromPrivateKey(this.key));
    this.tron = new TronWeb({ fullHost: 'https://nile.trongrid.io', disablePlugins: true }); // Transaction building/signing only; RPC uses the supplied transport.
    this.feeLimit = feeLimit == null ? null : uint(feeLimit, TRON_FEE_CAP, 'Nile feeLimit in sun');
    this.historical = false;
    this.logPage = 500n;
  }

  get confirmationPolicy() { return 'Nile walletsolidity (solidified)'; }

  async nativeBlock(solid) {
    const result = await this.native(`wallet${solid ? 'solidity' : ''}/getnowblock`, {});
    const raw = result?.block_header?.raw_data;
    need(raw && result.blockID, 'Nile did not return a native block header.');
    const number = quantity(raw.number);
    const timestamp = quantity(raw.timestamp);
    const hash = word256(hex(result.blockID));
    const b = await this.block(number);
    need(hash === b.hash && timestamp / 1_000n === b.timestamp, 'Nile native and JSON-RPC block headers disagree.');
    return { ...b, millis: timestamp };
  }

  head() { return this.nativeBlock(true); }

  async constant(spec, solid = true) {
    const value = spec.value ?? 0n;
    need(value <= BigInt(Number.MAX_SAFE_INTEGER), 'Nile client callValue exceeds safe JSON integer range.');
    const r = await this.native(`wallet${solid ? 'solidity' : ''}/triggerconstantcontract`, {
      owner_address: tvmHex(spec.from ?? this.sender ?? ZERO), call_value: Number(value), visible: false,
      ...(spec.to ? { contract_address: tvmHex(spec.to), function_selector: spec.signature, parameter: spec.data.slice(10) }
        : { data: spec.data.slice(2) }),
    });
    const ret = r?.transaction?.ret?.[0];
    if (r?.result?.result !== true || r.result.message || ret?.ret === 'FAILED' ||
      (ret?.contractRet && !['DEFAULT', 'SUCCESS'].includes(ret.contractRet)) || !Array.isArray(r.constant_result) || r.constant_result.length !== 1) {
      const rv = r?.constant_result?.[0];
      throw new RpcError('Nile constant simulation (check node CPU, Energy and request limits)', undefined,
        typeof rv === 'string' && /^[0-9a-f]{8}$/i.test(rv) ? `0x${rv}` : undefined);
    }
    return r;
  }

  async call(spec, at = 'solid') { return hex((await this.constant(spec, at !== 'latest')).constant_result[0]); }

  async receipt(hash) {
    const r = await this.native('walletsolidity/gettransactioninfobyid', { value: hash.slice(2) });
    need(r && typeof r === 'object' && !r.Error && !r.error, 'Nile solidity receipt request was refused.');
    if (!r.id && Object.keys(r).length === 0) return null;
    need(same(hex(r.id), hash) && r.receipt, 'Invalid or mismatched Nile receipt.');
    const blockNumber = quantity(r.blockNumber);
    const head = await this.head();
    need(blockNumber <= head.number, 'Receipt is not at a solidified height.');
    const b = head.number === blockNumber ? head : await this.block(blockNumber);
    // Require the solidified transaction as well: info.result alone may be absent on success.
    const tx = await this.native('walletsolidity/gettransactionbyid', { value: hash.slice(2) });
    const contracts = tx?.raw_data?.contract;
    need(same(hex(tx?.txID), hash) && contracts?.length === 1 && tx.ret?.length === 1, 'Nile transaction does not match its solidified receipt.');
    const { owner_address, contract_address } = contracts[0].parameter.value;
    return { hash, blockNumber, blockHash: b.hash, ok: r.result !== 'FAILED' && r.receipt.result === 'SUCCESS' && tx.ret[0].contractRet === 'SUCCESS',
      confirmation: this.confirmationPolicy, from: tvmAddress(owner_address), to: contract_address ? tvmAddress(contract_address) : null,
      contractAddress: r.contract_address ? tvmAddress(r.contract_address) : null,
      logs: (r.log ?? []).map((l, i) => ({ address: tvmAddress(l.address), topics: l.topics.map((t) => word256(hex(t))),
        data: hex(l.data ?? ''), blockNumber, blockHash: b.hash, hash, index: BigInt(i) })),
      energyUsed: quantity(r.receipt.energy_usage_total ?? 0), energyPenalty: quantity(r.receipt.energy_penalty_total ?? 0),
      netUsage: quantity(r.receipt.net_usage ?? 0), feeSun: quantity(r.fee ?? 0), contractResult: r.receipt.result };
  }

  async simulate(spec) {
    need(this.sender && this.feeLimit > 0n, 'Set a Nile signer and NATIVE_TRON_FEE_LIMIT_SUN (explicit per-transaction cap).');
    await this.checkChain();
    const value = spec.value ?? 0n;
    const [r, balance, params, resources] = await Promise.all([this.constant(spec, false), this.balance(this.sender),
      this.native('wallet/getchainparameters', {}), this.native('wallet/getaccountresource', { address: tvmHex(this.sender), visible: false })]);
    const energyEstimate = quantity(r.energy_used);
    const price = params?.chainParameter?.find(({ key }) => key === 'getEnergyFee')?.value;
    const sunPerEnergy = quantity(price);
    const remaining = quantity(resources?.EnergyLimit ?? 0) - quantity(resources?.EnergyUsed ?? 0);
    const deficit = energyEstimate - (remaining > 0n ? remaining : 0n);
    const estimatedBurnSun = deficit > 0n ? deficit * sunPerEnergy : 0n;
    need(energyEstimate > 0n && sunPerEnergy > 0n, 'Nile node did not report execution Energy or its price.');
    need(energyEstimate * sunPerEnergy <= this.feeLimit, 'Estimated Energy does not fit NATIVE_TRON_FEE_LIMIT_SUN, even with staked Energy.');
    need(balance >= value + estimatedBurnSun, 'Nile signer balance/resources do not cover call value and estimated Energy burn.');
    return { feeLimitSun: this.feeLimit, energyEstimate, sunPerEnergy, estimatedBurnSun };
  }

  async prepare(spec) {
    const budget = await this.simulate(spec);
    const head = await this.nativeBlock(false);
    const blockHeader = { ref_block_bytes: q(head.number).slice(2).slice(-4).padStart(4, '0'),
      ref_block_hash: head.hash.slice(18, 34), timestamp: Number(head.millis), expiration: Number(head.millis + 300_000n) };
    const issuer = tvmHex(this.sender);
    const opts = { feeLimit: Number(this.feeLimit), blockHeader };
    const tx = spec.to
      ? (await this.tron.transactionBuilder.triggerSmartContract(tvmHex(spec.to), spec.signature, { ...opts,
        txLocal: true, rawParameter: spec.data.slice(10), callValue: Number(spec.value ?? 0n) }, [], issuer)).transaction
      : await this.tron.transactionBuilder.createSmartContract({ ...opts, abi: [], bytecode: spec.data.slice(2),
        name: spec.name, userFeePercentage: 100, originEnergyLimit: 1 }, issuer);
    const raw = tx.raw_data;
    need(tronUtils.transaction.txCheck(tx) && raw.ref_block_bytes === blockHeader.ref_block_bytes &&
      raw.ref_block_hash === blockHeader.ref_block_hash && raw.fee_limit === opts.feeLimit && raw.contract.length === 1,
    'Local Nile transaction is not the intended TAPOS/fee envelope.');
    const payload = raw.contract[0].parameter.value;
    need(payload.owner_address === issuer && (spec.to
      ? payload.contract_address === tvmHex(spec.to) && same(hex(payload.data), spec.data) && quantity(payload.call_value ?? 0) === (spec.value ?? 0n)
      : same(hex(payload.new_contract.bytecode), spec.data) && quantity(payload.new_contract.call_value ?? 0) === 0n),
    'Local Nile transaction does not match the intended call or creation.');
    await this.checkChain();
    const signed = await this.tron.trx.sign(tx, this.key);
    const pb = tronUtils.transaction.txJsonToPb(signed);
    pb.addSignature(getBytes(hex(signed.signature[0])));
    const bytes = pb.serializeBinary().length;
    need(bytes < 500 * 1024, 'Nile signed transaction reached the network byte ceiling.');
    return { hash: word256(hex(signed.txID)), raw: signed, sender: this.sender, bytes, budget, expiresAtMs: raw.expiration };
  }

  async broadcast(envelope) {
    await this.checkChain();
    const raw = envelope.raw;
    need(txId(hex(raw.txID)) === envelope.hash && tronUtils.transaction.txCheck(raw) &&
      raw.raw_data.contract[0].parameter.value.owner_address === tvmHex(envelope.sender) && raw.signature?.length === 1,
    'Signed Nile transaction journal mismatch.');
    const r = await this.native('wallet/broadcasttransaction', raw);
    need((r?.result === true || r?.code === 'DUP_TRANSACTION_ERROR') && (!r.txid || same(hex(r.txid), envelope.hash)),
      `Nile broadcast refused${/^[A-Z_]{1,60}$/.test(r?.code) ? ` (${r.code})` : ''}; recover by transaction ID.`);
  }
}
