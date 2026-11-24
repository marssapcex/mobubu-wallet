import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { ARBITRUM, ETH_LABS, TX_GAS_CAP } from '../hcmtrail-native/testnet/networks.mjs';
import { localClearing } from '../hcmtrail-native/pool/local-clearing.mjs';
import { ETH_POOL_LEGACY } from '../hcmtrail-native/pool/lab-profile.mjs';
import { ETH_POOL_RELEASE_POLICY, requireEthPoolRelease } from '../hcmtrail-native/pool/release-policy.mjs';

// Ephemeral EVMs only. Never connect a wallet/RPC or accept note openings.
const args = process.argv.slice(2);
if (!args.length || (args.length === 1 && args[0] === '--require-256')) requireEthPoolRelease();
if (args.length !== 1 || args[0] !== '--legacy-devnet') throw new Error('Usage: npm run pool:eth:legacy (legacy lab only, no release mode)');

const [{ Wallet, parseEther, keccak256 }, { deployEthNetwork }, { readPool }, { settleReady }, { json, MIN_DEPOSIT, payoutAddress }] = await Promise.all([
  import('ethers'), import('../hcmtrail-native/pool/local.mjs'), import('../hcmtrail-native/pool/view.mjs'),
  import('../hcmtrail-native/pool/keeper.mjs'), import('../hcmtrail-native/pool/protocol.mjs'),
]);
const base = new URL('../', import.meta.url);
const app = 'apps/eth-pool/';
const native = 'hcmtrail-native/';
const bin = `${native}build/eth-pool/`;
const port = Number(process.env.PORT ?? 4184);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid ETH pool port');
const wasm = await stat(new URL(`${bin}prover.wasm`, base)).then((s) => s.isFile()).catch(() => false);
const cache = process.env.POOL_PERIODIC_CACHE ? await readFile(process.env.POOL_PERIODIC_CACHE) : null;
if (cache && cache.length !== 8_388_660) throw new Error('Expected the public NotBefore periodic cache (8,388,660 bytes)');

const opts = { gasLimit: TX_GAS_CAP };
const sent = async (fn, ...a) => (await fn(...a, opts)).wait();
const labs = new Map();
const networkSet = await deployEthNetwork({ vmOptions: () => ({
  genesisBlockTime: BigInt(Math.floor(Date.now() / 1000)), balance: parseEther('1000000'),
  keys: Array.from({ length: 3 }, () => `0x${randomBytes(32).toString('hex')}`),
}) });
const arbVm = networkSet.get(ETH_LABS.find((n) => n.lane === ARBITRUM).slug);
const arbitrumPacketGas = Object.freeze({ gasLimit: 400_000n, maxFeePerGas: 100_000_000n, maxSubmissionCost: 1_234_567n,
  refundL2: await (await arbVm.provider.getSigner(2)).getAddress() });
for (const network of ETH_LABS) {
  const vm = networkSet.get(network.slug);
  // Only explicit lab capital backs remote payouts; deposits remain shielded.
  await (await vm.pool.fundLiquidity({ ...opts, value: parseEther('2') })).wait();
  const { pool, staking, token, provider, fromBlock } = vm;
  const lane = await pool.lane();
  if (lane !== network.lane) throw new Error('Wrong lab lane');
  const config = { chainId: network.labId, network: network.slug, lane, pool: pool.target,
    networkDomain: await pool.networkDomain(), arbitrumPacketGas,
    domain: await pool.domain(), domainLeaf: await pool.domainLeaf(), feeBps: await pool.FEE_BPS(),
    staking: staking.target, stakeToken: token.target, minDeposit: MIN_DEPOSIT, abi: vm.artifacts.pool.abi,
    wasm, cache: !!cache, proofProfile: ETH_POOL_LEGACY, releasePolicy: ETH_POOL_RELEASE_POLICY };
  let serial = Promise.resolve();
  const write = (fn) => {
    const next = serial.then(fn);
    serial = next.catch(() => {});
    return next;
  };
  const read = (snapshot = false) => readPool(pool, provider, fromBlock, { snapshot });
  labs.set(network.slug, { ...vm, lane, config, write, read, relay: await provider.getSigner(1), keeper: await provider.getSigner(2),
    deposits: new Map(), sessions: new Map(), pending: 0, keeping: false });
}
const clearing = localClearing(labs, arbitrumPacketGas);
const networkDomain = labs.get('ethereum').config.networkDomain;
async function liquidityBook() {
  const networks = await Promise.all([...labs.values()].map(async ({ config, pool }) => ({ network: config.network,
    lane: config.lane, chainId: config.chainId, pool: config.pool, staking: config.staking, free: await pool.liquidityNative() })));
  return { networkDomain, networks };
}

