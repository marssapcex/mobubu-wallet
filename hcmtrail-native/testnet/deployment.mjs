import { getBytes, Interface, keccak256, toBeHex, toUtf8Bytes } from 'ethers';
import { setTimeout as delay } from 'node:timers/promises';
import { compileVaults } from '../scripts/build-vault.mjs';
import { STARK_IMAGE, STARK_PARAMS } from './networks.mjs';
import { custodyCap, deploymentDomain, rebuildRoot } from './notes.mjs';
import { address } from './rpc.mjs';
import { need, OperatorError } from './store.mjs';

export const createSpec = (artifact, name, args = []) => ({
  name, data: artifact.bytecode + new Interface(artifact.abi).encodeDeploy(args).slice(2),
});
export const callSpec = (iface, to, method, args = [], value = 0n) => ({
  to, signature: iface.getFunction(method).format('sighash'), data: iface.encodeFunctionData(method, args), value,
});
export async function view(chain, abi, to, method, args = [], at) {
  const iface = abi instanceof Interface ? abi : new Interface(abi);
  const raw = await chain.call(callSpec(iface, to, method, args), at);
  return iface.decodeFunctionResult(method, raw)[0];
}

const compiled = new Map();
export function artifacts(network) {
  const target = Boolean(network.tvm);
  if (!compiled.has(target)) compiled.set(target, compileVaults({ tvm: target, testnet: true }));
  return compiled.get(target);
}

export function buildId(a, network) {
  const img = [a.prepare, a.walk, a.chunk, a.poseidon, a.evaluator, a.vaults[network.asset]];
  return keccak256(toUtf8Bytes(JSON.stringify([img.map((x) => [x.compiler, keccak256(x.bytecode), keccak256(x.runtimeTemplate)]), a.chunks.map(keccak256)])));
}

export function assertRuntime(code, artifact, label) {
  const actual = getBytes(code);
  need(actual.length > 0 && actual.length === getBytes(artifact.runtimeTemplate).length, `Unexpected ${label} runtime length.`);
  for (const positions of Object.values(artifact.immutableReferences)) {
    const first = positions[0];
    const word = toBeHex(BigInt(`0x${Buffer.from(actual.slice(first.start, first.start + first.length)).toString('hex')}`), first.length);
    for (const { start, length } of positions) {
      need(length === first.length && Buffer.from(actual.slice(start, start + length)).toString('hex') === word.slice(2),
        `Inconsistent ${label} immutable words.`);
      actual.fill(0, start, start + length);
    }
  }
  need(keccak256(actual) === keccak256(artifact.runtimeTemplate), `Unexpected ${label} runtime bytecode.`);
}

export function receiptSummary(receipt) {
  const { logs: _logs, ...summary } = receipt;
  return summary;
}

export class Transactions {
  constructor(chain, store, { seconds = 1_200, pollMs = 4_000, report = () => {} } = {}) {
    this.chain = chain;
    this.store = store;
    this.seconds = seconds;
    this.pollMs = pollMs;
    this.report = report;
  }

  name(label) { return `tx-${label}.json`; }
  existing(label) { const file = this.name(label); return this.store.has(file) ? this.store.read(file) : null; }

  async submit(label, spec) {
    const file = this.name(label);
    const intent = { chainId: String(this.chain.network.chainId), to: spec.to ?? null, value: String(spec.value ?? 0n), data: keccak256(spec.data) };
    let journal = this.existing(label);
    if (journal) {
      need(Object.keys(intent).every((k) => journal.intent?.[k] === intent[k]), 'Existing journal is for a different transaction.');
    } else {
      const envelope = await this.chain.prepare(spec);
      journal = { intent, envelope };
      // Must complete before the first network broadcast. Retrying never creates a second tx.
      this.store.write(file, journal);
    }
    const { envelope } = journal;
    const check = (r) => {
      if (!r) return null;
      need(r.from === envelope.sender && r.to === intent.to, 'Confirmed receipt does not match the signed sender or target.');
      this.store.write(file, { ...journal, receipt: receiptSummary(r) });
      need(r.ok, `Confirmed transaction ${envelope.hash} failed; use recovery before attempting anything new.`);
      return r;
    };
    let receipt = check(await this.chain.receipt(envelope.hash));
    if (receipt) return receipt;
    this.report({ step: label, tx: envelope.hash, signedBytes: envelope.bytes, budget: envelope.budget });
    let warning;
    try { await this.chain.broadcast(envelope); }
    catch (e) { warning = e instanceof OperatorError ? e.message : 'Broadcast result is unknown.'; }
    // Even an RPC error can mean accepted (e.g. timeout, already known). Report the hash, never replace a tx.
    if (warning) this.report({ tx: envelope.hash, warning });
    const end = Date.now() + this.seconds * 1_000;
    do {
      receipt = check(await this.chain.receipt(envelope.hash));
      if (receipt) return receipt;
      if (Date.now() >= end) break;
      await delay(this.pollMs);
    } while (Date.now() < end);
    throw new OperatorError(`No confirmed receipt for ${envelope.hash}. Journal retained. Recover or retry the same command; do not create a replacement blindly.`);
  }
}

function parseVaultEvents(iface, vault, receipt) {
  return receipt.logs.filter((l) => l.address === vault).map((l) => iface.parseLog(l)).filter(Boolean);
}

