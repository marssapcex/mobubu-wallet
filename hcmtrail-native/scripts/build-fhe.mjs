import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileSolidity } from './compile.mjs';

const quote = 'contracts/fhe/ZamaNativeQuotes.sol';
const fixture = 'test/fixtures/ZamaHostFixture.sol';
const zama = '@fhevm/solidity';

export function compileFhe({ fixtures = false } = {}) {
  const paths = [quote, 'contracts/ChainlinkPriceEpochs.sol', 'contracts/NativeAssets.sol'];
  if (fixtures) paths.push(fixture);
  // Explicit dependency closure; never read arbitrary import paths or mix these into the TVM build.
  const dependencies = ['config/ZamaConfig.sol', 'lib/FHE.sol', 'lib/Impl.sol', 'lib/FheType.sol',
    'lib/cryptography/FhevmECDSA.sol'].map((p) => `${zama}/${p}`);
  dependencies.push('encrypted-types/EncryptedTypes.sol');
  const { artifact } = compileSolidity(paths, { dependencies, settings: { evmVersion: 'cancun' } });
  return {
    quote: artifact(quote, 'ZamaNativeQuotes'),
    ...(fixtures ? { executor: artifact(fixture, 'FixtureExecutor'), acl: artifact(fixture, 'FixtureACL'),
      kms: artifact(fixture, 'FixtureKMS') } : {}),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { quote: artifact } = compileFhe();
  const dir = new URL('../build/evm/fhe/', import.meta.url);
  mkdirSync(dir, { recursive: true });
  writeFileSync(new URL('ZamaNativeQuotes.json', dir), `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(`Built ZamaNativeQuotes with @fhevm/solidity 0.13.4 (${artifact.compiler}); no deployment.`);
}
