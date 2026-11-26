import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { parseEther } from 'ethers';
import { deployEthPool } from '../pool/local.mjs';
import { ETH, directLeg, parseProver, prepareProof, quoteFee, validateProof } from '../pool/protocol.mjs';
import { readPool } from '../pool/view.mjs';
import * as codec from '../testnet/notes.mjs';
import { LOCAL_ID } from './local-evm.mjs';

// Runs the production proof worker (apps/eth-pool/proof-worker.mjs) inside a real
// Chromium, then verifies the browser-produced STARK on the deployed Solidity
// verifier. This is the only test that exercises the Web Worker path the browser
// bundle actually ships; the Node suites call proveInWasm directly.
//
// Opt in: PROVER_BROWSER=1 CHROMIUM_LIBS=<dir with libnss3.so> \
//   npm i --no-save playwright-core @sparticuz/chromium
const enabled = process.env.PROVER_BROWSER === '1';

const MIME = { '.mjs': 'text/javascript', '.js': 'text/javascript', '.json': 'application/json',
  '.wasm': 'application/wasm', '.html': 'text/html', '.top': 'application/octet-stream' };

// The worker imports '/hcmtrail-native/pool/wasm.mjs' and fetches './prover.wasm'
// next to itself, so serve the repo root and alias the build artifact.
const ALIASES = new Map([['/apps/eth-pool/prover.wasm', 'hcmtrail-native/build/eth-pool/prover.wasm'],
  ['/apps/eth-pool/periodic.top', 'hcmtrail-native/build/eth-pool/periodic.top']]);

async function serve(root) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      const path = ALIASES.get(url.pathname) ?? decodeURIComponent(url.pathname).replace(/^\/+/, '');
      const body = await readFile(new URL(`file://${root}/${path}`));
      const ext = path.slice(path.lastIndexOf('.'));
      res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream', 'content-length': body.length });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, port: server.address().port };
}

const revivePlan = `(v) => Array.isArray(v) ? v.map(revive) : v && typeof v === 'object'
  ? (typeof v.$bi === 'string' ? BigInt(v.$bi) : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, revive(x)])))
  : v;`;

test('browser worker: Chromium produces the STARK and the Solidity verifier pays out', {
  timeout: 1_800_000,
  skip: enabled ? false : 'set PROVER_BROWSER=1 (needs playwright-core + @sparticuz/chromium)',
}, async (t) => {
  // Repo root: the worker imports '/hcmtrail-native/pool/wasm.mjs'.
  const root = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
  const { chromium: pw } = await import('playwright-core');
  const { default: chromium } = await import('@sparticuz/chromium');
  if (process.env.CHROMIUM_LIBS) {
    process.env.LD_LIBRARY_PATH = `${process.env.CHROMIUM_LIBS}:${process.env.LD_LIBRARY_PATH ?? ''}`;
  }

  const { server, port } = await serve(root);
  const browser = await pw.launch({ executablePath: await chromium.executablePath(), args: chromium.args, headless: true });
  t.after(async () => { await browser.close(); server.close(); });

  const vm = await deployEthPool({ chainId: LOCAL_ID });
  t.after(vm.close);
  const { pool, provider, staking } = vm;
  const user = await provider.getSigner(1);

  const gross = parseEther('1') + 17n;
  const deposit = quoteFee(gross);
  const note = codec.openNote(ETH, deposit.net);
  await (await pool.deposit(note.ownerCommit, { value: gross })).wait();
  assert.equal(await pool.shieldedNative(), deposit.net);

  const state = await readPool(pool, provider, vm.fromBlock, { snapshot: true });
  assert.equal(codec.rebuildRoot(state.leaves), state.root);
  const recipient = '0x000000000000000000000000000000000000ec21';
  const plan = prepareProof(codec, state, { note, index: state.leaves.indexOf(note.leaf) },
    directLeg(recipient, note.value, staking.target));

  // Serialise without losing 64-bit precision, run the production worker in Chromium.
  const wire = JSON.stringify(plan, (_, v) => (typeof v === 'bigint' ? { $bi: v.toString() } : v));
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/apps/eth-pool/proof-worker.mjs`, { waitUntil: 'commit' }).catch(() => {});
  const started = Date.now();
  const out = await page.evaluate(async ({ wire, reviveSrc }) => {
    const revive = eval(reviveSrc);
    const plan = revive(JSON.parse(wire));
    return await new Promise((resolve) => {
      const worker = new Worker('/apps/eth-pool/proof-worker.mjs', { type: 'module' });
      const phases = new Set();
      worker.onmessage = ({ data }) => {
        if (data.phase) phases.add(data.phase);
        if (data.result) { worker.terminate(); resolve({ ...data.result, phases: [...phases] }); }
        if (data.error) { worker.terminate(); resolve({ error: data.error, phases: [...phases] }); }
      };
      worker.postMessage({ plan, useCache: false });
    });
  }, { wire, reviveSrc: revivePlan });
  const seconds = (Date.now() - started) / 1000;
  assert.equal(out.error, undefined, `worker: ${out.error}`);
  assert.ok(out.proof.startsWith('0x') && out.proof.length > 2_000, 'worker returned no proof');

  // The bytes the browser produced must satisfy the on-chain verifier.
  const spend = validateProof(codec, plan, out.proof, parseProver(out.publicAndChange));
  assert.equal(spend.change.length, 0);
  const before = await provider.getBalance(recipient);
  const receipt = await (await pool.connect(user).withdraw(spend.proof, spend.spend, recipient, note.value)).wait();
  const expected = quoteFee(note.value);
  assert.equal((await provider.getBalance(recipient)) - before, expected.net);
  assert.equal(await pool.shieldedNative(), 0n);
  assert.equal(await staking.fundedWei(), deposit.fee + expected.fee);
  t.diagnostic(`${(out.proof.length - 2) / 2} proof bytes from Chromium in ${seconds.toFixed(1)} s `
    + `(phases ${out.phases.length}); withdrawal ${receipt.gasUsed} gas; paid ${expected.net}`);
});