export async function deploy(chain, store, txs, a = artifacts(chain.network)) {
  if (store.has('manifest.json')) return verifyDeployment(chain, store.read('manifest.json'), a);
  await chain.checkChain();
  const net = chain.network;
  const deployed = async (label, artifact, args, runtime) => {
    const receipt = await txs.submit(`deploy-${label}`, createSpec(artifact, label, args));
    const at = receipt.contractAddress;
    need(at, 'Missing contract address on deployment receipt.');
    const code = await chain.code(at);
    if (runtime) need(code === runtime, 'Evaluator chunk runtime differs from the pin.');
    else assertRuntime(code, artifact, label);
    return [at, receipt];
  };
  const [prepare, p] = await deployed('PrepareNb_A', a.prepare, []);
  const [walk, w] = await deployed('WalkNb_A', a.walk, [prepare]);
  const chunks = [], chunkReceipts = [];
  for (const [i, code] of a.chunks.entries()) {
    const [at, receipt] = await deployed(`Chunk${i}`, a.chunk, [code], code);
    chunks.push(at); chunkReceipts.push(receipt);
  }
  const [vault, receipt] = await deployed(net.name, a.vaults[net.asset], [prepare, walk, chunks]);
  const iface = new Interface(a.vaults[net.asset].abi);
  const get = (method) => view(chain, iface, vault, method);
  const expected = deploymentDomain(net, vault);
  const manifest = {
    schema: 1, network: net.label, asset: net.asset, chainId: String(net.chainId), assetId: String(net.assetId),
    compiler: a.vaults[net.asset].compiler, build: buildId(a, net), vault, ...expected,
    starkImage: STARK_IMAGE, starkParams: STARK_PARAMS,
    stack: { prepare, walk, chunks, evaluator: await get('starkEvaluator'), poseidon: await get('poseidon') },
    created: { tx: receipt.hash, block: String(receipt.blockNumber), blockHash: receipt.blockHash },
    deployments: [p, w, ...chunkReceipts, receipt].map(receiptSummary),
  };
  await verifyDeployment(chain, manifest, a, receipt);
  store.write('manifest.json', manifest);
  return manifest;
}

export async function verifyDeployment(chain, manifest, a = artifacts(chain.network), receipt) {
  const net = chain.network;
  await chain.checkChain();
  need(manifest?.schema === 1 && manifest.asset === net.asset && manifest.chainId === String(net.chainId) &&
    manifest.assetId === String(net.assetId) && manifest.compiler === a.vaults[net.asset].compiler &&
    manifest.build === buildId(a, net) && manifest.starkParams === STARK_PARAMS && manifest.starkImage === STARK_IMAGE,
  'Manifest is not for this pinned testnet build.');
  const vault = address(net, manifest.vault);
  need(vault === manifest.vault && manifest.stack?.chunks?.length === 3, 'Malformed deployment manifest.');
  const { prepare, walk, evaluator, poseidon, chunks } = manifest.stack;
  for (const at of [prepare, walk, evaluator, poseidon, ...chunks]) need(address(net, at) === at, 'Noncanonical stack address.');
  const checks = [[vault, a.vaults[net.asset]], [prepare, a.prepare], [walk, a.walk], [evaluator, a.evaluator], [poseidon, a.poseidon]];
  // Check runtime before trusting getter results; every immutable has consistent duplicates.
  await Promise.all(checks.map(async ([at, artifact]) => assertRuntime(await chain.code(at), artifact, at)));
  for (const [i, at] of chunks.entries()) need(await chain.code(at) === a.chunks[i], 'Evaluator chunk code hash mismatch.');
  const { domain, domainLeaf } = deploymentDomain(net, vault);
  need(domain === manifest.domain && domainLeaf === manifest.domainLeaf, 'Manifest deployment domain mismatch.');
  const checksOnVault = { asset: net.assetId, homeChainId: net.chainId, unitsPerCoin: 10n ** BigInt(net.decimals),
    custodyCap: custodyCap(net), STARK_IMAGE, STARK_PARAMS, domain, domainLeaf, poseidon, starkWalk: walk, starkEvaluator: evaluator };
  const iface = new Interface(a.vaults[net.asset].abi);
  // Limit concurrent RPCs on public endpoints.
  const entries = Object.entries(checksOnVault);
  for (let i = 0; i < entries.length; i += 4) await Promise.all(entries.slice(i, i + 4).map(async ([method, expected]) => {
    need(await view(chain, iface, vault, method) === expected, `Wrong vault ${method}.`);
  }));
  need(await view(chain, a.walk.abi, walk, 'prep') === prepare, 'Wrong linked PrepareNb_A.');
  const links = await view(chain, a.evaluator.abi, evaluator, 'chunks');
  need(chunks.every((at, i) => links[i] === at) && links.length === 3, 'Wrong evaluator chunk order.');
  receipt ??= await chain.receipt(manifest.created.tx);
  need(receipt?.ok && receipt.contractAddress === vault && String(receipt.blockNumber) === manifest.created.block &&
    receipt.blockHash === manifest.created.blockHash, 'Deployment receipt missing, not confirmed, or changed.');
  const events = parseVaultEvents(iface, vault, receipt);
  const leaf = events.find((e) => e.name === 'LeafAppended');
  const root = events.find((e) => e.name === 'RootPublished');
  need(leaf?.args[0] === 0n && leaf.args[1] === domainLeaf && root?.args[0] === rebuildRoot([domainLeaf]) && root.args[1] === 1n,
    'Constructor domain leaf or initial tree root mismatch.');
  return manifest;
}
