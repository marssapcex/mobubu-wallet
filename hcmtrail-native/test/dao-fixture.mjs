import { Interface, toBeHex } from 'ethers';
import { mkdirSync } from 'node:fs';
import { compileSolidity } from '../scripts/compile.mjs';
import { callSpec, createSpec, Transactions, view } from '../testnet/deployment.mjs';
import { DAO_PERIOD } from '../testnet/dao-policy.mjs';
import { RelayOperator } from '../testnet/relay.mjs';
import { StakeWallet } from '../testnet/staking.mjs';
import { Store } from '../testnet/store.mjs';
import { DEMO_RECIPIENT, walletFixture } from './testnet-fixture.mjs';

const relayKey = toBeHex(2, 32);
const fixturePath = 'test/fixtures/DaoRecipients.sol';

export async function daoFixture(asset, report) {
  const f = await walletFixture(asset, report, { dao: true });
  try {
    const { a, chain, manifest: m, txs } = f;
    const relayChain = f.signerChain(relayKey);
    const dir = f.store.path('relay');
    mkdirSync(dir, { mode: 0o700 });
    const relayTxs = new Transactions(relayChain, new Store(dir), { seconds: 0, report });
    const token = new Interface(a.token.abi), treasury = new Interface(a.treasury.abi);
    const tokenSpec = (method, args) => callSpec(token, m.dao.token, method, args);
    const treasurySpec = (method, args) => callSpec(treasury, m.dao.treasury, method, args);
    const tokenView = (method, args) => view(chain, token, m.dao.token, method, args);
    const treasuryView = (method, args) => view(chain, treasury, m.dao.treasury, method, args);
    const time = (period) => treasuryView('startedAt').then((start) => f.setTime(start + (BigInt(period) - 1n) * DAO_PERIOD));
    const send = async (name, spec, relay = false) => (relay ? relayTxs : txs).submit(name, spec);
    const transfer = (amount, to = DEMO_RECIPIENT, name = 'transfer') => send(name, tokenSpec('transfer', [to, amount]));
    const stakeWallet = new StakeWallet(chain, f.store, txs, m, a.treasury.abi);
    const relayStakeWallet = new StakeWallet(relayChain, relayTxs.store, relayTxs, m, a.treasury.abi);
    const stake = async (amount, relay = false, name = 'stake', root) => {
      const worker = relay ? relayStakeWallet : stakeWallet;
      root ??= (await worker.newKey(worker.chain.sender)).authRoot;
      await send(`${name}-approve`, tokenSpec('approve', [m.dao.treasury, amount]), relay);
      return send(name, treasurySpec('stake', [amount, root]), relay);
    };
    const operator = (fee, maxCost) => new RelayOperator(relayChain, relayTxs, m, a.vaults[asset].abi, { fee, maxCost });
    const switchReceiver = async () => {
      const { artifact } = compileSolidity([fixturePath], { tvm: !!chain.network.tvm });
      const receiver = artifact(fixturePath, 'PayoutSwitch');
      const r = await send('deploy-switch', createSpec(receiver, 'PayoutSwitch'));
      const iface = new Interface(receiver.abi);
      return { at: r.contractAddress, spec: (method, args) => callSpec(iface, r.contractAddress, method, args) };
    };
    return { ...f, relayChain, relayTxs, tokenSpec, treasurySpec, tokenView, treasuryView, time, send, transfer, stake, operator, switchReceiver, stakeWallet, relayStakeWallet };
  } catch (e) { f.close(); throw e; }
}