const routes = new Map([
  ['/', [`${app}index.html`, 'text/html; charset=utf-8']],
  ['/pool.css', [`${app}pool.css`, 'text/css; charset=utf-8']],
  ['/pool.mjs', [`${app}pool.mjs`, 'text/javascript; charset=utf-8']],
  ['/proof-worker.mjs', [`${app}proof-worker.mjs`, 'text/javascript; charset=utf-8']],
  ['/ethers.mjs', ['node_modules/ethers/dist/ethers.min.js', 'text/javascript; charset=utf-8']],
  ['/poseidon.sol', [`${native}contracts/vendor/nonos/PoseidonGoldilocks.sol`, 'text/plain; charset=utf-8']],
]);
for (const name of ['pool/protocol.mjs', 'pool/clearing.mjs', 'pool/wasm.mjs', 'testnet/notes-core.mjs', 'testnet/networks.mjs']) {
  routes.set(`/${native}${name}`, [`${native}${name}`, 'text/javascript; charset=utf-8']);
}
if (wasm) {
  routes.set('/prover.wasm', [`${bin}prover.wasm`, 'application/wasm']);
  routes.set('/prover-source.tar.gz', [`${bin}prover-source.tar.gz`, 'application/gzip']);
}
const mapHash = createHash('sha256').update('{"imports":{"ethers":"/ethers.mjs"}}').digest('base64');
const headers = {
  'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
  'content-security-policy': `default-src 'none'; script-src 'self' 'wasm-unsafe-eval' 'sha256-${mapHash}'; style-src 'self'; ` +
    "worker-src 'self'; connect-src 'self'; img-src 'self' data:; form-action 'none'; base-uri 'none'; object-src 'none'",
};
const response = (res, data, status = 200) => res.writeHead(status, { ...headers, 'content-type': 'application/json; charset=utf-8' }).end(json(data));

