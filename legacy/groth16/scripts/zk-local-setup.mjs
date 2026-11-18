import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));

const marker = "Disposable single-machine keys. DO NOT deploy or fund any vault using them.\n";

function profiles(profile) {
  if (profile === "fixed") return "withdraw";
  if (profile === "notes") return "spendNote";
  throw new Error("ZK setup profile must be 'fixed' or 'notes'");
}

function artifacts(dir, circuit) {
  return {
    wasm: join(dir, `${circuit}_js`, `${circuit}.wasm`),
    zkey: join(dir, `${circuit}.local.zkey`),
    vkey: join(dir, "verification_key.json"),
    verifier: join(dir, "Groth16Verifier.sol"),
    r1cs: join(dir, `${circuit}.r1cs`),
  };
}

function readLocal(file, limit) {
  const metadata = lstatSync(file);
  if (!metadata.isFile() || metadata.size < 1 || metadata.size > limit) throw new Error(`invalid local artifact: ${file}`);
  return readFileSync(file);
}

function hashes(files) {
  return Object.fromEntries(Object.entries(files).map(([name, path]) => [
    name, createHash("sha256").update(readLocal(path, 32 * 1024 * 1024)).digest("hex"),
  ]));
}

/** Detect incomplete/corrupt local caches. This manifest is not a trust anchor. */
export function verifyLocalZkCache(dir, profile = "fixed") {
  const files = artifacts(dir, profiles(profile));
  try {
    if (!lstatSync(dir).isDirectory() || readLocal(join(dir, "LOCAL_ONLY.txt"), 256).toString() !== marker) {
      throw new Error("missing local-only marker");
    }
    const manifest = JSON.parse(readLocal(join(dir, "hashes.json"), 4096));
    for (const [name, hash] of Object.entries(hashes(files))) {
      if (manifest[name] !== hash) throw new Error(`checksum mismatch for ${name}`);
    }
    return files;
  } catch (error) {
    throw new Error(`Corrupt disposable ZK cache at ${dir}; remove that cache directory and rerun setup`, { cause: error });
  }
}

function run(bin, args) {
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    timeout: 240_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    // Do not echo argv: local ceremony entropy was a CLI argument.
    throw new Error(`local ZK build command failed:\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

/** Build or load disposable LOCAL-TEST keys. This is not a public ceremony. */
export function setupLocalZk(profile = "fixed") {
  const circuit = profiles(profile);
  const entry = `circuits/${circuit}.circom`;
  const hash = createHash("sha256");
  for (const file of [entry, "circuits/merkleTree.circom", "package-lock.json", "scripts/zk-local-setup.mjs"]) {
    hash.update(file).update(readFileSync(join(root, file)));
  }
  const parent = join(root, "build", "zk", "local-only");
  const dir = join(parent, hash.digest("hex"));
  if (existsSync(dir)) return verifyLocalZkCache(dir, profile);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const work = mkdtempSync(join(parent, "tmp-"));
  const f = artifacts(work, circuit);
  const snark = require.resolve("snarkjs", { paths: [root] });
  const cli = join(snark, "..", "cli.cjs");
  const ptau0 = join(work, "pot0.ptau");
  const ptau1 = join(work, "pot1.ptau");
  const ptau2 = join(work, "pot2.ptau");
  const zkey0 = join(work, `${circuit}.0.zkey`);
  const ceremonyEntropy = () => `--entropy=${randomBytes(32).toString("hex")}`;
  try {
    const output = run(require.resolve("circom2/cli.js"), [
      entry, "-l", "node_modules", "--r1cs", "--wasm", "--O2", "--inspect", "-o", work,
    ]);
    console.log(output.trim());
    console.log(`Generating Groth16 artifacts for ${profile}, local testing only (BN254, power 13)…`);
    run(cli, ["powersoftau", "new", "bn128", "13", ptau0]);
    run(cli, ["powersoftau", "contribute", ptau0, ptau1, "--name=LOCAL_ONLY", ceremonyEntropy()]);
    run(cli, ["powersoftau", "prepare", "phase2", ptau1, ptau2]);
    run(cli, ["groth16", "setup", f.r1cs, ptau2, zkey0]);
    run(cli, ["zkey", "contribute", zkey0, f.zkey, "--name=LOCAL_ONLY", ceremonyEntropy()]);
    run(cli, ["zkey", "export", "verificationkey", f.zkey, f.vkey]);
    run(cli, ["zkey", "export", "solidityverifier", f.zkey, f.verifier]);
    writeFileSync(join(work, "LOCAL_ONLY.txt"), marker);
    writeFileSync(join(work, "hashes.json"), JSON.stringify(hashes(f), null, 2) + "\n");
    for (const file of [ptau0, ptau1, ptau2, zkey0]) rmSync(file);
    try {
      renameSync(work, dir);
    } catch (error) {
      if (!["EEXIST", "ENOTEMPTY"].includes(error.code)) throw error;
    }
    return verifyLocalZkCache(dir, profile);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log("Local-only artifacts:", setupLocalZk(process.argv[2]));
}
