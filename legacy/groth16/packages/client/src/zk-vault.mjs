import { poseidon3 } from "poseidon-lite/poseidon3";
import { poseidon4 } from "poseidon-lite/poseidon4";
import { getAddress, ZeroAddress } from "ethers";
import { groth16 } from "snarkjs";
import { SCALAR_FIELD, TREE_DEPTH, SECRET_LIMIT, unsigned, nonzero, publicStatement, withdrawalWitness, sampleNoteSecret } from "./zk-format.mjs";
import { createVaultTree } from "./zk-tree.mjs";

export { SCALAR_FIELD, TREE_DEPTH };

function element(value, name) {
  return unsigned(value, SCALAR_FIELD, name);
}

export async function createVaultCrypto() {
  function derive(note) {
    if (note?.version !== 2) throw new TypeError("unsupported note version");
    const domain = element(note.domain, "domain");
    const nullifier = nonzero(note.nullifier, SECRET_LIMIT, "nullifier");
    const secret = nonzero(note.secret, SECRET_LIMIT, "secret");
    return { domain, nullifier, secret, commitment: poseidon4([1n, domain, nullifier, secret]), nullifierHash: poseidon3([2n, domain, nullifier]) };
  }

  return Object.freeze({
    createTree: createVaultTree,
    /** A note is a bearer secret. Store it before sending the deposit; never log it. */
    newNote(domain) {
      return Object.freeze({
        version: 2,
        domain: element(domain, "domain").toString(),
        nullifier: sampleNoteSecret().toString(),
        secret: sampleNoteSecret().toString(),
      });
    },
    commitment: (note) => derive(note).commitment,
    withdrawalInput(note, tree, leafIndex, recipient) {
      const { domain, nullifier, secret, commitment, nullifierHash } = derive(note);
      const address = getAddress(recipient);
      if (address === ZeroAddress) throw new RangeError("recipient must be nonzero");
      const { leaf, root, pathElements, pathIndices } = tree.path(leafIndex);
      if (leaf !== commitment || commitment === 0n || nullifierHash === 0n) throw new Error("note does not match deposit leaf");
      return {
        root: root.toString(), nullifierHash: nullifierHash.toString(), recipient: BigInt(address).toString(),
        domain: domain.toString(), nullifier: nullifier.toString(), secret: secret.toString(), pathElements, pathIndices,
      };
    },
  });
}

/** `artifacts` must come from the exact reviewed circuit and ceremony. No network calls. */
export async function proveWithdrawal(input, artifacts) {
  const witness = withdrawalWitness(input);
  const expected = publicStatement(witness).map(String);
  const { wasm, zkey } = artifacts;
  // In-memory witness; untrusted artifacts must never be allowed to process notes.
  const { proof, publicSignals } = await groth16.fullProve(witness, wasm, zkey, undefined, undefined, { singleThread: true });
  if (publicSignals.length !== expected.length || publicSignals.some((x, i) => x !== expected[i])) {
    throw new Error("prover output does not match the expected public statement");
  }
  const [a, b, c] = JSON.parse(`[${await groth16.exportSolidityCallData(proof, publicSignals)}]`);
  // Native vault argument order; contains no commitment or private witness data.
  return { proof, publicSignals, calldata: [getAddress(`0x${BigInt(expected[2]).toString(16).padStart(40, "0")}`), expected[0], expected[1], a, b, c] };
}
