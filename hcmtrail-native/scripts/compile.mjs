import { readFileSync } from 'node:fs';
import solc from 'solc';

const base = new URL('../', import.meta.url);

export function compileSolidity(paths, { settings = {} } = {}) {
  const sources = paths.map((path) => [path, { content: readFileSync(new URL(path, base), 'utf8') }]);
  const input = JSON.stringify({ language: 'Solidity', sources: Object.fromEntries(sources),
    settings: { evmVersion: 'paris', optimizer: { enabled: true, runs: 200 },
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object', 'evm.deployedBytecode.immutableReferences'] } },
      ...settings } });
  const output = JSON.parse(solc.compile(input));
  const errors = output.errors?.filter((message) => message.severity === 'error');
  if (errors?.length) throw new Error(errors.map(({ formattedMessage }) => formattedMessage).join('\n'));
  const artifact = (path, name) => {
    const { abi, evm } = output.contracts[path][name];
    return { compiler: solc.version(), abi, bytecode: `0x${evm.bytecode.object}`,
      runtimeTemplate: `0x${evm.deployedBytecode.object}`,
      immutableReferences: evm.deployedBytecode.immutableReferences ?? {} };
  };
  return { artifact };
}
