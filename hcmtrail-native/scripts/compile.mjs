import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import solc from 'solc';

const base = new URL('../', import.meta.url);
const tronCompilerHash = '82605d2d64d9bcc2ab0b7608d192463de009a8ece6032058d4cbdbefbde87e78';

export function compileSolidity(paths, { tvm = false, settings = {}, dependencies = [] } = {}) {
  const sources = paths.map((path) => [path, { content: readFileSync(new URL(path, base), 'utf8') }]);
  for (const path of dependencies) {
    sources.push([path, { content: readFileSync(new URL(`node_modules/${path}`, base), 'utf8') }]);
  }
  const input = JSON.stringify({ language: 'Solidity', sources: Object.fromEntries(sources),
    settings: { evmVersion: 'paris', optimizer: { enabled: true, runs: 200 },
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object', 'evm.deployedBytecode.immutableReferences'] } },
      ...settings } });
  let raw, compiler;
  if (tvm) {
    const bin = process.env.TRON_SOLC;
    if (!bin || createHash('sha256').update(readFileSync(bin)).digest('hex') !== tronCompilerHash) {
      throw new Error('Set TRON_SOLC to the pinned official TRON Solidity compiler (see README).');
    }
    compiler = execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 5_000 }).trim().split('\n').at(-1);
    raw = execFileSync(bin, ['--standard-json'], { input, encoding: 'utf8', timeout: 90_000, maxBuffer: 8 * 1024 * 1024 });
  } else {
    compiler = solc.version();
    raw = solc.compile(input);
  }
  const output = JSON.parse(raw);
  const errors = output.errors?.filter((message) => message.severity === 'error');
  if (errors?.length) throw new Error(errors.map(({ formattedMessage }) => formattedMessage).join('\n'));
  const artifact = (path, name) => {
    const { abi, evm } = output.contracts[path][name];
    return { compiler, abi, bytecode: `0x${evm.bytecode.object}`, runtimeTemplate: `0x${evm.deployedBytecode.object}`,
      immutableReferences: evm.deployedBytecode.immutableReferences ?? {} };
  };
  return { artifact };
}

export function compile({ tvm = false, fixtures = false } = {}) {
  const paths = ['contracts/ChainlinkPriceEpochs.sol', 'contracts/NativeAssets.sol'];
  if (fixtures) paths.push('test/fixtures/FeedFixture.sol');
  const { artifact } = compileSolidity(paths, { tvm });
  return {
    oracle: artifact(paths[0], 'ChainlinkPriceEpochs'),
    ...(fixtures ? { feed: artifact(paths[2], 'FeedFixture') } : {}),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length && args[0] !== '--tvm')) throw new Error('Usage: npm run build -- [--tvm]');
  const tvm = args[0] === '--tvm';
  const { oracle } = compile({ tvm });
  const dir = new URL(`build/${tvm ? 'tvm' : 'evm'}/`, base);
  mkdirSync(dir, { recursive: true });
  writeFileSync(new URL('ChainlinkPriceEpochs.json', dir), `${JSON.stringify(oracle, null, 2)}\n`);
  console.log(`Built ${tvm ? 'TVM' : 'EVM'} noncustodial oracle (${oracle.compiler}); no deployment.`);
}
