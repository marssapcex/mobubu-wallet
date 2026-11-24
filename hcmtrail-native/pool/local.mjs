import { randomBytes } from 'node:crypto';
import { Contract, ZeroAddress, getCreateAddress, hexlify } from 'ethers';
import { compileVaults } from '../scripts/build-vault.mjs';
import { LOCAL_ID, localEvm } from '../test/local-evm.mjs';
import { ETH_LABS, TX_GAS_CAP } from '../testnet/networks.mjs';

const compiled = new Map();
function getArtifacts(fixtures, harness) {
  if (harness && !fixtures) throw new Error('Harness must be explicitly enabled in a test.');
  if (!compiled.has(fixtures)) compiled.set(fixtures, compileVaults({ fixtures, labToken: true }));
  return compiled.get(fixtures);
}

export async function deployNoteStack(deploy, artifacts) {
  const prep = await deploy(artifacts.prepare);
  const walk = await deploy(artifacts.walk, prep.target);
  const chunks = [];
  for (const code of artifacts.chunks) chunks.push((await deploy(artifacts.chunk, code)).target);
  const evaluator = await deploy(artifacts.evaluator, chunks);
  const hasher = await deploy(artifacts.poseidon);
  return [hasher.target, prep.target, walk.target, evaluator.target];
}

async function prepareVm(network, artifacts, vmOptions, { verify = true, transport = true } = {}) {
  const vm = await localEvm(BigInt(network.labId), vmOptions);
  try {
    const deploy = (artifact, ...args) => vm.deploy(artifact, ...args, { gasLimit: TX_GAS_CAP });
    const token = await deploy(artifacts.labToken);
    const onL1 = network.slug === 'ethereum';
    const base = transport && network.slug !== 'arbitrum' ? await deploy(artifacts.labMessenger, ZeroAddress) : null;
    const outbox = transport && onL1 ? await deploy(artifacts.labOutbox) : null;
    const bridge = outbox ? await deploy(artifacts.labBridge, outbox.target) : null;
    const arb = transport && network.slug !== 'base' ? await deploy(artifacts.labMessenger, bridge?.target ?? ZeroAddress) : null;
    const stack = verify ? await deployNoteStack(deploy, artifacts) : [];
    const from = await vm.signer.getAddress();
    const predicted = getCreateAddress({ from, nonce: await vm.provider.getTransactionCount(from, 'pending') });
    const messages = [base?.target ?? ZeroAddress, onL1 ? arb?.target ?? ZeroAddress : ZeroAddress,
      bridge?.target ?? ZeroAddress, network.slug === 'arbitrum' ? arb?.target ?? ZeroAddress : ZeroAddress];
    return { ...vm, network, artifacts, deploy, base, arb, outbox, bridge, token, stack, predicted, messages };
  } catch (e) { vm.close(); throw e; }
}

async function finish(vm, realm, peers, { harness = false, standalone = false } = {}) {
  const { deploy, artifacts, token, network, stack, messages } = vm;
  const networkArgs = [realm, peers, messages];
  const pool = harness ? standalone ? await deploy(artifacts.poolHarness, token.target)
    : await deploy(artifacts.networkHarness, token.target, networkArgs)
    : await deploy(artifacts.pool, BigInt(network.labId), token.target, ...stack, networkArgs);
  if (pool.target !== vm.predicted) throw new Error('Pool address differs from the planned network manifest.');
  const staking = new Contract(await pool.feeStaking(), artifacts.staking.abi, vm.signer);
  const created = await pool.deploymentTransaction().wait();
  return { ...vm, pool, staking, fromBlock: created.blockNumber };
}

/// Same verified code in all three VMs. The peers are fixed at construction.
export async function deployEthNetwork({ fixtures = false, harness = false, vmOptions = () => undefined } = {}) {
  const artifacts = getArtifacts(fixtures, harness);
  const vms = [];
  try {
    for (const network of ETH_LABS) vms.push(await prepareVm(network, artifacts, vmOptions(network), { verify: !harness }));
    const realm = hexlify(randomBytes(32));
    const peers = vms.map((v) => v.predicted);
    const instances = new Map();
    for (const vm of vms) instances.set(vm.network.slug, await finish(vm, realm, peers, { harness }));
    return instances;
  } catch (e) { for (const vm of vms) vm.close(); throw e; }
}

/// Fast single-VM tests. The verified constructor still pins a manifest; its
/// other peers do not exist, so use deployEthNetwork for any cross-chain test.
export async function deployEthPool({ chainId = LOCAL_ID, fixtures = false, harness = false, vmOptions } = {}) {
  const network = ETH_LABS.find((n) => BigInt(n.labId) === chainId);
  if (!network) throw new Error('Use one of the three local lab chain IDs.');
  const vm = await prepareVm(network, getArtifacts(fixtures, harness), vmOptions, { verify: !harness, transport: !harness });
  try {
    const peers = Array(3).fill(vm.predicted);
    return await finish(vm, hexlify(randomBytes(32)), peers, { harness, standalone: true });
  } catch (e) { vm.close(); throw e; }
}