const actions = new Set(['deposit', 'depositBatch', 'withdraw', 'reserve', 'refundPart', 'executeBatch', 'withdrawAcross', 'cancelAcross']);
const integer = (v) => typeof v === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(v);
async function body(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('Request too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function submitPool(b, vm) {
  const { pool, config } = vm;
  if (Object.keys(b).sort().join(',') !== 'chainId,data,pool,value' || b.pool !== pool.target || b.chainId !== config.chainId ||
      typeof b.data !== 'string' || !/^0x(?:[0-9a-fA-F]{2})+$/.test(b.data) || !integer(b.value)) {
    throw new Error('Chỉ nhận calldata công khai của pool này và giá trị wei.');
  }
  const value = BigInt(b.value);
  const op = pool.interface.parseTransaction({ data: b.data, value });
  if (!op || !actions.has(op.name) || pool.interface.encodeFunctionData(op.fragment, op.args).toLowerCase() !== b.data.toLowerCase()) {
    throw new Error('Giao dịch không phải thao tác của ETH pool.');
  }
  const deposit = op.name === 'deposit' || op.name === 'depositBatch';
  const cross = op.name === 'withdrawAcross';
  if (cross) {
    const [proof, spend, order] = op.args;
    const gas = clearing.openingGas(vm, order);
    if (value !== gas.value || pool.interface.encodeFunctionData('withdrawAcross', [proof, spend, order, gas.packetGas]).toLowerCase() !== b.data.toLowerCase()) {
      throw new Error('Ngân sách gas thông điệp không đúng cấu hình lab.');
    }
  } else if (deposit ? value < MIN_DEPOSIT : value !== 0n) throw new Error('Giá trị giao dịch không hợp lệ.');
  if (op.name === 'cancelAcross' && !clearing.canCancel(vm, op.args[0])) throw new Error('Không có lệnh đã khóa trên mạng nguồn.');
  const key = deposit ? `${keccak256(b.data)}:${value}` : null;
  return vm.write(async () => {
    if (key && vm.deposits.has(key)) return vm.deposits.get(key);
    const payer = deposit ? vm.signer : vm.relay;
    const receipt = await (await payer.sendTransaction({ to: pool.target, data: b.data, value, ...opts })).wait();
    const result = { hash: receipt.hash, block: receipt.blockNumber, gas: receipt.gasUsed,
      ...(cross ? { id: clearing.recordLock(vm, receipt) } : {}) };
    if (key) vm.deposits.set(key, result);
    return result;
  });
}

// Browser-generated lab session tickets are for mock staking accounts ONLY. Note
// keys never appear here. No cookies (works in iframe previews), no external RPC.
const ticket = (req) => {
  const h = req.headers['x-lab-session'];
  return typeof h === 'string' && /^[0-9a-f]{64}$/.test(h) ? h : undefined;
};
async function readStaking(vm, session) {
  const { provider, staking, token } = vm;
  const { number: blockTag } = await provider.getBlock('latest');
  const address = session?.address;
  const [e, funded, claimed, pos, available] = await Promise.all([
    staking.epochState({ blockTag }), staking.fundedWei({ blockTag }), staking.claimedWei({ blockTag }),
    address ? staking.position(address, { blockTag }) : null, address ? token.balanceOf(address, { blockTag }) : 0n,
  ]);
  return { chainId: vm.config.chainId, block: blockTag, epoch: e.toObject(), funded, claimed, address, position: pos?.toObject(), available };
}

async function submitStaking(b, vm, session) {
  if (!session) throw new Error('Cần phiên staking thử.');
  return vm.write(async () => {
    const { staking, token, provider, signer } = vm;
    let actor = vm.sessions.get(session);
    const shape = Object.keys(b).sort().join(',');
    if (b.action === 'open') {
      if (shape !== 'action') throw new Error('Thao tác không hợp lệ.');
      if (!actor) {
        if (vm.sessions.size >= 64) throw new Error('Hết chỗ thử staking.');
        actor = Wallet.createRandom().connect(provider);
        await (await signer.sendTransaction({ to: actor.address, value: parseEther('0.1'), ...opts })).wait();
        await sent(token.mint, actor.address, parseEther('100'));
        vm.sessions.set(session, actor);
      }
      return readStaking(vm, actor);
    }
    if (!actor) throw new Error('Tạo ví staking thử trên mạng này trước.');
    const user = staking.connect(actor);
    let receipt;
    if (b.action === 'claim') {
      if (shape !== 'action,to' || typeof b.to !== 'string') throw new Error('Thao tác không hợp lệ.');
      const to = b.to.trim() ? payoutAddress(b.to, vm.pool.target, staking.target) : actor.address;
      receipt = await sent(user.claim, to);
    } else {
      if (shape !== 'action,amount' || !integer(b.amount)) throw new Error('Thao tác không hợp lệ.');
      const amount = BigInt(b.amount);
      if (amount === 0n || amount >= 1n << 128n) throw new Error('Số token ngoài giới hạn.');
      switch (b.action) {
        case 'stake':
          if (await token.balanceOf(actor.address) < amount) throw new Error('Không đủ LAB.');
          await sent(token.connect(actor).approve, staking.target, amount);
          receipt = await sent(user.stake, amount);
          break;
        case 'exit': receipt = await sent(user.requestUnstake, amount); break;
        case 'withdraw': receipt = await sent(user.withdrawStake, amount, actor.address); break;
        default: throw new Error('Thao tác staking không hợp lệ.');
      }
    }
    return { ...await readStaking(vm, actor), hash: receipt.hash };
  });
}

async function submit(req, res, vm, operation, routeId) {
  if (req.method !== 'POST') return response(res, { error: 'Cần POST.' }, 405);
  if (!req.headers['content-type']?.startsWith('application/json') || ['cross-site', 'same-site'].includes(req.headers['sec-fetch-site'])) {
    return response(res, { error: 'Yêu cầu không hợp lệ.' }, 415);
  }
  if (vm.pending >= 5) return response(res, { error: 'Devnet đang bận. Thử lại sau.' }, 429);
  ++vm.pending;
  try {
    const b = await body(req, operation === 'tx' ? 270_000 : 2048);
    if (operation === 'route') {
      if (Object.keys(b).join(',') !== 'action' || b.action !== 'advance') throw new Error('Chỉ được xử lý tiếp lệnh đã xác nhận.');
      return response(res, await clearing.advance(vm, routeId));
    }
    const result = operation === 'tx' ? await submitPool(b, vm) : await submitStaking(b, vm, ticket(req));
    response(res, result);
  } catch {
    response(res, { error: 'Giao dịch thử không được xác nhận. Kiểm tra số dư và trạng thái khoản giữ; giữ bản sao khóa note.' }, 409);
  } finally { --vm.pending; }
}

const timer = setInterval(() => {
  for (const vm of labs.values()) {
    if (vm.keeping) continue;
    vm.keeping = true;
    (async () => {
      await vm.write(() => vm.provider.send('evm_mine', []));
      await settleReady({ pool: vm.pool, read: vm.read, send: (name, a) => vm.write(async () => {
        const execute = vm.pool.connect(vm.keeper)[name];
        await execute.staticCall(...a, opts);
        return sent(execute, ...a);
      }) });
    })().catch(() => {}).finally(() => { vm.keeping = false; });
  }
}, 3000);
timer.unref();

const server = createServer(async (req, res) => {
  try {
    if (req.url === '/api/liquidity') {
      if (req.method !== 'GET') return response(res, { error: 'Chỉ đọc thanh khoản.' }, 405);
      return response(res, await liquidityBook());
    }
    const routeMatch = /^\/api\/(ethereum|arbitrum|base)\/route\/(0x[0-9a-f]{64})$/.exec(req.url);
    if (routeMatch) {
      const vm = labs.get(routeMatch[1]);
      const id = routeMatch[2];
      if (req.method === 'GET') return response(res, await clearing.route(vm, id));
      return await submit(req, res, vm, 'route', id);
    }
    const match = /^\/api\/(ethereum|arbitrum|base)\/(config|state|snapshot|tx|staking)$/.exec(req.url);
    if (match) {
      const vm = labs.get(match[1]);
      const operation = match[2];
      if (operation === 'tx' || req.method === 'POST' && operation === 'staking') return await submit(req, res, vm, operation);
      if (req.method !== 'GET') return response(res, { error: 'Chỉ đọc public state.' }, 405);
      if (operation === 'config') return response(res, vm.config);
      if (operation === 'staking') return response(res, await readStaking(vm, vm.sessions.get(ticket(req))));
      const snapshot = operation === 'snapshot';
      if (snapshot && await vm.pool.leafCount() > 16_384n) return response(res, { error: 'Vượt giới hạn tài nguyên của prover thử.' }, 503);
      return response(res, { pool: vm.pool.target, chainId: vm.config.chainId, ...await vm.read(snapshot) });
    }
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, headers).end(); return; }
    if (req.url === '/periodic.top' && cache) {
      res.writeHead(200, { ...headers, 'content-type': 'application/octet-stream', 'content-length': cache.length })
        .end(req.method === 'HEAD' ? undefined : cache);
      return;
    }
    const route = routes.get(req.url);
    if (!route) { res.writeHead(404, headers).end(); return; }
    const [path, type] = route;
    const data = await readFile(new URL(path, base));
    res.writeHead(200, { ...headers, 'content-type': type, 'content-length': data.length }).end(req.method === 'HEAD' ? undefined : data);
  } catch { if (!res.headersSent) response(res, { error: 'Không đọc được devnet.' }, 503); else res.end(); }
});
server.requestTimeout = 120_000;
server.listen(port, '0.0.0.0', () => {
  console.log(`ETH Pool + staking · six-route lab · port ${port} · no real funds`);
  for (const [name, vm] of labs) console.log(`${name}: ${vm.pool.target} · staking ${vm.staking.target}`);
  if (!wasm) console.log('Local prover unavailable; run build:pool:legacy:wasm, then restart the lab.');
});
