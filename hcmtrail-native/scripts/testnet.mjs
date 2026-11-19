import { artifacts, deploy, Transactions, verifyDeployment } from '../testnet/deployment.mjs';
import { TESTNETS } from '../testnet/networks.mjs';
import { checkProver } from '../testnet/prover.mjs';
import { EvmChain, httpRpc, NileChain } from '../testnet/rpc.mjs';
import { json, loadSignerKey, need, OperatorError, outsideSource, Store } from '../testnet/store.mjs';
import { TestnetWallet } from '../testnet/wallet.mjs';

const help = `Chỉ dùng coin TESTNET trên máy riêng (Linux x86-64, Node 22+).
Usage: npm run --silent testnet -- <ETH|BNB|TRX|HYPE> <command> [args]
  deploy                         Deploy/verify the six-transaction STARK stack
  inspect                        Check manifest, domain, code and confirmed deployment
  note-new AMOUNT_BASE            Save a fresh private opening before any deposit
  deposit NOTE                    Fund the saved note and verify its receipt
  recover NOTE [TX_ID]            Rebuild a note's funded index from a confirmed receipt
  prove NOTE PAYOUT_BASE TO       Prove locally; save private change before exporting proof
  preflight EXIT_ID               Check proof on the target node and report resource budget
  withdraw EXIT_ID                Sign, broadcast and verify a native payout
  recover-exit EXIT_ID [TX_ID]     Verify a confirmed payout without sending anything

Read docs/TESTNET.md before funding. Base amounts are wei (ETH, BNB, HYPE) or sun (TRX).
Required: NATIVE_RPC_URL, NATIVE_STATE_DIR (outside this checkout).
Signer commands use NATIVE_SIGNER_FILE (mode 600), never a key passed as a CLI argument.
`;
const arity = new Map(Object.entries({ deploy: [0], inspect: [0], 'note-new': [1], deposit: [1], recover: [1, 2],
  prove: [3], preflight: [1], withdraw: [1], 'recover-exit': [1, 2] }));
const signing = new Set(['deploy', 'deposit', 'preflight', 'withdraw']);

function seconds(env, lo, hi, fallback) {
  const v = process.env[env] ?? String(fallback);
  need(/^\d{1,5}$/.test(v) && Number(v) >= lo && Number(v) <= hi, `Set ${env} in ${lo}..${hi}.`);
  return Number(v);
}

async function main(args) {
  if (!args.length || args[0] === '--help' || args[0] === '-h') { console.log(help); return; }
  const [asset, command, ...params] = args;
  need(Object.hasOwn(TESTNETS, asset) && arity.get(command)?.includes(params.length),
    'Unknown testnet or arguments. Run npm run --silent testnet -- --help.');
  const net = TESTNETS[asset];
  const env = process.env;
  need(env.NATIVE_STATE_DIR && env.NATIVE_RPC_URL, 'Set NATIVE_STATE_DIR and NATIVE_RPC_URL.');
  process.umask(0o077);
  const state = outsideSource(env.NATIVE_STATE_DIR);
  const key = signing.has(command) ? loadSignerKey(env.NATIVE_SIGNER_FILE) : undefined;
  const { rpc, native } = httpRpc(env.NATIVE_RPC_URL, { tron: net.tvm, apiKey: env.TRON_PRO_API_KEY,
    timeoutMs: seconds('NATIVE_RPC_TIMEOUT_SECONDS', 5, 180, 60) * 1_000 });
  const chain = net.tvm ? new NileChain(net, rpc, native, { key, feeLimit: env.NATIVE_TRON_FEE_LIMIT_SUN })
    : new EvmChain(net, rpc, { key, confirmations: env.NATIVE_CONFIRMATIONS ?? (asset === 'ETH' ? '8' : '12'),
      finalized: env.NATIVE_EVM_FINALIZED_TAG === '1', gasPriceCap: env.NATIVE_GAS_PRICE_CAP_WEI, gasCap: env.NATIVE_EVM_GAS_CAP });
  await chain.checkChain(); // Reject foreign RPC before touching any local state or building a transaction.
  const store = new Store(state);
  const result = await store.locked(async () => {
    const a = artifacts(net);
    const txs = new Transactions(chain, store, { seconds: seconds('NATIVE_WAIT_SECONDS', 1, 7_200, 1_200), report: (event) => process.stderr.write(json(event)) });
    if (command === 'deploy') return deploy(chain, store, txs, a);
    const manifest = await verifyDeployment(chain, store.read('manifest.json'), a);
    const wallet = new TestnetWallet(chain, store, txs, manifest, a.vaults[asset].abi);
    switch (command) {
      case 'inspect': return { manifest, confirmation: chain.confirmationPolicy, confirmedHead: await chain.head(),
        leafCount: await wallet.ledger.read('leafCount'), accountedNative: await wallet.ledger.read('accountedNative'),
        balance: await chain.balance(manifest.vault) };
      case 'note-new': return wallet.newNote(params[0]);
      case 'deposit': checkProver(env.NATIVE_STARK_PROVER_DIR); return wallet.deposit(params[0]);
      case 'recover': return wallet.recoverNote(...params);
      case 'prove': return wallet.prove(...params, checkProver(env.NATIVE_STARK_PROVER_DIR));
      case 'preflight': return wallet.preflight(params[0]);
      case 'withdraw': return wallet.withdraw(params[0]);
      case 'recover-exit': return wallet.recoverExit(...params);
      default: throw new OperatorError('Unknown testnet command.');
    }
  });
  process.stdout.write(json(result));
}

try {
  await main(process.argv.slice(2));
} catch (e) {
  // RPC libraries/JSON decoders may include URL credentials, a signer key or note material in errors.
  // Only display errors constructed by this tool; never dump an exception or request body.
  const message = e instanceof OperatorError ? e.message :
    'Local validation or setup failed. Check file modes, pinned compilers, address/amount format, and RPC configuration (see docs/TESTNET.md).';
  process.stderr.write(`Testnet: ${message}\n`);
  process.exitCode = 1;
}
