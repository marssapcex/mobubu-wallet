import { constants, closeSync, copyFileSync, fstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { slh_dsa_sha2_128s as slh } from '@noble/post-quantum/slh-dsa.js';
import { getBytes, hexlify } from 'ethers';
import * as secp from 'tiny-secp256k1';
import { createVaultKey } from '../packages/client/src/index.mjs';
import { connectRpc, makePolicy, bitcoinScript, makeBitcoinRail, makeBitcoinCosigner, makeEvmRail,
  openJournal, openSignerJournal, makeSettlement, makeQuoteDesk, encryptQuoteRequest, openQuoteAndSign, newNonce } from '../packages/swap/src/index.mjs';
import { encode, hex } from '../packages/swap/src/protocol.mjs';

function read(path, max, privateFile = false) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > max || (privateFile && (info.mode & 0o077))) throw new Error('invalid input file or permissions');
    const data = readFileSync(fd, 'utf8');
    if (data.length > max) throw new Error('input file exceeded target size');
    return data;
  } finally { closeSync(fd); }
}
const json = (path) => JSON.parse(read(path, 1024 * 1024));
const secret = (path, size) => getBytes(hex(read(path, 256, true).trim(), size, 'secret file'));
const emit = (obj) => console.log(encode(obj));

async function run([cmd, file, ...args]) {
  if (!cmd || !file) {
    console.error(`swapctl <command> <config.json> [...]\n  treasury-address\n  client-order <exchange-directory>\n  quote-eval <request.json> <approved-cloud.key>\n  reserve <BTC txid> <vout>\n  register <signed-order.json>\n  attach <order-id> <txid> <vout-or-log-index>\n  tick <order-id> [partials.json]\n  active | status <order-id>\n  approval <order-id>\n  cosign <request.json>\n  keygen-pq <new-key-file> | keygen-btc <new-key-file>`);
    process.exitCode = 2;
    return;
  }
  if (cmd === 'keygen-pq' || cmd === 'keygen-btc') {
    let secretKey, publicKey;
    if (cmd === 'keygen-pq') ({ secretKey, publicKey } = createVaultKey());
    else {
      do { secretKey = randomBytes(32); } while (!secp.isPrivate(secretKey));
      publicKey = hexlify(secp.pointFromScalar(secretKey, true));
    }
    writeFileSync(file, hexlify(secretKey) + '\n', { flag: 'wx', mode: 0o600 });
    secretKey.fill(0);
    emit({ publicKey });
    return;
  }
  const config = json(file);
  const policy = makePolicy(config.policy);
  if (cmd === 'treasury-address') { emit({ deployment: policy.id, bitcoin: bitcoinScript(policy).address }); return; }
  if (cmd === 'quote-eval') {
    const { makeTfhe } = await import('../fhe-swap/dist/src/fhe/tfhe.js');
    const desk = makeQuoteDesk({ policy, rates: config.rates, secret: secret(config.quoterKeyFile, 64),
      fundSeconds: config.fundSeconds, paySeconds: config.paySeconds });
    const { crypto } = await makeTfhe({ role: 'evaluator', cloudKeyPath: args[1], workerPath: process.env.TFHE_WORKER });
    try { emit(await desk.evaluate(json(args[0]), crypto)); } finally { crypto.close(); }
    return;
  }
  if (cmd === 'client-order') {
    if (!process.stdin.isTTY) throw new Error('client-order requires a terminal for the quote exchange');
    const exchange = args[0];
    mkdirSync(exchange, { mode: 0o700 });
    const userSecret = secret(config.userKeyFile, 64);
    const { makeTfhe } = await import('../fhe-swap/dist/src/fhe/tfhe.js');
    const { crypto } = await makeTfhe({ role: 'client', workerPath: process.env.TFHE_WORKER });
    const prompt = createInterface({ input: process.stdin, output: process.stderr });
    try {
      const { from, to, amountIn, minOut, payer, recipient, refund } = config.trade;
      const request = await encryptQuoteRequest({ policy, client: crypto, route: { from, to,
        key: hexlify(slh.getPublicKey(userSecret)), nonce: newNonce() }, amountIn, minOut });
      writeFileSync(join(exchange, 'request.json'), encode(request) + '\n', { flag: 'wx', mode: 0o600 });
      copyFileSync(crypto.getCloudPath(), join(exchange, 'cloud.key'), constants.COPYFILE_EXCL);
      await prompt.question('Send request.json and cloud.key to the quote desk. Place reply.json in the exchange dir and press Enter. ');
      const order = await openQuoteAndSign({ policy, client: crypto, request, packet: json(join(exchange, 'reply.json')),
        userSecret, payer, recipient, refund });
      writeFileSync(join(exchange, 'order.json'), encode(order) + '\n', { flag: 'wx', mode: 0o600 });
      emit({ order: join(exchange, 'order.json'), from, to, amountIn, recipient, amountOut: order.amountOut, refund });
    } finally { userSecret.fill(0); prompt.close(); crypto.close(); }
    return;
  }
  const writes = ['tick', 'cosign', 'reserve', 'register', 'attach'].includes(cmd);
  if (writes && (policy.rails.BTC.network === 'bitcoin' || policy.rails.ETH.chainId === 1n || policy.rails.BNB.chainId === 56n) &&
      process.env.MOBUBU_ENABLE_MAINNET !== 'I_UNDERSTAND_CUSTODY_RISK') throw new Error('mainnet disabled; use regtest/testnet operation');
  const rpc = Object.fromEntries(['BTC','ETH','BNB'].map((name) => {
    const { url, cookieFile } = config.rpc[name];
    return [name, connectRpc(url, { cookieFile })];
  }));
  const rails = { BTC: makeBitcoinRail({ policy, rpc: rpc.BTC }) };
  // The cosigner command never loads EVM issuer/gas secrets or the coordinator DB.
  for (const chain of ['ETH','BNB']) {
    const s = cmd === 'tick' ? config.evmSigners?.[chain] : null;
    rails[chain] = makeEvmRail({ policy, chain, rpc: rpc[chain], ...(s && {
      gasKey: hexlify(secret(s.gasKeyFile, 32)), treasurySecret: secret(s.treasuryKeyFile, 64), maxGasPrice: s.maxGasPrice,
    }) });
  }
  if (cmd === 'cosign') {
    const key = secret(config.cosigner.keyFile, 32);
    const log = openSignerJournal(config.cosigner.journal, policy.id, hexlify(secp.pointFromScalar(key, true)));
    try { emit(await makeBitcoinCosigner({ policy, rails, journal: log, secret: key }).approve(json(args[0]))); }
    finally { key.fill(0); log.close(); }
    return;
  }
  const db = openJournal(config.journal, policy.id);
  try {
    const engine = makeSettlement({ policy, rails, journal: db });
    const [id, txid, index] = args;
    switch (cmd) {
      case 'reserve': emit(await engine.addBitcoinReserve({ txid: id, index: txid })); break;
      case 'register': emit(engine.register(json(id))); break;
      case 'attach': emit(await engine.attach(id, { txid, index })); break;
      case 'tick': emit(await engine.advance(id, txid ? { partials: json(txid) } : undefined)); break;
      case 'active': emit(engine.active()); break;
      case 'status': {
        const state = engine.status(id);
        emit({ id, from: state.from, to: state.to, phase: state.phase, funding: state.funding,
          action: state.plan?.kind, txid: state.payload?.txid, priorTxid: state.prior?.payload.txid, reason: state.reason });
        break;
      }
      case 'approval': emit(engine.approvalRequest(id)); break;
      default: throw new Error('unknown swapctl command');
    }
  } finally { db.close(); }
}

// RPC/wallet implementation exceptions can carry transaction data or key inputs.
// Only expose sanitized operator errors; no stack, URL credentials or parameters.
run(process.argv.slice(2)).catch((error) => {
  const message = String(error?.message ?? 'failed');
  console.error(/^[^\n]{1,160}$/.test(message) && !/\b[0-9a-f]{64,}\b|https?:\/\//i.test(message)
    ? message : 'swap command failed; inspect the configured node or journal');
  process.exitCode = 1;
});
