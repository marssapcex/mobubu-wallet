import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { Transaction, address, networks, payments, script, crypto } from 'bitcoinjs-lib';
import * as secp from 'tiny-secp256k1';
import { connectRpc } from '../../packages/swap/src/rpc.mjs';

const key = new Uint8Array(32).fill(29); // Public test-only miner key, never funded outside this regtest.
const pub = secp.pointFromScalar(key, true);
const { address: miner } = payments.p2wpkh({ pubkey: pub, network: networks.regtest });

async function freePort() {
  const s = createServer();
  s.listen(0, '127.0.0.1');
  await once(s, 'listening');
  const port = s.address().port;
  await new Promise((resolve) => s.close(resolve));
  return port;
}
export async function openRegtest(bitcoind) {
  if (!bitcoind || !existsSync(bitcoind)) throw new Error('BITCOIND must point to an installed Bitcoin Core daemon');
  const dir = mkdtempSync(join(tmpdir(), 'mobubu-btc-regtest-'));
  const port = await freePort();
  const cookieFile = join(dir, 'regtest', '.cookie');
  const child = spawn(bitcoind, ['-regtest', '-server', '-txindex', '-listen=0', '-connect=0', '-dnsseed=0',
    `-rpcport=${port}`, '-rpcbind=127.0.0.1', '-rpcallowip=127.0.0.1', `-datadir=${dir}`, '-printtoconsole'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '', spawnError;
  for (const pipe of [child.stdout, child.stderr]) pipe.on('data', (data) => { logs = (logs + data.toString()).slice(-2_000); });
  child.on('error', (e) => { spawnError = e; });
  const ended = new Promise((resolve) => child.once('close', resolve));
  const rpc = connectRpc(`http://127.0.0.1:${port}/`, { cookieFile, timeout: 5_000 });
  async function close() {
    if (child.exitCode === null && child.signalCode === null && !spawnError) {
      child.kill('SIGTERM');
      const killer = setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
      await ended;
      clearTimeout(killer);
    }
    rmSync(dir, { recursive: true, force: true });
  }
  try {
    for (let i = 0; i < 100; ++i) {
      if (spawnError || child.exitCode !== null) throw new Error(`isolated Core failed to start: ${spawnError?.message ?? logs}`);
      if (existsSync(cookieFile)) {
        try {
          const info = await rpc('getblockchaininfo');
          if (info.chain !== 'regtest') throw new Error('test requires a fresh regtest');
          break;
        } catch (e) { if (i === 99) throw e; }
      }
      if (i === 99) throw new Error(`regtest RPC did not start: ${logs}`);
      await wait(50);
    }
    const mine = (n = 1) => rpc('generatetoaddress', [n, miner]);
    const mature = await mine(122);
    const p2pkh = payments.p2pkh({ hash: crypto.hash160(pub), network: networks.regtest }).output;
    let coinbase = 0;
    async function fund(to, value) {
      const block = await rpc('getblock', [mature[coinbase++], 1]);
      const txid = block.tx[0];
      const old = Transaction.fromHex(await rpc('getrawtransaction', [txid, false, block.hash]));
      const tx = new Transaction();
      tx.version = 2;
      tx.addInput(Buffer.from(txid, 'hex').reverse(), 0, 0xffff_ffff);
      tx.addOutput(address.toOutputScript(to, networks.regtest), value);
      tx.addOutput(address.toOutputScript(miner, networks.regtest), old.outs[0].value - value - 2_000n);
      const d = tx.hashForWitnessV0(0, p2pkh, old.outs[0].value, Transaction.SIGHASH_ALL);
      tx.setWitness(0, [script.signature.encode(secp.sign(d, key), Transaction.SIGHASH_ALL), pub]);
      const raw = tx.toHex(), broadcast = await rpc('sendrawtransaction', [raw]);
      if (broadcast !== tx.getId()) throw new Error('wrong funding txid');
      return { txid: broadcast, index: 0 };
    }
    return { rpc, mine, fund, close };
  } catch (e) { await close(); throw e; }
}
