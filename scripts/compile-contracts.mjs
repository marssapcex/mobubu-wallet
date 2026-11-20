import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import solc from "solc";

const project = new URL("../", import.meta.url);
const contractsDir = new URL("contracts/", project);

export function readContractSources(dir) {
  return Object.fromEntries(readdirSync(dir, { recursive: true })
    .filter((file) => file.endsWith(".sol")).sort().map((file) => [
      `contracts/${file.replaceAll("\\", "/")}`, readFileSync(new URL(file.replaceAll("\\", "/"), dir), "utf8"),
    ]));
}

/** Compile only supplied sources with the pinned compiler; no RPC, downloads or deployment. */
export function compileSources(sources) {
  const compiled = JSON.parse(solc.compile(JSON.stringify({
    language: "Solidity", sources: Object.fromEntries(Object.entries(sources).map(([name, content]) => [name, { content }])),
    settings: {
      evmVersion: "paris", optimizer: { enabled: true, runs: 200 },
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] } },
    },
  })));
  const errors = (compiled.errors ?? []).filter(({ severity }) => severity === "error");
  if (errors.length) throw new Error(errors.map(({ formattedMessage }) => formattedMessage).join("\n"));
  return compiled.contracts;
}

export function compileContracts(extraSources = {}) {
  const active = readContractSources(contractsDir);
  for (const name of Object.keys(extraSources)) {
    if (Object.hasOwn(active, name)) throw new Error(`duplicate Solidity source: ${name}`);
  }
  return compileSources({ ...active, ...extraSources });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const contracts = compileContracts();
  mkdirSync(new URL("build/", project), { recursive: true });
  writeFileSync(new URL("build/contracts.json", project), JSON.stringify(contracts, null, 2) + "\n");
  console.log(`Compiled ${Object.keys(contracts).length} Solidity sources with ${solc.version()}`);
}
