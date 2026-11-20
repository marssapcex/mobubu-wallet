import { artifacts, deploy, Transactions, verifyDeployment } from '../testnet/deployment.mjs';
import { daoArity, daoCommand } from '../testnet/dao-ops.mjs';
import { DAO_FEE_BPS } from '../testnet/dao-policy.mjs';
import { RelayOperator } from '../testnet/relay.mjs';
import { StakeWallet } from '../testnet/staking.mjs';
import { TESTNETS } from '../testnet/networks.mjs';
import { checkProver } from '../testnet/prover.mjs';
import { EvmChain, httpRpc, NileChain } from '../testnet/rpc.mjs';
import { json, loadSignerKey, need, OperatorError, outsideSource, privateText, Store } from '../testnet/store.mjs';
import { TestnetWallet } from '../testnet/wallet.mjs';

const help = `Chỉ dùng coin TESTNET trên máy riêng (Linux x86-64, Node 22+).
Usage: npm run --silent testnet -- <ETH|BNB|TRX|HYPE> <command> [args]
  deploy                            Deploy/verify the original no-fee STARK stack
  dao-deploy GENESIS_HOLDER          Deploy the fee & STARK staking profile; assign 250,000 local HCMT
  inspect                           Check manifest, domain, code and confirmed deployment
  note-new GROSS_BASE               Save a private opening for the net deposited amount
  deposit NOTE                      Fund the saved note and verify its receipt
  recover NOTE [TX_ID]               Recover a note's funded index from a confirmed receipt
  prove NOTE GROSS_BASE TO [QUOTE]   Prove locally; optional quote JSON names a paid broadcaster
  preflight EXIT_ID                  Check a self-submitted proof and report resource budget
  withdraw EXIT_ID                   Self-submit (no broadcaster fee)
  recover-exit EXIT_ID [TX_ID]        Verify a confirmed payout and recover its private change

Fee profile only (HCMT amounts have 18 decimals on all four chains):
  dao-status WHO [PERIOD]            Show stake, eligibility and claimable native reward
  hcmt-transfer OP_ID TO HCMT_BASE   Distribute local HCMT (not a cross-chain transfer)
  stake-key-new STAKER              Create a local credential; report public root and backup filename
  stake OP_ID HCMT_BASE AUTH_ROOT    Approve & lock HCMT; immutable root fixed on first stake
  unstake-proof STAKER HCMT_BASE TO   Authorize a next-period unlock to TO with a local STARK
  claim-proof STAKER TO PERIODS      Authorize native payout to TO; comma-separated closed periods
  stake-check PROOF_FILE            Review and simulate with your gas account; no tx signed
  stake-submit PROOF_FILE           Sponsor the exact proof-authorized action, no staker key needed
  release OP_ID STAKER              Anyone can finish a matured unlock to its fixed recipient
  close OP_ID COUNT                  Permissionlessly close 1–24 ended periods
  relay-export EXIT_ID               Export ONLY the public request JSON (wallet side)
  relay-quote FEE_BASE               Quote your dedicated eligible signer's fixed price
  relay-check FEE_BASE REQUEST      Validate/simulate a public request; no signing
  relay-submit FEE_BASE REQUEST     Sign and relay only that proof under this exact price

Read docs/TESTNET.md and docs/HCMT-TESTNET.md. Base amounts: wei (ETH, BNB, HYPE), sun (TRX).
NATIVE_RPC_URL and external NATIVE_STATE_DIR; signing: NATIVE_SIGNER_FILE (mode 600).
Broadcaster: separate NATIVE_RELAY_STATE_DIR + NATIVE_RELAY_SIGNER_FILE; import only manifest.json.
Use a fresh OP_ID for a new DAO operation; retry an uncertain transaction with the same arguments and ID.
`;
const stakeArity = Object.freeze({ 'stake-key-new': [1], 'unstake-proof': [3], 'claim-proof': [3], 'stake-check': [1], 'stake-submit': [1] });
const arity = new Map(Object.entries({ deploy: [0], 'dao-deploy': [1], inspect: [0], 'note-new': [1], deposit: [1], recover: [1, 2],
  prove: [3, 4], preflight: [1], withdraw: [1], 'recover-exit': [1, 2], 'relay-export': [1],
  'relay-quote': [1], 'relay-check': [2], 'relay-submit': [2], ...daoArity, ...stakeArity }));
const relayCommands = new Set(['relay-quote', 'relay-check', 'relay-submit']);
const signing = new Set(['deploy', 'dao-deploy', 'deposit', 'preflight', 'withdraw', 'stake-check', 'stake-submit', ...relayCommands,
  ...Object.keys(daoArity).filter((c) => c !== 'dao-status')]);

