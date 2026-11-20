import { SCALAR_FIELD, publicStatement, unsigned } from "./zk-format.mjs";

const BASE_FIELD = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;

function exactArray(value, len, field) {
  if (!Array.isArray(value) || value.length !== len) throw new TypeError(`invalid ${field} shape`);
  return value;
}

function words(values, modulus) {
  return Buffer.from(values.map((x) => unsigned(x, modulus, "field element").toString(16).padStart(64, "0")).join(""), "hex");
}

function g1(point) {
  const [x, y, z] = exactArray(point, 3, "G1");
  if (unsigned(z, BASE_FIELD, "G1 z") !== 1n) throw new TypeError("expected affine G1");
  return [x, y];
}

function g2(point) {
  const [x, y, z] = exactArray(point, 3, "G2");
  const [real, imaginary] = exactArray(z, 2, "Fq2");
  if (unsigned(real, BASE_FIELD, "G2 z.real") !== 1n || unsigned(imaginary, BASE_FIELD, "G2 z.imag") !== 0n) throw new TypeError("expected affine G2");
  return [...exactArray(x, 2, "Fq2"), ...exactArray(y, 2, "Fq2")];
}

function groth16Bn254(object) {
  if (object?.protocol !== "groth16" || object?.curve !== "bn128") throw new TypeError("expected snarkjs Groth16/BN254");
}

/** Fixed-width encoding consumed by the independent Rust verifier. Not Solidity calldata. */
export function encodeVerificationKey(vk) {
  groth16Bn254(vk);
  if (vk.nPublic !== 4) throw new TypeError("unexpected public input arity");
  const ic = exactArray(vk.IC, 5, "IC");
  return words([g1(vk.vk_alpha_1), g2(vk.vk_beta_2), g2(vk.vk_gamma_2), g2(vk.vk_delta_2), ...ic.map(g1)].flat(), BASE_FIELD);
}

export function encodeProof(proof) {
  groth16Bn254(proof);
  return words([g1(proof.pi_a), g2(proof.pi_b), g1(proof.pi_c)].flat(), BASE_FIELD);
}

/** Construct this from the expected vault statement, not from an untrusted proof packet. */
export function encodeStatement(statement) {
  return words(publicStatement(statement), SCALAR_FIELD);
}
