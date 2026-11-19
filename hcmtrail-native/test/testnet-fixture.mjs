import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeAddress, toBeHex } from 'ethers';
import { localEvm } from './local-evm.mjs';
import { TESTNETS } from '../testnet/networks.mjs';
import { EvmChain } from '../testnet/rpc.mjs';
import { artifacts, deploy, Transactions } from '../testnet/deployment.mjs';
import { Store } from '../testnet/store.mjs';
import { TestnetWallet } from '../testnet/wallet.mjs';

export const DEMO_KEY = toBeHex(1, 32); // Public fixture key, never connected to any public endpoint.
export const DEMO_SENDER = computeAddress(DEMO_KEY);
export const DEMO_RECIPIENT = computeAddress(toBeHex(2, 32));

export async function evmFixture(asset, { chainId = TESTNETS[asset].chainId } = {}) {
  const net = TESTNETS[asset];
  const vm = await localEvm(chainId);
  const status = { bigBlocks: true };
  const rpc = (method, params = []) => {
    if (method === 'eth_usingBigBlocks') return status.bigBlocks;
    return vm.provider.send(method === 'eth_bigBlockGasPrice' ? 'eth_gasPrice' : method, params);
  };
  const chain = new EvmChain(net, rpc, { key: DEMO_KEY, confirmations: 1n, gasPriceCap: 100_000_000_000n });
  const signerChain = (key) => new EvmChain(net, rpc, { key, confirmations: 1n, gasPriceCap: 100_000_000_000n });
  const setTime = async (time) => {
    await rpc('evm_setNextBlockTimestamp', [Number(time)]);
    await rpc('evm_mine');
  };
  return { chain, vm, status, signerChain, setTime, close: () => vm.close() };
}

export async function walletFixture(asset, report = () => {}, { dao = false } = {}) {
  const transport = asset === 'TRX' ? await (await import('./testnet-nile-fixture.mjs')).nileFixture() : await evmFixture(asset);
  const root = mkdtempSync(join(tmpdir(), `hcmtrail-testnet-${asset}-`));
  const close = () => { transport.close(); rmSync(root, { recursive: true, force: true }); };
  try {
    const { chain } = transport;
    const store = new Store(root);
    const a = artifacts(chain.network, { dao });
    const txs = new Transactions(chain, store, { seconds: 0, pollMs: 1, report });
    const manifest = await deploy(chain, store, txs, a, dao ? chain.sender : undefined);
    const wallet = new TestnetWallet(chain, store, txs, manifest, a.vaults[asset].abi);
    return { ...transport, store, wallet, manifest, txs, a, close };
  } catch (e) { close(); throw e; }
}