function exchangeFile(path, maxBytes) {
  try { return JSON.parse(privateText(outsideSource(path), maxBytes)); }
  catch (e) { if (e instanceof OperatorError) throw e; throw new OperatorError('Expected a readable owner-only quote/request/permit JSON outside the checkout.'); }
}

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
  const relay = relayCommands.has(command);
  const stateEnv = relay ? 'NATIVE_RELAY_STATE_DIR' : 'NATIVE_STATE_DIR';
  const signerEnv = relay ? 'NATIVE_RELAY_SIGNER_FILE' : 'NATIVE_SIGNER_FILE';
  need(env[stateEnv] && env.NATIVE_RPC_URL, `Set ${stateEnv} and NATIVE_RPC_URL.`);
  process.umask(0o077);
  const state = outsideSource(env[stateEnv]);
  if (relay && env.NATIVE_STATE_DIR) need(state !== outsideSource(env.NATIVE_STATE_DIR), 'Give the broadcaster a separate state directory.');
  if (signing.has(command)) need(env[signerEnv], `Set ${signerEnv} to a dedicated testnet key file (mode 600).`);
  const key = signing.has(command) ? loadSignerKey(env[signerEnv]) : undefined;
  const { rpc, native } = httpRpc(env.NATIVE_RPC_URL, { tron: net.tvm, apiKey: env.TRON_PRO_API_KEY,
    timeoutMs: seconds('NATIVE_RPC_TIMEOUT_SECONDS', 5, 180, 60) * 1_000 });
  const chain = net.tvm ? new NileChain(net, rpc, native, { key, feeLimit: env.NATIVE_TRON_FEE_LIMIT_SUN })
    : new EvmChain(net, rpc, { key, confirmations: env.NATIVE_CONFIRMATIONS ?? (asset === 'ETH' ? '8' : '12'),
      finalized: env.NATIVE_EVM_FINALIZED_TAG === '1', gasPriceCap: env.NATIVE_GAS_PRICE_CAP_WEI, gasCap: env.NATIVE_EVM_GAS_CAP });
  await chain.checkChain(); // Reject foreign RPC before touching any local state or building a transaction.
  const store = new Store(state);
  const result = await store.locked(async () => {
    const txs = new Transactions(chain, store, { seconds: seconds('NATIVE_WAIT_SECONDS', 1, 7_200, 1_200), report: (event) => process.stderr.write(json(event)) });
    if (command === 'deploy' || command === 'dao-deploy') return deploy(chain, store, txs, artifacts(net, { dao: command === 'dao-deploy' }), params[0]);
    const saved = store.read('manifest.json');
    const a = artifacts(net, { dao: !!saved.dao });
    const manifest = await verifyDeployment(chain, saved, a);
    if (relay) {
      const worker = new RelayOperator(chain, txs, manifest, a.vaults[asset].abi, { fee: params[0], maxCost: env.NATIVE_RELAY_COST_CAP_BASE });
      if (command === 'relay-quote') return worker.quote();
      const request = exchangeFile(params[1], 270_000);
      return command === 'relay-check' ? worker.preflight(request) : worker.submit(request);
    }
    if (Object.hasOwn(stakeArity, command)) {
      const staking = new StakeWallet(chain, store, txs, manifest, a.treasury?.abi);
      if (command === 'stake-key-new') return staking.newKey(params[0]);
      if (command === 'unstake-proof' || command === 'claim-proof') {
        const action = command === 'unstake-proof' ? { kind: 'unstake', amount: params[1], recipient: params[2] }
          : { kind: 'claim', recipient: params[1], periods: params[2] };
        return staking.prove(params[0], action, checkProver(env.NATIVE_STARK_PROVER_DIR));
      }
      const permit = exchangeFile(params[0], 270_000);
      return command === 'stake-check' ? staking.check(permit) : staking.submit(permit);
    }
    if (Object.hasOwn(daoArity, command)) return daoCommand(chain, txs, manifest, a, command, params);
    const wallet = new TestnetWallet(chain, store, txs, manifest, a.vaults[asset].abi);
    switch (command) {
      case 'inspect': return { manifest, confirmation: chain.confirmationPolicy, confirmedHead: await chain.head(),
        leafCount: await wallet.ledger.read('leafCount'), accountedNative: await wallet.ledger.read('accountedNative'),
        balance: await chain.balance(manifest.vault), ...(manifest.dao ? { daoFeeBps: DAO_FEE_BPS,
          daoBalance: await chain.balance(manifest.dao.treasury) } : {}) };
      case 'note-new': return wallet.newNote(params[0]);
      case 'deposit': checkProver(env.NATIVE_STARK_PROVER_DIR); return wallet.deposit(params[0]);
      case 'recover': return wallet.recoverNote(...params);
      case 'prove': return wallet.prove(params[0], params[1], params[2], checkProver(env.NATIVE_STARK_PROVER_DIR),
        params[3] === undefined ? undefined : exchangeFile(params[3], 4_096));
      case 'relay-export': return wallet.exportRelay(params[0]);
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
