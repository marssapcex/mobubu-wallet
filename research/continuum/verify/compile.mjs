// Compiles src/Continuum.sol and test/Continuum.t.sol with solc 0.8.24 and
// emits verify/artifacts.json for the execution harness.
// Run: node verify/compile.mjs
import solc from "solc";
import fs from "fs";
import path from "path";

const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, "..");

// every Solidity file under src/ and test/, so new modules cannot be left
// out of the build by an out-of-date list
import {readdirSync, statSync} from "node:fs";
function walk(dir, acc = []) {
  for (const e of readdirSync(path.join(root, dir))) {
    const rel = path.join(dir, e);
    const st = statSync(path.join(root, rel));
    if (st.isDirectory()) walk(rel, acc);
    else if (e.endsWith(".sol")) acc.push(rel);
  }
  return acc;
}
const targets = [...walk("src"), ...walk("test")].sort();
const sources = {};
for (const t of targets) sources[t] = { content: fs.readFileSync(path.join(root, t), "utf8") };

const candidates = [
  (p) => path.join(here, "lib/forge-std/src", p.replace(/^forge-std\//, "")),
  (p) => path.join(here, "node_modules", p),
  (p) => path.join(root, p),
];

function findImports(importPath) {
  for (const c of candidates) {
    const p = c(importPath);
    if (fs.existsSync(p) && fs.statSync(p).isFile()) return { contents: fs.readFileSync(p, "utf8") };
  }
  return { error: "not found: " + importPath };
}

const input = {
  language: "Solidity",
  sources,
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] } },
  },
};

const out = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
let fatal = false;
for (const e of out.errors ?? []) {
  const tag = e.severity === "error" ? "ERROR" : "warn ";
  if (e.severity === "error") fatal = true;
  console.log(`[${tag}] ${process.env.SOLC_FULL ? e.formattedMessage : e.formattedMessage.split("\n")[0]}`);
}
if (fatal) process.exit(1);

const artifacts = {};
for (const file of Object.keys(out.contracts ?? {})) {
  for (const [name, c] of Object.entries(out.contracts[file])) {
    artifacts[name] = { abi: c.abi, bytecode: "0x" + c.evm.bytecode.object };
    const sz = c.evm.deployedBytecode.object.length / 2;
    console.log(`compiled ${name.padEnd(24)} deployed bytes: ${sz}`);
  }
}
fs.writeFileSync(path.join(here, "artifacts.json"), JSON.stringify(artifacts, null, 2));
console.log("solc", solc.version(), "-> verify/artifacts.json");
