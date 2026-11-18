import { poseidon2 } from "poseidon-lite/poseidon2";
import { poseidon4 } from "poseidon-lite/poseidon4";
import { groth16 } from "snarkjs";
import {
  SCALAR_FIELD, SECRET_LIMIT, merkleWitnessPath, nonzero, sampleNoteSecret, unsigned,
} from "./zk-format.mjs";

export const AMOUNT_LIMIT = 1n << 128n;
export const valueAmount = (value, name = "amount") => nonzero(value, AMOUNT_LIMIT, name);

/** A bearer secret. Save the note locally before deposit (or before spending its parent). */
export function newValueNote(domain, amount) {
  return Object.freeze({
    version: 3,
    domain: unsigned(domain, SCALAR_FIELD, "domain").toString(),
    amount: valueAmount(amount).toString(),
    nullifier: sampleNoteSecret().toString(),
    secret: sampleNoteSecret().toString(),
  });
}

function secrets(note) {
  if (note?.version !== 3) throw new TypeError("expected a v3 value note");
  const domain = unsigned(note.domain, SCALAR_FIELD, "domain");
  const nullifier = nonzero(note.nullifier, SECRET_LIMIT, "nullifier");
  const secret = nonzero(note.secret, SECRET_LIMIT, "secret");
  return { domain, nullifier, secret };
}

/** A deposit sends this key and actual funds, never an unchecked amount/leaf claim. */
export function valueNoteKey(note) {
  const { domain, nullifier, secret } = secrets(note);
  return nonzero(poseidon4([3n, domain, nullifier, secret]), SCALAR_FIELD, "note key");
}

export function valueNoteLeaf(noteKey, receivedAmount) {
  const key = nonzero(noteKey, SCALAR_FIELD, "note key");
  return nonzero(poseidon2([key, valueAmount(receivedAmount)]), SCALAR_FIELD, "note commitment");
}

/** Public order is exactly spendNote.circom / the six-input Solidity verifier. */
export function valueStatement({ root, nullifierHash, payoutBinding, amount, changeCommitment, domain }) {
  return [
    nonzero(root, SCALAR_FIELD, "root"),
    nonzero(nullifierHash, SCALAR_FIELD, "nullifierHash"),
    nonzero(payoutBinding, SECRET_LIMIT, "payout binding"),
    valueAmount(amount),
    unsigned(changeCommitment, SCALAR_FIELD, "change commitment"),
    unsigned(domain, SCALAR_FIELD, "domain"),
  ];
}

function normalizeWitness(input) {
  const [root, nullifierHash, payoutBinding, amount, changeCommitment, domain] = valueStatement(input).map(String);
  const noteValue = valueAmount(input.noteValue, "note value");
  if (BigInt(amount) > noteValue) throw new RangeError("spend exceeds note value");
  return {
    root, nullifierHash, payoutBinding, amount, changeCommitment, domain,
    noteValue: noteValue.toString(),
    nullifier: nonzero(input.nullifier, SECRET_LIMIT, "nullifier").toString(),
    secret: nonzero(input.secret, SECRET_LIMIT, "secret").toString(),
    changeNullifier: unsigned(input.changeNullifier, SECRET_LIMIT, "change nullifier").toString(),
    changeSecret: unsigned(input.changeSecret, SECRET_LIMIT, "change secret").toString(),
    ...merkleWitnessPath(input),
  };
}

/** Prepare a witness from a canonical path. payoutBinding is the recipient (EVM)
 * or the independently derived hash of a mock quote and destination. */
export function prepareNoteSpend(note, path, amount, payoutBinding) {
  const { domain, nullifier, secret } = secrets(note);
  const noteValue = valueAmount(note.amount, "note value");
  const debit = valueAmount(amount);
  if (debit > noteValue) throw new RangeError("spend exceeds note value");
  const leaf = valueNoteLeaf(valueNoteKey(note), noteValue);
  if (leaf !== unsigned(path.leaf, SCALAR_FIELD, "leaf")) throw new Error("note value/key does not match the credited leaf");
  const change = debit === noteValue ? null : newValueNote(domain, noteValue - debit);
  const input = normalizeWitness({
    ...path,
    domain, nullifier, secret, noteValue, amount: debit, payoutBinding,
    nullifierHash: poseidon4([4n, domain, nullifier, leaf]),
    changeCommitment: change ? valueNoteLeaf(valueNoteKey(change), change.amount) : 0n,
    changeNullifier: change?.nullifier ?? 0n,
    changeSecret: change?.secret ?? 0n,
  });
  return { input, change };
}

/** Use trusted, matching v3 artifacts. The return value contains no witness. */
export async function proveNoteSpend(input, artifacts) {
  const witness = normalizeWitness(input);
  const expected = valueStatement(witness).map(String);
  const { wasm, zkey } = artifacts;
  const { proof, publicSignals } = await groth16.fullProve(witness, wasm, zkey, undefined, undefined, { singleThread: true });
  if (publicSignals.length !== expected.length || publicSignals.some((value, i) => value !== expected[i])) {
    throw new Error("prover output does not match expected v3 statement");
  }
  const [a, b, c] = JSON.parse(`[${await groth16.exportSolidityCallData(proof, publicSignals)}]`);
  return { proof, publicSignals, solidity: [a, b, c] };
}
